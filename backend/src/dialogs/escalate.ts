import { setTimeout as sleep } from 'node:timers/promises';
import type { AppDeps } from '../app.ts';
import { CoreHttpError } from '../core/client.ts';
import type { ParticipantToken, TranscriptMessage } from '../core/types.ts';
import { casDialogStatus, setDialogStatus, type DialogRow } from '../db/repositories/dialogs.ts';
import { listThreadTail } from '../db/repositories/messages.ts';
import type { WidgetRow } from '../db/repositories/widgets.ts';
import { ApiError, mapCoreError } from '../http/errors.ts';
import { checkSessionBudget } from './budget.ts';
import { persistTranscript } from './transcriptSync.ts';
import { openCoreSession } from './openSession.ts';
import { buildContinuationInstructions, DIGEST_MAX_MESSAGES, type ThreadLine } from './threadDigest.ts';

/**
 * Лента ядра флашится раз в 5с, а воркер продолжения ретраит пустой fetch до
 * ~6с своего дедлайна. Ждать столько же на ручке — терять UX: 4с потолок, а
 * недобор компенсируется дописыванием реплики в instructions.
 */
export const TRANSCRIPT_POLL_DEADLINE_MS = 4_000;
export const TRANSCRIPT_POLL_INTERVAL_MS = 500;

export type EscalateInput = {
  widget: WidgetRow; dialog: DialogRow; messagesCount: number;
  visitorKey: string; ipHash: string;
};
export type EscalateResult = {
  dialog_id: string; channel: 'voice'; core_session_id: string;
  participant_token: ParticipantToken; continued_from: string; transcript_complete: boolean;
};

async function pollTranscript(
  deps: AppDeps, sessionId: string, wanted: number, now = () => Date.now(),
): Promise<TranscriptMessage[]> {
  const deadline = now() + TRANSCRIPT_POLL_DEADLINE_MS;
  let best: TranscriptMessage[] = [];
  for (;;) {
    try {
      const page = await deps.core.getTranscript(sessionId);
      if (page.messages.length > best.length) best = page.messages;
      if (best.length >= wanted) return best;
      // Лента ДЛИННЕЕ страницы (500 реплик), а мы просим меньше и всё равно
      // не добрали: значит недостача не «лента ещё не осела», а наша
      // однастраничность — ждать дедлайн бессмысленно, дальше нужна пагинация,
      // которой этот опрос не делает. Уходим в ветку недобора немедленно (L1).
      if (page.has_more) {
        deps.log.warn(
          { sessionId, wanted, got: best.length },
          'лента ядра длиннее страницы — опрос прекращён, недобор компенсируем инструкциями',
        );
        return best;
      }
    } catch (err) {
      deps.log.warn({ err, sessionId }, 'опрос транскрипта сорвался — продолжаем до дедлайна');
    }
    if (now() >= deadline) return best;
    await sleep(TRANSCRIPT_POLL_INTERVAL_MS);
  }
}

export async function escalateDialog(deps: AppDeps, input: EscalateInput): Promise<EscalateResult> {
  const fromSession = input.dialog.current_core_session_id;
  if (!fromSession) throw new ApiError(409, 'no_live_session', 'Нечего эскалировать: живой сессии нет.');
  // ОТСТУПЛЕНИЕ ОТ БРИФА (факт, не вкус): в брифе стоял один гард
  // `status !== 'active' → dialog_not_active`, и при нём код
  // `escalation_in_progress` становился НЕДОСТИЖИМ для клиента — диалог,
  // уже переведённый в 'escalating' предыдущим запросом, до CAS не доходил и
  // получал 'dialog_not_active' (воспроизведено красным тестом брифа же:
  // «повторный /escalate во время эскалации» отвечал dialog_not_active).
  // А коды эти РАЗНЫЕ по смыслу для FSM клиента (T7): «эскалация уже идёт» —
  // подождать и не дёргаться, «диалог не активен» — переоткрыть нить. Поэтому
  // статусы разделены явно; CAS ниже остаётся на своём месте и ловит ГОНКУ
  // (снимок был 'active', параллельный запрос успел переключить).
  if (input.dialog.status === 'escalating') {
    throw new ApiError(409, 'escalation_in_progress', 'Эскалация уже идёт.');
  }
  if (input.dialog.status !== 'active') {
    // Отдельный код: клиенту это НЕ «эскалация уже идёт», а «диалог не в том
    // состоянии» — он должен переоткрыть нить, а не ждать и повторять.
    throw new ApiError(409, 'dialog_not_active', 'Диалог не в активном состоянии — откройте его заново.');
  }
  if (input.dialog.current_channel !== 'chat') {
    // Эскалировать можно только ИЗ чата. Повторный /escalate по уже голосовому
    // диалогу (двойной клик, застрявшая FSM, ре-вход в живую voice-сессию)
    // иначе честно закрыл бы РАБОТАЮЩИЙ голосовой звонок и купил вместо него
    // второй — за деньги и с потерей разговора (L6).
    throw new ApiError(422, 'already_voice', 'Диалог уже в голосовом канале.');
  }

  // ДОПУСК до всего: голосовая сессия стоит денег ровно как стартовая (§6.3).
  // Проверяем ПЕРЕД CAS, чтобы отказ не оставил диалог в 'escalating'. Само
  // СПИСАНИЕ — в openCoreSession по факту новой сессии (M3).
  await checkSessionBudget(deps, {
    visitorKey: input.visitorKey, ipHash: input.ipHash, accountId: input.widget.account_id,
  });

  // CAS: вторая параллельная эскалация НЕ создаст вторую платную сессию.
  if (!(await casDialogStatus(deps.pool, input.dialog.id, 'active', 'escalating'))) {
    throw new ApiError(409, 'escalation_in_progress', 'Эскалация уже идёт.');
  }

  try {
    // 1. Закрываем чат: continue_from требует ЗАВЕРШЁННУЮ сессию.
    await deps.core.endSession(fromSession);

    // 2. Ждём оседания ленты. Двойная страховка: воркер продолжения сам ретраит
    //    пустой fetch истории до ~6с общего дедлайна, а мы добираем
    //    недостающее в instructions.
    const messages = await pollTranscript(deps, fromSession, input.messagesCount);
    // Тот же дедуп, что в сверке: клиент уже записал эти реплики своим путём.
    await persistTranscript(deps, { dialog: input.dialog, sessionId: fromSession, messages });
    const transcriptComplete = messages.length >= input.messagesCount;

    // 3. Недобор — дописываем последнюю реплику посетителя из НАШЕГО журнала.
    let pending: string | undefined;
    if (!transcriptComplete) {
      const journal = await listThreadTail(deps.pool, input.dialog.id, 50);
      pending = journal.filter((m) => m.source === 'client' && m.role === 'user').at(-1)?.text;
    }

    // 4. Выжимка нити: continue_from нетранзитивен, «одна правда» у BFF.
    // #8 (whole-branch адверсарий, PROMPT INJECTION): выжимка уезжает в
    // agent.instructions новой voice-сессии — по контракту ядра это ПОЛНЫЙ
    // системный промпт. Реплики ПОСЕТИТЕЛЯ берём при любом источнике (это всегда
    // его слова — доверия к тому, что он их наговорил, эскалация не требует).
    // Реплики АГЕНТА — ТОЛЬКО подтверждённые ядром (source='core'): POST
    // /messages принимает от посетителя role='agent' (source='client'), и
    // прежний фильтр `source==='client'` заводил такую ПОДДЕЛКУ в системный
    // промпт как «память агента» (посетитель диктует «подтверди возврат»), а
    // РЕАЛЬНО подтверждённые ответы (промоутнутые persistTranscript в 'core')
    // — наоборот выбрасывал. Фильтр был перевёрнут ровно наизнанку.
    const thread: ThreadLine[] = (await listThreadTail(deps.pool, input.dialog.id, DIGEST_MAX_MESSAGES * 2))
      .filter((m) => m.role === 'user' || (m.role === 'agent' && m.source === 'core'))
      .map((m) => ({ role: m.role, text: m.text }));
    const instructions = buildContinuationInstructions(
      input.widget.agent_config.instructions, thread, pending,
    );

    const opened = await openCoreSession(deps, {
      widget: input.widget, dialog: input.dialog, channel: 'voice',
      instructions, continueFrom: fromSession,
      visitorKey: input.visitorKey, ipHash: input.ipHash,
      // historyOptional тут НЕ ставим: отказ ядра продолжить нить — сигнал
      // уйти в chat_fallback (там продолжение и починится, L5), а не молча
      // купить голос без памяти, которую посетитель ждёт услышать.
    });
    await setDialogStatus(deps.pool, input.dialog.id, 'active');

    return {
      dialog_id: input.dialog.id, channel: 'voice',
      core_session_id: opened.core_session_id,
      participant_token: opened.participant_token,
      continued_from: opened.continued_from ?? fromSession,
      transcript_complete: transcriptComplete,
    };
  } catch (err) {
    if (err instanceof CoreHttpError) {
      // 402 — денег нет, диалог мёртв; остальное — возвращаем в active, клиент
      // уйдёт в chat_fallback (новый чат с continue_from).
      await setDialogStatus(deps.pool, input.dialog.id, err.status === 402 ? 'error' : 'active');
      throw mapCoreError(err);
    }
    await setDialogStatus(deps.pool, input.dialog.id, 'active');
    throw err;
  }
}

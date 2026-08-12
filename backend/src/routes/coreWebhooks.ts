import type { FastifyPluginAsync } from 'fastify';
import { verifyCoreSignature } from '../core/signature.ts';
import type { SessionFinalizedData, WebhookEnvelope } from '../core/types.ts';
import { insertCoreEvent } from '../db/repositories/coreEvents.ts';
import { applyFinalizedUsage, findDialogByClientReference, setDialogStatus } from '../db/repositories/dialogs.ts';
// Бриф вызывает reconcileTranscript в обработчике transcript.ready, но не
// импортирует её в снипете (Step 10) — компиляция упала бы на
// `Cannot find name 'reconcileTranscript'`. Добавляю импорт минимально.
import { reconcileTranscript } from '../dialogs/transcriptSync.ts';

export const coreWebhookRoutes: FastifyPluginAsync = async (app) => {
  // rawBody ТОЛЬКО в этом плагине: парсер инкапсулирован скоупом Fastify и не
  // портит остальные роуты, которым нужен разобранный json.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/w/v1/core-webhooks', async (req, reply) => {
    const raw = req.body as Buffer;
    const verdict = verifyCoreSignature(
      raw,
      req.headers['x-core-signature'] as string | undefined,
      app.deps.config.coreWebhookSecret,
      Date.now(),
    );
    if (!verdict.ok) {
      app.log.warn({ reason: verdict.reason }, 'вебхук отвергнут: подпись не сошлась');
      return reply.code(401).send({ error: { code: 'invalid_signature', message: verdict.reason } });
    }

    let envelope: WebhookEnvelope;
    try {
      envelope = JSON.parse(raw.toString('utf8')) as WebhookEnvelope;
    } catch {
      return reply.code(400).send({ error: { code: 'malformed_body', message: 'тело не json' } });
    }
    if (typeof envelope.event_id !== 'string' || typeof envelope.type !== 'string') {
      return reply.code(400).send({ error: { code: 'malformed_envelope', message: 'нет event_id или type' } });
    }

    // Дедуп ПЕРВЫМ делом: порядок не гарантирован, ретраи штатны.
    const fresh = await insertCoreEvent(app.deps.pool, {
      eventId: envelope.event_id,
      type: envelope.type,
      payload: envelope,
    });
    if (!fresh) {
      app.log.info({ eventId: envelope.event_id, type: envelope.type }, 'вебхук уже обработан — дубль');
      return reply.send({ ok: true, deduped: true });
    }

    if (envelope.type === 'session.finalized') {
      const data = envelope.data as SessionFinalizedData & { client_reference?: string };
      const ref = data.client_reference;
      const dialog = ref ? await findDialogByClientReference(app.deps.pool, ref) : null;
      if (!dialog) {
        app.log.warn({ ref, sessionId: data.session_id }, 'session.finalized без известного диалога');
      } else {
        const settled = await applyFinalizedUsage(app.deps.pool, {
          dialogId: dialog.id,
          sessionId: data.session_id,
          usage: (data.usage_summary ?? {}) as Record<string, number>,
          creditsTotal: data.credits_total ?? 0,
        });
        if (!settled) {
          app.log.info({ sessionId: data.session_id }, 'деньги сессии уже учтены (свипер успел раньше)');
        }
        // В ended роняем ТОЛЬКО текущую сессию активного диалога: закрытие
        // чата ради эскалации приходит сюда же, но диалог тогда 'escalating'.
        if (dialog.status === 'active' && dialog.current_core_session_id === data.session_id) {
          await setDialogStatus(app.deps.pool, dialog.id, 'ended');
        }
      }
    } else if (envelope.type === 'transcript.ready') {
      // СВЕРКА ленты (спека §3): журнал ведёт iframe, ядро — своя правда.
      // На финализации подтягиваем ленту ядра как source='core'; расхождение
      // логируем — это единственный сигнал, что витрина и лента разъехались.
      const data = envelope.data as { session_id: string; client_reference?: string; message_count: number };
      const dialog = data.client_reference
        ? await findDialogByClientReference(app.deps.pool, data.client_reference)
        : null;
      if (dialog) {
        await reconcileTranscript(app.deps, { dialog, sessionId: data.session_id, expected: data.message_count });
      }
    } else if (envelope.type === 'credits.low') {
      app.log.warn({ data: envelope.data }, 'БЮДЖЕТ-ПРЕДОХРАНИТЕЛЬ: у тенанта виджета кончаются кредиты');
    }

    return reply.send({ ok: true });
  });
};

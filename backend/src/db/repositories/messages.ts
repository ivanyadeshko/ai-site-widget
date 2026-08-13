import type { Queryable } from '../pool.ts';

export type MessageRow = {
  id: string;
  dialog_id: string;
  role: 'user' | 'agent';
  text: string;
  source: 'client' | 'core';
  core_session_id: string | null;
  seq: number;
  created_at: Date;
};

export type InsertMessageInput = {
  dialogId: string;
  role: 'user' | 'agent';
  text: string;
  source: 'client' | 'core';
  coreSessionId: string | null;
  seq: number;
};

export async function insertMessage(db: Queryable, input: InsertMessageInput): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO dialog_messages (dialog_id, role, text, source, core_session_id, seq)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [input.dialogId, input.role, input.text, input.source, input.coreSessionId, input.seq],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * ХВОСТ нити в хронологическом порядке — единственный способ читать журнал.
 * Голова здесь никому не нужна: у долгого диалога `ORDER BY id ASC LIMIT 200`
 * отдал бы первые двести реплик и спрятал всё недавнее — посетитель открыл бы
 * виджет и увидел начало разговора недельной давности.
 */
export async function listThreadTail(db: Queryable, dialogId: string, limit: number): Promise<MessageRow[]> {
  const { rows } = await db.query<MessageRow>(
    `SELECT * FROM (
       SELECT id::text, dialog_id, role, text, source, core_session_id, seq, created_at
         FROM dialog_messages WHERE dialog_id = $1 ORDER BY id DESC LIMIT $2
     ) tail ORDER BY id ASC`,
    [dialogId, limit],
  );
  return rows;
}

/** Максимальный seq клиентского журнала — с него продолжится нумерация после reload. */
export async function maxClientSeq(db: Queryable, dialogId: string): Promise<number> {
  const { rows } = await db.query<{ seq: number | null }>(
    `SELECT max(seq) AS seq FROM dialog_messages WHERE dialog_id = $1 AND source = 'client'`,
    [dialogId],
  );
  return rows[0]?.seq ?? 0;
}

/**
 * Повышает лейбл уже лежащей реплики АГЕНТА до source='core'. Клиент журналит
 * ответ агента ПЕРВЫМ (оптимистично, source='client'), а подтверждённая копия
 * из ленты ядра приезжает позже и совпадает по тексту — persistTranscript её
 * дедупил ПРОЧЬ, и в витрине навсегда оставался client-лейбл. Из-за этого бейдж
 * «⚠ не подтверждено ядром» ложно горел на КАЖДОМ ответе агента после reload —
 * ровно противоположно замыслу (source нужен, чтобы ловить ПОДДЕЛКУ). Для реплик
 * агента ядро авторитетнее: его копия ВЫТЕСНЯЕТ клиентский лейбл.
 *
 * Идемпотентно: обновляет только ещё client-строки, поэтому повторный core-синк
 * ничего не трогает и дубля не плодит. Реплики ПОСЕТИТЕЛЯ (role=user) сюда не
 * попадают — там клиентская версия каноничнее (его точный ввод, не STT-догадка).
 * Возвращает число повышенных строк.
 */
export async function promoteAgentReplyToCore(
  db: Queryable,
  input: { dialogId: string; text: string; coreSessionId: string; windowSeconds: number },
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE dialog_messages
        SET source = 'core', core_session_id = $3
      WHERE dialog_id = $1 AND role = 'agent' AND source = 'client'
        AND lower(btrim(regexp_replace(text, '\\s+', ' ', 'g')))
            = lower(btrim(regexp_replace($2::text, '\\s+', ' ', 'g')))
        AND created_at > now() - ($4 || ' seconds')::interval`,
    [input.dialogId, input.text, input.coreSessionId, String(input.windowSeconds)],
  );
  return rowCount ?? 0;
}

/**
 * Есть ли уже в журнале такой текст этой роли в окне ±N секунд. Нужен на синке
 * транскрипта ядра: уникальный индекс ловит лишь повтор той же (source,seq)
 * пары, а одна и та же реплика приезжает ДВАЖДЫ разными путями — от клиента
 * (source=client, свой seq) и из ленты ядра (source=core, seq ядра).
 */
export async function hasSimilarMessage(
  db: Queryable,
  input: { dialogId: string; role: 'user' | 'agent'; text: string; windowSeconds: number },
): Promise<boolean> {
  const { rows } = await db.query<{ hit: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM dialog_messages
        WHERE dialog_id = $1 AND role = $2
          AND lower(btrim(regexp_replace(text, '\\s+', ' ', 'g')))
              = lower(btrim(regexp_replace($3::text, '\\s+', ' ', 'g')))
          AND created_at > now() - ($4 || ' seconds')::interval
     ) AS hit`,
    [input.dialogId, input.role, input.text, String(input.windowSeconds)],
  );
  return rows[0]!.hit;
}

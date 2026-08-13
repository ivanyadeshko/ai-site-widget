import { createHash } from 'node:crypto';
import type { Queryable } from '../pool.ts';

// IP наружу и в БД не попадает НИКОГДА — только необратимый хэш с солью стенда.
export const hashIp = (ip: string, salt: string): string =>
  createHash('sha256').update(`${salt}:${ip}`).digest('hex');

export async function bumpIpDayCounter(db: Queryable, ipHash: string): Promise<number> {
  const { rows } = await db.query<{ started: number }>(
    `INSERT INTO ip_day_counters (ip_hash, day, started) VALUES ($1, current_date, 1)
     ON CONFLICT (ip_hash, day) DO UPDATE SET started = ip_day_counters.started + 1
     RETURNING started`,
    [ipHash],
  );
  return rows[0]!.started;
}

/** Текущее значение БЕЗ инкремента — для путей, которые сами капов не тратят (см. peekVisitorDayCounter). */
export async function peekIpDayCounter(db: Queryable, ipHash: string): Promise<number> {
  const { rows } = await db.query<{ started: number }>(
    `SELECT started FROM ip_day_counters WHERE ip_hash = $1 AND day = current_date`,
    [ipHash],
  );
  return rows[0]?.started ?? 0;
}

/**
 * Симметрично bumpIpDayCounter, но по visitor_key — БЕЗ хэша: в отличие от IP,
 * visitor_key уже клиентский псевдоним (UUID, который сам клиент сгенерировал
 * и хранит у себя), а не PII, прятать нечего. Фикс-раунд 1 (Э4-T3): капы
 * считают КАЖДОЕ создание сессии ядра, а не строки dialogs — см. budget.ts.
 */
export async function bumpVisitorDayCounter(db: Queryable, visitorKey: string): Promise<number> {
  const { rows } = await db.query<{ started: number }>(
    `INSERT INTO visitor_day_counters (visitor_key, day, started) VALUES ($1, current_date, 1)
     ON CONFLICT (visitor_key, day) DO UPDATE SET started = visitor_day_counters.started + 1
     RETURNING started`,
    [visitorKey],
  );
  return rows[0]!.started;
}

/**
 * Текущее значение БЕЗ инкремента. Нужно путям, которые сами сессию не
 * создают (сейчас — заглушка /escalate до T4): бампать там нельзя — иначе
 * клиентские ретраи навсегда падающего 501-эндпоинта незаметно съедят суточную
 * квоту у легитимного пользователя ещё до того, как он реально попробует
 * начать разговор.
 */
export async function peekVisitorDayCounter(db: Queryable, visitorKey: string): Promise<number> {
  const { rows } = await db.query<{ started: number }>(
    `SELECT started FROM visitor_day_counters WHERE visitor_key = $1 AND day = current_date`,
    [visitorKey],
  );
  return rows[0]?.started ?? 0;
}

/**
 * Чистка счётчиков старше N суток. Таблицы растут по одной строке на
 * IP/visitor в день и никем не подметаются — за год это мусор, который никто
 * не удалит руками. Зовутся свипером (T4) тем же тиком, что и досинк диалогов.
 */
export async function purgeOldIpCounters(db: Queryable, keepDays: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM ip_day_counters WHERE day < current_date - ($1 || ' days')::interval`,
    [String(keepDays)],
  );
  return rowCount ?? 0;
}

export async function purgeOldVisitorCounters(db: Queryable, keepDays: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM visitor_day_counters WHERE day < current_date - ($1 || ' days')::interval`,
    [String(keepDays)],
  );
  return rowCount ?? 0;
}

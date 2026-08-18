import type { Queryable } from '../pool.ts';

/**
 * Агрегаты расхода для кабинета (и для админки — Task 19 ходит сюда же).
 *
 * ⚠️ Отклонение от буквы плана: вместо одного `UsageBucket` с обязательным
 * полем `day` — общий `UsageMetrics` плюс два вида бакета. У среза по виджетам
 * и у итога дня не бывает, и фиктивное значение («» или граница периода) было
 * бы ложью прямо в контракте API.
 *
 * ИЗОЛЯЦИЯ АРЕНДАТОРОВ — в SQL: каждый запрос идёт от `widgets` с
 * `w.account_id = $1`. Цифры расхода — это деньги, и чужая строка в отчёте
 * дороже, чем чужая строка в листинге.
 */
export type UsageMetrics = {
  dialogs: number;
  credits_total: number;
  /** Метры ядра, как они пришли: набор ключей ПРОИЗВОЛЬНЫЙ и будет расти. */
  usage: Record<string, number>;
};

export type UsageDayBucket = UsageMetrics & { day: string };
export type UsageWidgetBucket = UsageMetrics & { widget_id: string; widget_name: string };

export type UsageQuery = { accountId: string; widgetId: string | null; from: Date; to: Date };

/**
 * Диалоги аккаунта в периоде. `from` включительно, `to` ИСКЛЮЧИТЕЛЬНО — так
 * соседние периоды стыкуются без нахлёста, и один и тот же диалог не попадает
 * в два отчёта.
 */
const SCOPED = `
  SELECT d.id, d.credits_total, d.usage, d.widget_id,
         to_char(d.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
    FROM dialogs d
    JOIN widgets w ON w.id = d.widget_id
   WHERE w.account_id = $1
     AND ($2::uuid IS NULL OR d.widget_id = $2::uuid)
     AND d.started_at >= $3::timestamptz
     AND d.started_at < $4::timestamptz`;

/*
 * Слияние метров повторяет паттерн `applyFinalizedUsage` (dialogs.ts):
 * `jsonb_each_text` разворачивает произвольный набор ключей в строки,
 * `sum(value::numeric)` складывает, `jsonb_object_agg` собирает обратно.
 * Перечислять метры именами нельзя: ядро добавляет их без нашего участия, и
 * фиксированный список тихо потерял бы новый.
 */

export async function usageByDay(db: Queryable, input: UsageQuery): Promise<UsageDayBucket[]> {
  const { rows } = await db.query<UsageDayBucket>(
    `WITH scoped AS (${SCOPED}),
     metrics AS (
       SELECT s.day, kv.key, sum(kv.value::numeric) AS value
         FROM scoped s, LATERAL jsonb_each_text(s.usage) kv
        GROUP BY s.day, kv.key
     ),
     merged AS (SELECT day, jsonb_object_agg(key, value) AS usage FROM metrics GROUP BY day)
     SELECT s.day,
            count(*)::int AS dialogs,
            coalesce(sum(s.credits_total), 0)::int AS credits_total,
            coalesce(m.usage, '{}'::jsonb) AS usage
       FROM scoped s
       LEFT JOIN merged m ON m.day = s.day
      GROUP BY s.day, m.usage
      ORDER BY s.day`,
    [input.accountId, input.widgetId, input.from, input.to],
  );
  return rows;
}

/**
 * Срез по виджетам. Идём ОТ `widgets` через LEFT JOIN: виджет без диалогов
 * обязан быть в отчёте нулевой строкой — «строки нет» владелец читает как сбой
 * отчёта, а не как «им никто не пользовался».
 */
export async function usageByWidget(db: Queryable, input: UsageQuery): Promise<UsageWidgetBucket[]> {
  const { rows } = await db.query<UsageWidgetBucket>(
    `WITH scoped AS (
       SELECT w.id AS widget_id, w.name AS widget_name, d.id AS dialog_id,
              d.credits_total, d.usage
         FROM widgets w
         LEFT JOIN dialogs d
                ON d.widget_id = w.id
               AND d.started_at >= $3::timestamptz
               AND d.started_at < $4::timestamptz
        WHERE w.account_id = $1
          AND ($2::uuid IS NULL OR w.id = $2::uuid)
     ),
     metrics AS (
       SELECT s.widget_id, kv.key, sum(kv.value::numeric) AS value
         FROM scoped s, LATERAL jsonb_each_text(coalesce(s.usage, '{}'::jsonb)) kv
        GROUP BY s.widget_id, kv.key
     ),
     merged AS (SELECT widget_id, jsonb_object_agg(key, value) AS usage FROM metrics GROUP BY widget_id)
     SELECT s.widget_id, s.widget_name,
            count(s.dialog_id)::int AS dialogs,
            coalesce(sum(s.credits_total), 0)::int AS credits_total,
            coalesce(m.usage, '{}'::jsonb) AS usage
       FROM scoped s
       LEFT JOIN merged m ON m.widget_id = s.widget_id
      GROUP BY s.widget_id, s.widget_name, m.usage
      ORDER BY credits_total DESC, s.widget_name ASC`,
    [input.accountId, input.widgetId, input.from, input.to],
  );
  return rows;
}

/** Итог периода одной строкой — считается в БД, а не суммированием бакетов на клиенте. */
export async function usageTotals(db: Queryable, input: UsageQuery): Promise<UsageMetrics> {
  const { rows } = await db.query<UsageMetrics>(
    `WITH scoped AS (${SCOPED}),
     metrics AS (
       SELECT kv.key, sum(kv.value::numeric) AS value
         FROM scoped s, LATERAL jsonb_each_text(s.usage) kv
        GROUP BY kv.key
     )
     SELECT (SELECT count(*)::int FROM scoped) AS dialogs,
            (SELECT coalesce(sum(credits_total), 0)::int FROM scoped) AS credits_total,
            (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM metrics) AS usage`,
    [input.accountId, input.widgetId, input.from, input.to],
  );
  return rows[0]!;
}

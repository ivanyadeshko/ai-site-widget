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

/*
 * МЕЖАРЕНДАТОРНЫЕ СРЕЗЫ — ТОЛЬКО НИЖЕ ЭТОЙ ЧЕРТЫ (Task 19, админка оператора).
 *
 * Функции ВЫШЕ жёстко несут `w.account_id = $1`, и это гарантия изоляции
 * кабинета: цифры расхода — деньги, чужая строка в отчёте дороже чужой строки
 * в листинге. Ослаблять их ради админки НЕЛЬЗЯ — вместо этого отдельные
 * `admin*`-функции без скоупа, вызываемые исключительно из-под `requireAdmin`.
 * Разные имена и разные запросы: тогда «переиспользование» панельной функции
 * с выкинутым скоупом не может случиться по невнимательности.
 */

/** Строка админского среза: тот же набор метрик, но ключ — аккаунт витрины. */
export type UsageAccountBucket = UsageMetrics & { account_id: string; account_email: string };

export type AdminUsageQuery = { from: Date; to: Date };

/**
 * Расход по аккаунтам витрины за период.
 *
 * Идём ОТ `accounts` через LEFT JOIN: клиент без диалогов остаётся строкой с
 * нулями — «строки нет» оператор читает как сбой отчёта, а не как «клиент
 * молчал». Перемножения строк здесь нет: диалог принадлежит ровно одному
 * виджету, виджет — ровно одному аккаунту, поэтому каждый диалог попадает в
 * выборку однажды и `sum(credits_total)` считает деньги, а не их кратное.
 *
 * Бесхозные виджеты (`account_id IS NULL`, наследие релиза 1) в разрез не
 * попадают — владельца у них нет. Их расход виден в `adminUsageTotals`;
 * расхождение итога и суммы бакетов означает ровно это и закроется Task 27.
 */
export async function adminUsageByAccount(db: Queryable, input: AdminUsageQuery): Promise<UsageAccountBucket[]> {
  const { rows } = await db.query<UsageAccountBucket>(
    `WITH scoped AS (
       SELECT a.id AS account_id, a.email AS account_email, d.id AS dialog_id,
              d.credits_total, d.usage
         FROM accounts a
         LEFT JOIN widgets w ON w.account_id = a.id
         LEFT JOIN dialogs d
                ON d.widget_id = w.id
               AND d.started_at >= $1::timestamptz
               AND d.started_at < $2::timestamptz
     ),
     metrics AS (
       SELECT s.account_id, kv.key, sum(kv.value::numeric) AS value
         FROM scoped s, LATERAL jsonb_each_text(coalesce(s.usage, '{}'::jsonb)) kv
        GROUP BY s.account_id, kv.key
     ),
     merged AS (SELECT account_id, jsonb_object_agg(key, value) AS usage FROM metrics GROUP BY account_id)
     SELECT s.account_id, s.account_email,
            count(s.dialog_id)::int AS dialogs,
            coalesce(sum(s.credits_total), 0)::int AS credits_total,
            coalesce(m.usage, '{}'::jsonb) AS usage
       FROM scoped s
       LEFT JOIN merged m ON m.account_id = s.account_id
      GROUP BY s.account_id, s.account_email, m.usage
      ORDER BY credits_total DESC, s.account_email ASC`,
    [input.from, input.to],
  );
  return rows;
}

/**
 * Итог витрины за период — по ВСЕМ диалогам, без оглядки на владельца.
 *
 * Считается не суммой бакетов намеренно: это цифра, которую оператор сверяет с
 * балансом кредитов ядра, и она обязана включать диалоги бесхозных виджетов —
 * ядру за них уже заплачено.
 */
export async function adminUsageTotals(db: Queryable, input: AdminUsageQuery): Promise<UsageMetrics> {
  const { rows } = await db.query<UsageMetrics>(
    `WITH scoped AS (
       SELECT d.id, d.credits_total, d.usage
         FROM dialogs d
        WHERE d.started_at >= $1::timestamptz
          AND d.started_at < $2::timestamptz
     ),
     metrics AS (
       SELECT kv.key, sum(kv.value::numeric) AS value
         FROM scoped s, LATERAL jsonb_each_text(s.usage) kv
        GROUP BY kv.key
     )
     SELECT (SELECT count(*)::int FROM scoped) AS dialogs,
            (SELECT coalesce(sum(credits_total), 0)::int FROM scoped) AS credits_total,
            (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM metrics) AS usage`,
    [input.from, input.to],
  );
  return rows[0]!;
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

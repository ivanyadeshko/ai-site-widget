/* eslint-disable camelcase */
// Третий ключ суточного капа — ВЛАДЕЛЕЦ САЙТА. Визиторный и IP-капы
// (visitor_day_counters / ip_day_counters) защищают от одного назойливого
// посетителя, но не от аккаунта витрины, чьи виджеты суммарно выжигают баланс
// ОБЩЕГО тенанта ядра (D-1: для ядра вся витрина — один тенант).
//
// Форма account_day_counters — симметрична visitor_day_counters
// (1755100100000): строка на ключ в сутки, ON CONFLICT DO UPDATE, уборка
// свипером.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE account_limits (
      account_id           UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      max_sessions_per_day INTEGER NOT NULL,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- SET NULL, а не CASCADE: удаление АДМИНА, который правил лимит, не
      -- должно уносить сам лимит вместе с ним.
      updated_by           UUID REFERENCES accounts(id) ON DELETE SET NULL
    );

    CREATE TABLE account_day_counters (
      account_id UUID NOT NULL,
      day        DATE NOT NULL,
      started    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, day)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE account_day_counters; DROP TABLE account_limits;`);
};

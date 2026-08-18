/* eslint-disable camelcase */
// Этап E, поток I (Task 1): у витрины появляются собственные аккаунты —
// владельцы сайтов. Для ЯДРА витрина остаётся ОДНИМ тенантом (решение D-1):
// эти строки — клиенты витрины, а не тенанты ядра.
//
// Миграция строго АДДИТИВНА (Р6 программы): предыдущий образ обязан работать
// на новой схеме. Поэтому widgets.account_id добавляется NULLABLE + бэкфилл на
// системный аккаунт; NOT NULL ставится ВТОРЫМ релизом (Task 27), когда в
// проде уже не осталось кода, вставляющего виджет без владельца.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE accounts (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
      blocked_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    );

    -- citext НЕ подключаем: лишняя зависимость от образа БД ради того, что
    -- функциональный индекс решает штатно. Исходное написание email при этом
    -- сохраняется как ввёл владелец (показываем его же в панели).
    CREATE UNIQUE INDEX accounts_email_unique ON accounts (lower(email));

    -- Сессии панели живут в БД, а не в JWT (D-3): блокировка аккаунта админом
    -- обязана гасить живые сессии МГНОВЕННО, а подписанный токен отозвать
    -- нельзя. В строке лежит sha256(token), не сам токен: утечка дампа не даёт
    -- войти.
    CREATE TABLE account_sessions (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at   TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX account_sessions_account_idx ON account_sessions (account_id);
    CREATE INDEX account_sessions_expiry_idx ON account_sessions (expires_at);

    ALTER TABLE widgets ADD COLUMN account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;
    CREATE INDEX widgets_account_idx ON widgets (account_id);

    -- Владелец бэкфилла. 'locked' не является валидным scrypt-хэшем
    -- (backend/src/auth/password.ts), поэтому verifyPassword вернёт false на
    -- ЛЮБОЙ пароль — войти под системным аккаунтом нельзя.
    INSERT INTO accounts (email, password_hash) VALUES ('system@vell.local', 'locked')
      ON CONFLICT DO NOTHING;

    UPDATE widgets SET account_id = (SELECT id FROM accounts WHERE email = 'system@vell.local')
     WHERE account_id IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE account_sessions;
    ALTER TABLE widgets DROP COLUMN account_id;
    DROP TABLE accounts;
  `);
};

/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.sql(`
    CREATE TABLE widgets (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      publish_token    TEXT NOT NULL UNIQUE,
      name             TEXT NOT NULL,
      agent_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
      kb_ids           JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_origins  JSONB NOT NULL DEFAULT '[]'::jsonb,
      enabled          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE dialogs (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      widget_id               UUID NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      visitor_key             UUID NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','escalating','ended','error')),
      core_session_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- Сессии, деньги по которым УЖЕ учтены. Вебхук и свипер приходят к одному
      -- и тому же выводу разными путями и могут сойтись на одной сессии —
      -- без этого списка credits_total удвоился бы.
      settled_session_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,
      current_core_session_id TEXT,
      current_channel         TEXT CHECK (current_channel IN ('chat','voice')),
      client_reference        TEXT NOT NULL UNIQUE,
      usage                   JSONB NOT NULL DEFAULT '{}'::jsonb,
      credits_total           INTEGER NOT NULL DEFAULT 0,
      started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at                TIMESTAMPTZ,
      last_activity_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX dialogs_visitor_started_idx ON dialogs (visitor_key, started_at DESC);
    CREATE INDEX dialogs_stale_idx ON dialogs (status, last_activity_at);

    CREATE TABLE dialog_messages (
      id              BIGSERIAL PRIMARY KEY,
      dialog_id       UUID NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK (role IN ('user','agent')),
      text            TEXT NOT NULL,
      source          TEXT NOT NULL CHECK (source IN ('client','core')),
      core_session_id TEXT,
      seq             INTEGER NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Идемпотентность журнала: ре-отправка того же seq клиентом и повторная
    -- сверка транскрипта ядра не плодят дублей. coalesce нужен потому, что у
    -- source='client' сессии может ещё не быть.
    CREATE UNIQUE INDEX dialog_messages_dedup_idx
      ON dialog_messages (dialog_id, source, coalesce(core_session_id, ''), seq);
    CREATE INDEX dialog_messages_thread_idx ON dialog_messages (dialog_id, id);

    CREATE TABLE leads (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dialog_id  UUID NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
      widget_id  UUID NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      name       TEXT,
      phone      TEXT,
      email      TEXT,
      comment    TEXT,
      consent    BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE core_events (
      event_id    TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      payload     JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- IP посетителя НЕ храним (спека §9): только необратимый суточный счётчик.
    CREATE TABLE ip_day_counters (
      ip_hash TEXT NOT NULL,
      day     DATE NOT NULL,
      started INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ip_hash, day)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE ip_day_counters, core_events, leads, dialog_messages, dialogs, widgets;`);
};

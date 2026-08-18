/* eslint-disable camelcase */
// Счётчик неудачных входов ПО КЛЮЧУ СУБЪЕКТА (сейчас — 'login:<email>').
//
// Почему в БД, а не в памяти @fastify/rate-limit: (а) память per-process не
// переживает рестарт контейнера — перебор просто продолжается с нуля;
// (б) лимит по IP здесь бесполезен, злоумышленник меняет IP, а не email, и
// медленный перебор ОДНОГО аккаунта проходит под любым IP-лимитом.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE auth_failures (
      subject_key      TEXT PRIMARY KEY,
      failures         INTEGER NOT NULL DEFAULT 0,
      first_failure_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_until     TIMESTAMPTZ
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE auth_failures;`);
};

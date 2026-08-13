/* eslint-disable camelcase */
// Фикс-раунд 1 (Э4-T3): визитор-кап переходит со счёта строк dialogs на счёт
// СОЗДАНИЙ СЕССИЙ ЯДРА (см. backend/src/dialogs/budget.ts) — продолжение нити
// после silence и эскалация плодят новые платные сессии на ТОМ ЖЕ диалоге, а
// счётчик по dialogs эту повторную плату не видел (воспроизведено: 11 платных
// сессий при капе 2). Таблица — симметрично ip_day_counters, БЕЗ хэша: в
// отличие от IP, visitor_key уже клиентский псевдоним, а не PII.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE visitor_day_counters (
      visitor_key UUID NOT NULL,
      day         DATE NOT NULL,
      started     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (visitor_key, day)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE visitor_day_counters;`);
};

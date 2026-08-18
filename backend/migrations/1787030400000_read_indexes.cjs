/* eslint-disable camelcase */
// Индексы ЧТЕНИЯ для кабинета (гэп 4 разведки). До этой миграции `leads` жила
// без единого индекса вообще — таблица только на запись, и первый же экран
// лидов дал бы seq scan на каждый запрос.
//
// Форма индексов повторяет ORDER BY листингов: keyset-пагинация ходит парой
// (время, id) DESC, и составной индекс той же формы отдаёт страницу без
// сортировки в памяти.
//
// CONCURRENTLY здесь НЕЛЬЗЯ: node-pg-migrate гоняет миграции в транзакции, а
// CREATE INDEX CONCURRENTLY внутри транзакции запрещён Postgres. Таблицы на
// момент этапа E маленькие, обычный CREATE INDEX их не держит заметно.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX leads_widget_created_idx   ON leads   (widget_id, created_at DESC, id DESC);
    CREATE INDEX leads_dialog_idx           ON leads   (dialog_id);
    CREATE INDEX dialogs_widget_started_idx ON dialogs (widget_id, started_at DESC, id DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX dialogs_widget_started_idx;
    DROP INDEX leads_dialog_idx;
    DROP INDEX leads_widget_created_idx;
  `);
};

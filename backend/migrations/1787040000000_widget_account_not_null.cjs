/* eslint-disable camelcase */
// Этап E, поток X (Task 27): ВТОРОЙ РЕЛИЗ — widgets.account_id → NOT NULL.
//
// ⚠️ ДЕСТРУКТИВ по букве Р6 (аддитивность): предыдущий образ обязан работать
// на новой схеме, поэтому этот ALTER НЕ едет в одном релизе с добавлением
// колонки (Task 1, миграция 1787030000000_accounts.cjs — NULLABLE + бэкфилл на
// системный аккаунт). Мержится ОТДЕЛЬНЫМ PR ПОСЛЕ того, как релиз с Task 1–26
// раскатан на дев и там `SELECT count(*) FROM widgets WHERE account_id IS NULL`
// уже равен нулю.
//
// Пред-условие проверяется ЯВНО и падает ВНЯТНО: голый SET NOT NULL на таблице
// с NULL-строками роняет Postgres невнятным «column ... contains null values»
// без указания, ЧТО делать. Здесь — понятная инструкция прогнать бэкфилл.
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE orphan_count integer;
    BEGIN
      SELECT count(*) INTO orphan_count FROM widgets WHERE account_id IS NULL;
      IF orphan_count > 0 THEN
        RAISE EXCEPTION
          'Миграция NOT NULL остановлена: % виджет(ов) без account_id. Сначала прогони бэкфилл на системный аккаунт: UPDATE widgets SET account_id = (SELECT id FROM accounts WHERE email = ''system@vell.local'') WHERE account_id IS NULL; — и повтори.',
          orphan_count;
      END IF;
    END $$;

    ALTER TABLE widgets ALTER COLUMN account_id SET NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE widgets ALTER COLUMN account_id DROP NOT NULL;');
};

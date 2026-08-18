/* eslint-disable camelcase */
// Оформление виджета: цвет, сторона экрана и три подписи. Хранится JSONB, а не
// пятью колонками, потому что набор полей темы будет расти (иконка, радиус,
// тёмная схема), а каждая новая колонка — миграция на живой таблице.
//
// Аддитивность (Constraint 1): колонка NOT NULL с DEFAULT '{}' — предыдущий
// образ, который про theme ничего не знает, пишет и читает widgets без неё.
// Пустой объект = «всё по умолчанию»; сами дефолты живут в коде
// (src/widgets/theme.ts) и отдаются наружу в /config, чтобы лоадер (бюджет
// 8 КБ gzip) не носил в себе ни одного значения.
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE widgets ADD COLUMN theme JSONB NOT NULL DEFAULT '{}'::jsonb;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE widgets DROP COLUMN theme;`);
};

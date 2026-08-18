import type { GlobalConfig } from 'payload'

/**
 * Шапка лендинга.
 *
 * ⚠️ Здесь НЕТ URL кабинета. Ссылки «Войти»/«Начать» строятся из
 * `NEXT_PUBLIC_APP_URL` в `src/lib/links.ts` — домен задаётся окружением
 * (build-arg), а не контентом: иначе после переезда стенда кнопки лендинга
 * молча увели бы посетителя на чужой хост.
 */
export const Header: GlobalConfig = {
  slug: 'header',
  label: 'Шапка',
  access: { read: () => true },
  admin: { group: 'Сайт' },
  fields: [
    { name: 'brand', type: 'text', required: true, defaultValue: 'Vell' },
    {
      name: 'navItems',
      type: 'array',
      admin: { description: 'Пункты меню. href — якорь на этой же странице (#pricing) или внутренний путь (/blog).' },
      fields: [
        { name: 'label', type: 'text', required: true },
        { name: 'href', type: 'text', required: true },
      ],
    },
    { name: 'loginLabel', type: 'text', defaultValue: 'Войти' },
    { name: 'registerLabel', type: 'text', defaultValue: 'Начать бесплатно' },
  ],
}

import type { Block } from 'payload'

/** Первый экран: заголовок, подзаголовок и пара CTA в кабинет. */
export const HeroBlock: Block = {
  slug: 'hero',
  labels: { singular: 'Hero', plural: 'Hero' },
  fields: [
    { name: 'badge', type: 'text', admin: { description: 'Маленькая плашка над заголовком.' } },
    { name: 'title', type: 'text', required: true },
    { name: 'subtitle', type: 'textarea' },
    {
      name: 'primaryLabel',
      type: 'text',
      defaultValue: 'Начать бесплатно',
      admin: { description: 'Ведёт в кабинет, на регистрацию. URL берётся из окружения, не из контента.' },
    },
    {
      name: 'secondaryLabel',
      type: 'text',
      admin: { description: 'Вторая кнопка — вход в кабинет. Пусто = кнопки нет.' },
    },
  ],
}

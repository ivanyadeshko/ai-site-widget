import type { Block } from 'payload'

/** Финальный призыв. Кнопка всегда ведёт в кабинет — URL из окружения. */
export const CtaBlock: Block = {
  slug: 'cta',
  labels: { singular: 'CTA', plural: 'CTA' },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'subtitle', type: 'textarea' },
    { name: 'primaryLabel', type: 'text', required: true, defaultValue: 'Начать бесплатно' },
  ],
}

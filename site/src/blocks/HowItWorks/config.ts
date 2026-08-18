import type { Block } from 'payload'

/** Три шага: вставьте сниппет → настройте агента → получайте лиды. */
export const HowItWorksBlock: Block = {
  slug: 'how-it-works',
  labels: { singular: 'Как это работает', plural: 'Как это работает' },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'subtitle', type: 'textarea' },
    {
      name: 'steps',
      type: 'array',
      minRows: 2,
      maxRows: 5,
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'text', type: 'textarea', required: true },
      ],
    },
  ],
}

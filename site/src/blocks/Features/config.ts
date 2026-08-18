import type { Block } from 'payload'

/** Сетка карточек «что умеет». */
export const FeaturesBlock: Block = {
  slug: 'features',
  labels: { singular: 'Возможности', plural: 'Возможности' },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'subtitle', type: 'textarea' },
    {
      name: 'items',
      type: 'array',
      minRows: 3,
      maxRows: 6,
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'text', type: 'textarea', required: true },
      ],
    },
  ],
}

import type { Block } from 'payload'

/**
 * Вопросы-ответы. Вопросы лежат ВНУТРИ блока, а не в отдельной коллекции:
 * FAQ у витрины один, и коллекция ради него завела бы лишнюю сущность в
 * админке и лишний JOIN на каждой отрисовке.
 */
export const FaqBlock: Block = {
  slug: 'faq',
  labels: { singular: 'Вопросы и ответы', plural: 'Вопросы и ответы' },
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'items',
      type: 'array',
      minRows: 1,
      fields: [
        { name: 'question', type: 'text', required: true },
        { name: 'answer', type: 'textarea', required: true },
      ],
    },
  ],
}

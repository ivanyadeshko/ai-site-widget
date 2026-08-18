import type { Block } from 'payload'

/**
 * Тарифы. Собственных полей у блока нет: карточки берутся из global
 * `pricing` — цены обязаны быть в ОДНОМ месте, иначе страницы начнут
 * расходиться между собой.
 */
export const PricingBlock: Block = {
  slug: 'pricing',
  labels: { singular: 'Тарифы', plural: 'Тарифы' },
  fields: [],
}

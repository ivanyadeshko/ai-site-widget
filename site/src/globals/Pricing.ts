import type { GlobalConfig } from 'payload'

/**
 * Тарифы. На старте — ЗАГЛУШКА: витрина ещё не берёт денег с владельцев
 * сайтов (биллинг живёт в ядре и считается по одному тенанту), поэтому
 * цена — необязательное поле, а вместо неё показывается `priceNote`
 * («по запросу», «на время беты — бесплатно»).
 *
 * ⚠️ Репозиторий ПУБЛИЧНЫЙ: сюда нельзя вписывать себестоимость, внутренние
 * коэффициенты и неанонсированные планы. Только то, что и так висит на сайте.
 */
export const Pricing: GlobalConfig = {
  slug: 'pricing',
  label: 'Тарифы',
  access: { read: () => true },
  admin: { group: 'Сайт' },
  fields: [
    { name: 'title', type: 'text', required: true, defaultValue: 'Тарифы' },
    { name: 'subtitle', type: 'text' },
    {
      name: 'plans',
      type: 'array',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'description', type: 'textarea' },
        {
          name: 'priceNote',
          type: 'text',
          required: true,
          admin: { description: 'Что показать вместо цены: «бесплатно на бете», «по запросу».' },
        },
        { name: 'isHighlighted', type: 'checkbox', defaultValue: false },
        {
          name: 'features',
          type: 'array',
          fields: [{ name: 'text', type: 'text', required: true }],
        },
        { name: 'ctaLabel', type: 'text', required: true, defaultValue: 'Начать бесплатно' },
      ],
    },
    { name: 'note', type: 'text', admin: { description: 'Сноска под карточками тарифов.' } },
  ],
}

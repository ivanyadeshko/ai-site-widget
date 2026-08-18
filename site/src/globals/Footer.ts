import type { GlobalConfig } from 'payload'

/** Подвал лендинга: колонки ссылок + копирайт. */
export const Footer: GlobalConfig = {
  slug: 'footer',
  label: 'Подвал',
  access: { read: () => true },
  admin: { group: 'Сайт' },
  fields: [
    { name: 'tagline', type: 'text' },
    {
      name: 'columns',
      type: 'array',
      fields: [
        { name: 'title', type: 'text', required: true },
        {
          name: 'links',
          type: 'array',
          fields: [
            { name: 'label', type: 'text', required: true },
            { name: 'href', type: 'text', required: true },
          ],
        },
      ],
    },
    { name: 'copyright', type: 'text', defaultValue: '© Vell' },
  ],
}

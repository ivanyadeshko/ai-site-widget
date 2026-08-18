import { lexicalEditor } from '@payloadcms/richtext-lexical'
import type { CollectionConfig } from 'payload'

/**
 * Страницы лендинга. Домашняя — `slug: 'home'` (рендерится на `/`),
 * остальные — по `/[slug]`.
 *
 * Поле `layout` (Task 22) — Layout Builder: набор блоков лендинга.
 * `content` — обычный richText для текстовых страниц (оферта, политика).
 */
export const Pages: CollectionConfig = {
  slug: 'pages',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'slug', 'updatedAt'],
    group: 'Контент',
  },
  // Публичное чтение: страницы отдаются анонимам.
  access: { read: () => true },
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: { description: 'URL-путь страницы. `home` = главная (/).' },
    },
    {
      name: 'content',
      type: 'richText',
      editor: lexicalEditor(),
      admin: { description: 'Текстовое тело страницы (оферта, политика). Для лендинга используй блоки.' },
    },
    {
      name: 'seo',
      type: 'group',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'description', type: 'textarea' },
      ],
    },
  ],
}

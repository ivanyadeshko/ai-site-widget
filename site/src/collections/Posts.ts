import { lexicalEditor } from '@payloadcms/richtext-lexical'
import type { CollectionConfig } from 'payload'

/**
 * Блог. Заведён сразу, хотя витрине он пока не нужен: добавить коллекцию
 * позже = отдельная миграция Payload на живой базе, а сейчас это ноль
 * стоимости.
 */
export const Posts: CollectionConfig = {
  slug: 'posts',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'slug', 'publishedAt'],
    group: 'Контент',
  },
  access: { read: () => true },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true, index: true },
    { name: 'excerpt', type: 'textarea' },
    { name: 'cover', type: 'upload', relationTo: 'media' },
    { name: 'content', type: 'richText', editor: lexicalEditor() },
    {
      name: 'publishedAt',
      type: 'date',
      admin: { position: 'sidebar', description: 'Пусто = черновик, на сайте не показывается.' },
    },
  ],
}

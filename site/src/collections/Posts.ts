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
  access: {
    // Аноним видит только опубликованное. `read: () => true` отдавал бы
    // черновики любому желающему через /admin/api/posts — неготовый текст
    // утекал бы до вычитки, а поле `publishedAt` из «сайт его не показывает»
    // превращалось бы в чистую декорацию.
    // Залогиненный редактор видит всё: иначе черновик исчез бы и из админки.
    read: ({ req }) =>
      req.user ? true : { publishedAt: { less_than_equal: new Date().toISOString() } },
  },
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

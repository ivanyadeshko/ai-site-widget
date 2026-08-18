import path from 'path'
import { fileURLToPath } from 'url'
import type { CollectionConfig } from 'payload'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

/** Картинки лендинга. Файлы лежат в томе `site-media` (compose-профиль site). */
export const Media: CollectionConfig = {
  slug: 'media',
  admin: {
    useAsTitle: 'filename',
    defaultColumns: ['filename', 'alt', 'updatedAt'],
    group: 'Медиа',
  },
  // Публичное чтение: картинки отдаются анонимам на лендинге.
  // Запись — только редактор CMS (дефолт Payload: требуется user).
  access: { read: () => true },
  fields: [{ name: 'alt', type: 'text' }],
  upload: {
    staticDir: path.resolve(dirname, '../../public/media'),
    mimeTypes: ['image/*'],
  },
}

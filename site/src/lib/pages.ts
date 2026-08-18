import { getPayloadClient } from '@/lib/payload'
import type { Page } from '@/payload-types'

/**
 * Поиск страницы по slug. Ошибка БД НЕ роняет рендер: возвращаем null, и
 * страница показывает заглушку/404 — лендинг не должен падать пятисоткой
 * из-за недоступного Postgres.
 */
export async function findPageBySlug(slug: string): Promise<Page | null> {
  try {
    const payload = await getPayloadClient()
    const { docs } = await payload.find({
      collection: 'pages',
      where: { slug: { equals: slug } },
      limit: 1,
      depth: 2,
    })
    return (docs[0] as Page | undefined) ?? null
  } catch {
    return null
  }
}

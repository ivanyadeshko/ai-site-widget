import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/links'
import { getPayloadClient } from '@/lib/payload'

// Свежесть здесь важнее кеша: карту сайта читает робот, а не человек.
export const dynamic = 'force-dynamic'

/** /sitemap.xml из страниц Payload. `home` отдаётся как корень. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!SITE_URL) return []

  try {
    const payload = await getPayloadClient()
    const { docs } = await payload.find({
      collection: 'pages',
      limit: 500,
      depth: 0,
      pagination: false,
    })

    return docs.map((page) => ({
      url: page.slug === 'home' ? `${SITE_URL}/` : `${SITE_URL}/${page.slug}`,
      lastModified: page.updatedAt ? new Date(page.updatedAt) : undefined,
    }))
  } catch {
    // БД недоступна — отдаём пустую карту, а не 500: робот вернётся позже.
    return []
  }
}

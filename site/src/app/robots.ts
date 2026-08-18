import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/links'

/**
 * /robots.txt. Админка CMS закрыта от индексации: страницы под /admin
 * бесполезны в выдаче и подсказывают роботам, где искать форму входа.
 *
 * ⚠️ Файл лежит в КОРНЕ `src/app`, а не в группе `(frontend)`, как значилось
 * в плане: внутри группы Next 16 его не подхватывает — маршрут `/robots.txt`
 * не появляется в сборке вовсе, и запрос уезжает в `[slug]`, то есть в 404
 * (проверено сборкой: с файлом в `(frontend)` в списке маршрутов есть
 * `/sitemap.xml`, но нет `/robots.txt`). `sitemap.ts` держим рядом по той же
 * причине — предсказуемость дороже симметрии с остальными страницами.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin'] }],
    ...(SITE_URL ? { sitemap: `${SITE_URL}/sitemap.xml` } : {}),
  }
}

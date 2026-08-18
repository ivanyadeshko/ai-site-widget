import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // standalone — образ runner'а тянет только сгенерированный server.js и
  // минимальный срез node_modules (см. site/Dockerfile).
  output: 'standalone',
  // Картинки отдаются как есть из public/ и /media/ — без resize и
  // перекодирования: лендинг статичен, оптимизатор Next тут только жёг бы CPU.
  images: { unoptimized: true },
  async headers() {
    // Базовая гигиена. Отличие от apps/cms: X-Frame-Options DENY, а не
    // SAMEORIGIN — лендинг vell.pro не встраивается ни во что и не встраивает
    // себя сам; iframe-поверхность продукта живёт на app.vell.pro (/app/:token).
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ]
  },
}

export default withPayload(nextConfig)

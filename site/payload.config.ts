import path from 'path'
import { fileURLToPath } from 'url'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'

import { Media } from './src/collections/Media'
import { Pages } from './src/collections/Pages'
import { Posts } from './src/collections/Posts'
import { Users } from './src/collections/Users'
import { Footer } from './src/globals/Footer'
import { Header } from './src/globals/Header'
import { Pricing } from './src/globals/Pricing'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

// Секрет — ТОЛЬКО из окружения, без inline-дефолта (в apps/cms монолита он
// есть — здесь не повторяем): репозиторий публичный, а дефолтный секрет
// подписи сессий равносилен его отсутствию.
//
// Почему не `throw` при пустом значении: этот модуль импортируется и на
// стадии `next build` (withPayload + роут-хендлеры), где секрета нет и быть
// не должно — падение здесь сломало бы сборку образа. Пустая строка доезжает
// до инициализации Payload в рантайме, и он отказывается стартовать сам.
const secret = process.env.PAYLOAD_SECRET ?? ''

// CORS/CSRF — только собственный домен витрины и локальная разработка.
// Список намеренно короткий: каждый лишний origin здесь — это разрешение
// чужой странице дёргать /admin/api с кукой редактора.
const corsOrigins = [process.env.NEXT_PUBLIC_SERVER_URL, 'http://localhost:3000'].filter(
  (origin): origin is string => Boolean(origin),
)

export default buildConfig({
  cors: { origins: corsOrigins, headers: ['Authorization', 'Content-Type'] },
  csrf: corsOrigins,
  // API Payload уезжает под /admin/api, а не под /api: апексный /api остаётся
  // за приложением (/api/health для healthcheck, /api/seed для засева).
  routes: { admin: '/admin', api: '/admin/api' },
  admin: {
    user: Users.slug,
    importMap: { baseDir: path.resolve(dirname) },
  },
  collections: [Users, Pages, Posts, Media],
  globals: [Header, Pricing, Footer],
  editor: lexicalEditor(),
  secret,
  typescript: { outputFile: path.resolve(dirname, 'src/payload-types.ts') },
  db: postgresAdapter({
    pool: { connectionString: process.env.DATABASE_URI },
  }),
  plugins: [],
})

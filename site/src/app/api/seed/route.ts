import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getPayloadClient } from '@/lib/payload'
import { seedLanding } from '@/seed/landing'

export const dynamic = 'force-dynamic'

const secretsMatch = (given: string, expected: string): boolean => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  // Длины сравниваем отдельно: timingSafeEqual на разных длинах кидает.
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Засев стартового контента лендинга.
 *
 * Роут ДЕСТРУКТИВЕН (пересоздаёт домашнюю страницу и перезаписывает globals),
 * поэтому закрыт двумя независимыми условиями:
 *   1) ENABLE_SEED_ROUTES=1 в окружении сервиса — иначе 404, то есть роут
 *      даже не признаётся существующим (на публичном домене открытый сид —
 *      это кнопка «стереть сайт»);
 *   2) заголовок `x-seed-secret` равен PAYLOAD_SECRET.
 * Только POST: GET-ссылку на такое достаточно один раз положить в чат или
 * открыть префетчем браузера.
 */
export async function POST(req: Request) {
  const enabled = process.env.ENABLE_SEED_ROUTES
  if (enabled !== '1' && enabled !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const expected = process.env.PAYLOAD_SECRET ?? ''
  const given = req.headers.get('x-seed-secret') ?? ''
  if (!expected || !secretsMatch(given, expected)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const payload = await getPayloadClient()
  const result = await seedLanding(payload)
  return NextResponse.json({ status: 'seeded', ...result }, { status: 200 })
}

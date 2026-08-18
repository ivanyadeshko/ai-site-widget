import { NextResponse } from 'next/server'

/**
 * Health для healthcheck контейнера и смока деплоя. Отвечает 200 сразу, как
 * только Next поднялся — намеренно НЕ ходит в Payload/БД и не зависит от
 * засеянного контента (в отличие от `/`, который без сида отдаёт 404).
 */
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

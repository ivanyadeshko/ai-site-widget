import { NextResponse } from 'next/server'

/**
 * Health для healthcheck контейнера и смока деплоя. Отвечает 200 сразу, как
 * только Next поднялся — намеренно НЕ ходит в Payload/БД.
 *
 * Почему не заменяется проверкой `/`: корень на незасеянном стенде отдаёт
 * 200 с плейсхолдером «лендинг ещё не наполнен» (src/app/(frontend)/page.tsx),
 * и ту же 200 он вернёт при лежащем Postgres — findPageBySlug глотает ошибку
 * БД. То есть код ответа `/` не различает «сервис жив», «контента нет» и
 * «база недоступна». Health обязан отвечать ровно на один вопрос: процесс
 * поднялся и обслуживает запросы.
 */
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

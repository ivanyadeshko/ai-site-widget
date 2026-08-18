/**
 * Ссылки лендинга в кабинет (BFF витрины, app.vell.pro).
 *
 * База берётся ТОЛЬКО из `NEXT_PUBLIC_APP_URL` — без хардкод-дефолта домена:
 * значение инлайнится в бандл на этапе `next build` и приходит build-arg'ом
 * (site/Dockerfile валит сборку, если arg пуст). Хардкод «на всякий случай»
 * увёл бы посетителя дев-стенда на прод-домен и наоборот.
 * Значение — БЕЗ завершающего слэша (см. site/.env.example).
 */
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? ''

export const REGISTER_URL = `${APP_URL}/panel/register`
export const LOGIN_URL = `${APP_URL}/panel/login`

/** Публичный адрес самого лендинга (canonical, sitemap, og). */
export const SITE_URL = (process.env.NEXT_PUBLIC_SERVER_URL ?? '').replace(/\/$/, '')

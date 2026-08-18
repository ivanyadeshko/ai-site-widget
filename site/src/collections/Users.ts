import type { CollectionConfig } from 'payload'

/**
 * Пользователи Payload CMS — редакторы лендинга vell.pro.
 *
 * ⚠️ ЭТО НЕ АККАУНТЫ ПРОДУКТА. Владельцы сайтов живут в таблице `accounts`
 * БД витрины (BFF, app.vell.pro/panel), у них своя аутентификация на
 * scrypt + cookie-сессиях. Две системы не связаны и связаны быть не должны —
 * подробности в site/README.md, раздел «Два админа — не перепутать».
 */
export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'name', 'createdAt'],
    group: 'Доступ',
  },
  // /admin публичен → brute-force закрывается штатным механизмом Payload:
  // считает неудачные логины конкретного email, а не общий поток запросов.
  auth: {
    maxLoginAttempts: 5,
    lockTime: 10 * 60 * 1000,
    // Кука сессии Payload — host-only и SameSite=Lax: `domain` НЕ задаём,
    // иначе кука апекса уехала бы на app.vell.pro и смешалась бы с сессией
    // панели (см. README «Два админа»).
    //
    // `secure` ОБЯЗАН быть задан явно: Payload не выводит его из NODE_ENV —
    // в generateCookie (payload/dist/auth/cookies.js) флаг считается как
    // `secureArg || sameSite === 'None'`, то есть при SameSite=Lax без этой
    // строки токен редактора уезжал бы по открытому http и на проде.
    // Привязка к NODE_ENV, а не `true` навсегда: `npm run dev` работает по
    // http://localhost, и браузер Secure-куку там просто не вернёт.
    //
    // ⚠️ В ОБРАЗЕ это условие вычислено на этапе `next build` (Next инлайнит
    // process.env.NODE_ENV в бандл), то есть там всегда Secure. Запуск образа
    // с `-e NODE_ENV=development` флаг НЕ снимает — проверено контейнером.
    // Практическое следствие: стенд из образа, открытый по http на IP,
    // логин в /admin не примет (браузер не вернёт Secure-куку). Нужен TLS,
    // либо доступ через http://localhost / ssh-туннель — localhost браузеры
    // считают доверенным origin'ом и Secure-куку там отдают.
    cookies: { sameSite: 'Lax', secure: process.env.NODE_ENV === 'production' },
  },
  fields: [{ name: 'name', type: 'text' }],
}

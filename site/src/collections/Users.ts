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
    cookies: { sameSite: 'Lax' },
  },
  fields: [{ name: 'name', type: 'text' }],
}

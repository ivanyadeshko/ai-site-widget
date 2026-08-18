import { getPayloadClient } from '@/lib/payload'
import { LOGIN_URL, REGISTER_URL } from '@/lib/links'

type NavItem = { label?: string | null; href?: string | null }

/**
 * Шапка. Контент — из global `header`; если БД ещё не засеяна (или лежит),
 * шапка рисуется дефолтами, а не роняет страницу: лендинг обязан открываться
 * до первого захода в CMS.
 */
export async function SiteHeader() {
  let brand = 'Vell'
  let navItems: NavItem[] = []
  let loginLabel = 'Войти'
  let registerLabel = 'Начать бесплатно'

  try {
    const payload = await getPayloadClient()
    const header = await payload.findGlobal({ slug: 'header', depth: 0 })
    brand = header?.brand || brand
    navItems = (header?.navItems as NavItem[] | null | undefined) ?? []
    loginLabel = header?.loginLabel || loginLabel
    registerLabel = header?.registerLabel || registerLabel
  } catch {
    // no-op: дефолты выше
  }

  return (
    <header className="site-header">
      <div className="wrap site-header__inner">
        <a className="site-header__brand" href="/">
          {brand}
        </a>
        <nav className="site-header__nav">
          {navItems.map((item, index) =>
            item?.href && item?.label ? (
              <a key={`${item.href}-${index}`} href={item.href}>
                {item.label}
              </a>
            ) : null,
          )}
        </nav>
        <div className="site-header__cta">
          <a className="btn btn--ghost" href={LOGIN_URL}>
            {loginLabel}
          </a>
          <a className="btn btn--primary" href={REGISTER_URL}>
            {registerLabel}
          </a>
        </div>
      </div>
    </header>
  )
}

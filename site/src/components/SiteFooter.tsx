import { getPayloadClient } from '@/lib/payload'

type FooterLink = { label?: string | null; href?: string | null }
type FooterColumn = { title?: string | null; links?: FooterLink[] | null }

/** Подвал. Контент — из global `footer`, при пустой БД просто копирайт. */
export async function SiteFooter() {
  let tagline: string | null = null
  let columns: FooterColumn[] = []
  let copyright = '© Vell'

  try {
    const payload = await getPayloadClient()
    const footer = await payload.findGlobal({ slug: 'footer', depth: 0 })
    tagline = footer?.tagline ?? null
    columns = (footer?.columns as FooterColumn[] | null | undefined) ?? []
    copyright = footer?.copyright || copyright
  } catch {
    // no-op
  }

  return (
    <footer className="site-footer">
      <div className="wrap">
        {tagline ? <p>{tagline}</p> : null}
        {columns.length > 0 ? (
          <div className="site-footer__cols">
            {columns.map((column, index) => (
              <div key={`${column.title}-${index}`}>
                <h3>{column.title}</h3>
                <ul>
                  {(column.links ?? []).map((link, linkIndex) =>
                    link?.href && link?.label ? (
                      <li key={`${link.href}-${linkIndex}`}>
                        <a href={link.href}>{link.label}</a>
                      </li>
                    ) : null,
                  )}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
        <div>{copyright}</div>
      </div>
    </footer>
  )
}

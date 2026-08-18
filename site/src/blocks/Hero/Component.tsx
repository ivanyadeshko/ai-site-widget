import { LOGIN_URL, REGISTER_URL } from '@/lib/links'

export type HeroProps = {
  badge?: string | null
  title: string
  subtitle?: string | null
  primaryLabel?: string | null
  secondaryLabel?: string | null
}

export function Hero({ badge, title, subtitle, primaryLabel, secondaryLabel }: HeroProps) {
  return (
    <section className="wrap hero">
      {badge ? <span className="hero__badge">{badge}</span> : null}
      <h1 className="hero__title">{title}</h1>
      {subtitle ? <p className="hero__subtitle">{subtitle}</p> : null}
      <div className="hero__actions">
        <a className="btn btn--primary" href={REGISTER_URL}>
          {primaryLabel || 'Начать бесплатно'}
        </a>
        {secondaryLabel ? (
          <a className="btn btn--ghost" href={LOGIN_URL}>
            {secondaryLabel}
          </a>
        ) : null}
      </div>
    </section>
  )
}

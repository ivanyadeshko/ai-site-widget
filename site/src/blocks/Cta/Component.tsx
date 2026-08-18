import { REGISTER_URL } from '@/lib/links'

export type CtaProps = {
  title: string
  subtitle?: string | null
  primaryLabel: string
}

export function Cta({ title, subtitle, primaryLabel }: CtaProps) {
  return (
    <section className="section cta">
      <div className="wrap">
        <h2 className="section__title">{title}</h2>
        {subtitle ? <p className="section__subtitle">{subtitle}</p> : null}
        <div className="hero__actions">
          <a className="btn btn--primary" href={REGISTER_URL}>
            {primaryLabel}
          </a>
        </div>
      </div>
    </section>
  )
}

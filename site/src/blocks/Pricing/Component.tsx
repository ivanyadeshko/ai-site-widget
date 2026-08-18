import { REGISTER_URL } from '@/lib/links'
import { getPayloadClient } from '@/lib/payload'

type Plan = {
  id?: string | null
  name: string
  description?: string | null
  priceNote: string
  isHighlighted?: boolean | null
  features?: { id?: string | null; text: string }[] | null
  ctaLabel: string
}

/**
 * Карточки тарифов. Данные — из global `pricing` (единственная точка правды
 * по ценам). Пустой/недоступный global = секция не рисуется вовсе: пустая
 * рамка «тарифы» хуже её отсутствия.
 */
export async function Pricing() {
  let title = ''
  let subtitle: string | null = null
  let note: string | null = null
  let plans: Plan[] = []

  try {
    const payload = await getPayloadClient()
    const pricing = await payload.findGlobal({ slug: 'pricing', depth: 0 })
    title = pricing?.title ?? ''
    subtitle = pricing?.subtitle ?? null
    note = pricing?.note ?? null
    plans = (pricing?.plans as Plan[] | null | undefined) ?? []
  } catch {
    return null
  }

  if (plans.length === 0) return null

  return (
    <section className="section" id="pricing">
      <div className="wrap">
        <h2 className="section__title">{title}</h2>
        {subtitle ? <p className="section__subtitle">{subtitle}</p> : null}
        <div className="plans">
          {plans.map((plan, index) => (
            <article
              className={`plan${plan.isHighlighted ? ' plan--highlighted' : ''}`}
              key={plan.id ?? index}
            >
              <h3 className="plan__name">{plan.name}</h3>
              <div className="plan__price">{plan.priceNote}</div>
              {plan.description ? <p className="card__text">{plan.description}</p> : null}
              {plan.features && plan.features.length > 0 ? (
                <ul className="plan__features">
                  {plan.features.map((feature, featureIndex) => (
                    <li key={feature.id ?? featureIndex}>{feature.text}</li>
                  ))}
                </ul>
              ) : null}
              <a className="btn btn--primary" href={REGISTER_URL}>
                {plan.ctaLabel}
              </a>
            </article>
          ))}
        </div>
        {note ? <p className="section__subtitle">{note}</p> : null}
      </div>
    </section>
  )
}

export type HowItWorksProps = {
  title: string
  subtitle?: string | null
  steps?: { id?: string | null; title: string; text: string }[] | null
}

export function HowItWorks({ title, subtitle, steps }: HowItWorksProps) {
  return (
    <section className="section" id="how">
      <div className="wrap">
        <h2 className="section__title">{title}</h2>
        {subtitle ? <p className="section__subtitle">{subtitle}</p> : null}
        <ol className="steps">
          {(steps ?? []).map((step, index) => (
            <li key={step.id ?? index}>
              <h3 className="card__title">{step.title}</h3>
              <p className="card__text">{step.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

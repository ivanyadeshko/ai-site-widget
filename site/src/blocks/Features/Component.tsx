export type FeaturesProps = {
  title: string
  subtitle?: string | null
  items?: { id?: string | null; title: string; text: string }[] | null
}

export function Features({ title, subtitle, items }: FeaturesProps) {
  return (
    <section className="section" id="features">
      <div className="wrap">
        <h2 className="section__title">{title}</h2>
        {subtitle ? <p className="section__subtitle">{subtitle}</p> : null}
        <div className="cards">
          {(items ?? []).map((item, index) => (
            <article className="card" key={item.id ?? index}>
              <h3 className="card__title">{item.title}</h3>
              <p className="card__text">{item.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

export type FaqProps = {
  title: string
  items?: { id?: string | null; question: string; answer: string }[] | null
}

export function Faq({ title, items }: FaqProps) {
  return (
    <section className="section" id="faq">
      <div className="wrap">
        <h2 className="section__title">{title}</h2>
        <div>
          {(items ?? []).map((item, index) => (
            <div className="faq__item" key={item.id ?? index}>
              <h3 className="faq__q">{item.question}</h3>
              <p className="faq__a">{item.answer}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

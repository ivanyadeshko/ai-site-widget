import type { Metadata } from 'next'
import { RichText } from '@payloadcms/richtext-lexical/react'
import type { SerializedEditorState } from '@payloadcms/richtext-lexical/lexical'
import { PageBlocks } from '@/lib/blockRenderer'
import { REGISTER_URL } from '@/lib/links'
import { findPageBySlug } from '@/lib/pages'

// Страницы читают Payload в рантайме — `next build` не должен требовать живую БД.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const page = await findPageBySlug('home')
  if (!page?.seo) return {}
  return {
    title: page.seo.title || undefined,
    description: page.seo.description || undefined,
  }
}

export default async function HomePage() {
  const page = await findPageBySlug('home')

  // Пустая БД (стенд поднят, сид не прогоняли) — отдаём 200 с приглашением,
  // а не 404: `/` — это то, что первым дёргают мониторинг и человек.
  if (!page) {
    return (
      <section className="wrap hero">
        <h1 className="hero__title">Vell</h1>
        <p className="hero__subtitle">
          Лендинг ещё не наполнен. Контент заводится в CMS на /admin.
        </p>
        <div className="hero__actions">
          <a className="btn btn--primary" href={REGISTER_URL}>
            Перейти в кабинет
          </a>
        </div>
      </section>
    )
  }

  if (page.layout && page.layout.length > 0) {
    return <PageBlocks layout={page.layout} />
  }

  return (
    <article className="wrap section prose">
      <h1 className="section__title">{page.title}</h1>
      {page.content ? <RichText data={page.content as SerializedEditorState} /> : null}
    </article>
  )
}

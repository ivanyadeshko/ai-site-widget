import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { RichText } from '@payloadcms/richtext-lexical/react'
import type { SerializedEditorState } from '@payloadcms/richtext-lexical/lexical'
import { PageBlocks } from '@/lib/blockRenderer'
import { findPageBySlug } from '@/lib/pages'

export const dynamic = 'force-dynamic'

type Args = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Args): Promise<Metadata> {
  const { slug } = await params
  const page = await findPageBySlug(slug)
  if (!page) return {}
  return {
    title: page.seo?.title || page.title,
    description: page.seo?.description || undefined,
  }
}

export default async function SlugPage({ params }: Args) {
  const { slug } = await params
  // `home` живёт на `/` — второй URL той же страницы плодил бы дубли в выдаче.
  if (slug === 'home') notFound()

  const page = await findPageBySlug(slug)
  if (!page) notFound()

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

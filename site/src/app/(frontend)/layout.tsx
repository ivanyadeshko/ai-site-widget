import type { Metadata } from 'next'
import '../globals.css'
import { SiteFooter } from '@/components/SiteFooter'
import { SiteHeader } from '@/components/SiteHeader'
import { SITE_URL } from '@/lib/links'

export const metadata: Metadata = {
  // База для относительных canonical/og:image. Без неё Next отдаёт
  // относительные пути и ломает соц-превью.
  ...(SITE_URL ? { metadataBase: new URL(SITE_URL) } : {}),
  title: 'Vell — голосовой AI-агент для вашего сайта',
  description:
    'Виджет, который разговаривает с посетителями сайта голосом и в чате, отвечает на вопросы и оставляет вам лид.',
}

export default async function FrontendLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  )
}

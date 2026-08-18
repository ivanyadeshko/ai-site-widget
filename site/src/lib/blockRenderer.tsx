import type { Page } from '@/payload-types'
import { Cta } from '@/blocks/Cta/Component'
import { Faq } from '@/blocks/Faq/Component'
import { Features } from '@/blocks/Features/Component'
import { Hero } from '@/blocks/Hero/Component'
import { HowItWorks } from '@/blocks/HowItWorks/Component'
import { Pricing } from '@/blocks/Pricing/Component'

type LayoutBlock = NonNullable<Page['layout']>[number]

/**
 * Рендер Layout Builder'а. Неизвестный blockType молча пропускается: контент
 * может пережить релиз, в котором блок ещё/уже не существует, и страница
 * обязана остаться на ногах.
 */
export function PageBlocks({ layout }: { layout?: LayoutBlock[] | null }) {
  return (
    <>
      {(layout ?? []).map((block, index) => {
        const key = block.id ?? `${block.blockType}-${index}`
        switch (block.blockType) {
          case 'hero':
            return (
              <Hero
                key={key}
                badge={block.badge}
                title={block.title}
                subtitle={block.subtitle}
                primaryLabel={block.primaryLabel}
                secondaryLabel={block.secondaryLabel}
              />
            )
          case 'features':
            return (
              <Features key={key} title={block.title} subtitle={block.subtitle} items={block.items} />
            )
          case 'how-it-works':
            return (
              <HowItWorks key={key} title={block.title} subtitle={block.subtitle} steps={block.steps} />
            )
          case 'pricing':
            return <Pricing key={key} />
          case 'faq':
            return <Faq key={key} title={block.title} items={block.items} />
          case 'cta':
            return (
              <Cta
                key={key}
                title={block.title}
                subtitle={block.subtitle}
                primaryLabel={block.primaryLabel}
              />
            )
          default:
            return null
        }
      })}
    </>
  )
}

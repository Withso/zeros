import { Nav } from '../components/Nav'
import { ProductPreview } from '../components/ProductPreview'
import { HeroRoleCycle } from '../components/HeroRoleCycle'
import { BrandLockup } from '../components/BrandLockup'
import '../components/hero-ascii-clouds.css'

export function HomePage() {
  return (
    <div className="home-ascii-page relative flex min-h-screen flex-col overflow-x-hidden">
      <Nav flush />

      <main className="flex flex-1 flex-col">
        <Hero />
      </main>

      <footer
        className="flex justify-center px-5 py-16 sm:px-8 sm:py-20 lg:px-10"
        aria-label="Zeros"
        data-home-mark=""
      >
        <BrandLockup size="md" wordmark={false} />
      </footer>
    </div>
  )
}

/* ─────────────────────────── Hero ─────────────────────────── */

function Hero() {
  return (
    <section className="mx-auto w-full max-w-[1240px] px-5 sm:px-8 lg:px-10">
      <div className="hero-copy">
        <h1
          className="text-left text-[36px] leading-[1.08] font-medium tracking-[-0.03em] text-fg1 sm:text-[52px] lg:text-[60px]"
          aria-label="Human-agent interaction for builders, developers, and designers"
        >
          <span className="block" aria-hidden>
            Human-agent interaction
          </span>
          <span className="mt-[0.12em] block whitespace-nowrap" aria-hidden>
            for <HeroRoleCycle />
          </span>
        </h1>
        <p className="mt-5 max-w-[42ch] text-left text-[15px] leading-relaxed text-fg2 sm:text-[17px]">
          Run a team of coding & design agents
        </p>
      </div>
      <div className="hero-product" data-hero-product="">
        <ProductPreview />
      </div>
    </section>
  )
}

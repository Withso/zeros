import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'
import { ProductPreview } from '../components/ProductPreview'
import { HeroRoleCycle } from '../components/HeroRoleCycle'
import { HeroAsciiClouds } from '../components/HeroAsciiClouds'

export function HomePage() {
  return (
    <div className="home-ascii-page relative isolate flex min-h-screen flex-col overflow-x-hidden">
      <HeroAsciiClouds />
      <Nav flush />

      <main className="relative z-10 flex-1">
        <Hero />
        {/* Holding space for the next homepage section. */}
        <div className="h-28 sm:h-36 lg:h-44" aria-hidden />
      </main>

      <div className="relative z-10">
        <Footer />
      </div>
    </div>
  )
}

/* ─────────────────────────── Hero ─────────────────────────── */

function Hero() {
  return (
    <section className="mx-auto w-full max-w-[1240px] px-5 pt-16 sm:px-8 sm:pt-20 lg:px-10 lg:pt-24">
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
      <div className="mt-10 sm:mt-14">
        <ProductPreview />
      </div>
    </section>
  )
}

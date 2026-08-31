import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'
import { ProductPreview } from '../components/ProductPreview'
import { HeroRoleCycle } from '../components/HeroRoleCycle'
import { HeroAsciiClouds } from '../components/HeroAsciiClouds'

export function HomePage() {
  return (
    <div className="home-ascii-page relative isolate flex min-h-screen flex-col overflow-x-hidden">
      <section className="hero-stage">
        <HeroAsciiClouds />
        <Nav flush />

        <main className="relative z-10 flex flex-1 flex-col">
          <Hero />
        </main>
      </section>

      <div className="relative z-10">
        <Footer />
      </div>
    </div>
  )
}

/* ─────────────────────────── Hero ─────────────────────────── */

function Hero() {
  return (
    <section className="mx-auto flex w-full max-w-[1240px] flex-1 flex-col px-5 pt-32 sm:px-8 sm:pt-40 lg:px-10 lg:pt-[22vh]">
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
      <div className="hero-product-peek" data-hero-product-peek="">
        <ProductPreview />
      </div>
    </section>
  )
}

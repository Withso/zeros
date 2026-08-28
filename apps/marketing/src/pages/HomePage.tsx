import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'
import { ProductPreview } from '../components/ProductPreview'

export function HomePage() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-x-hidden">
      <BackgroundGlow />
      <Nav />

      <main className="flex-1">
        <Hero />
        {/* Holding space for the next homepage section. */}
        <div className="h-28 sm:h-36 lg:h-44" aria-hidden />
      </main>

      <Footer />
    </div>
  )
}

/* ─────────────────────────── Hero ─────────────────────────── */

function Hero() {
  return (
    <section className="mx-auto w-full max-w-[1240px] px-5 pt-16 sm:px-8 sm:pt-20 lg:px-10 lg:pt-24">
      <h1 className="text-left text-[40px] leading-[1.08] font-medium tracking-[-0.03em] text-fg1 sm:text-[56px] lg:text-[68px]">
        <span className="block">Human-agent interaction</span>
        <span className="block">for builders</span>
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

/* ─────────────────────────── Background ─────────────────────────── */

function BackgroundGlow() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(900px 520px at 50% -10%, color-mix(in srgb, var(--fg1) 8%, transparent), transparent 60%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.04]"
        style={{
          backgroundImage:
            'radial-gradient(color-mix(in srgb, var(--fg1) 60%, transparent) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          maskImage:
            'radial-gradient(ellipse 80% 50% at 50% 0%, black, transparent 70%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 50% at 50% 0%, black, transparent 70%)',
        }}
      />
    </>
  )
}

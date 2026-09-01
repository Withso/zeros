import { useLayoutEffect, useState } from 'react'
import { Nav } from '../components/Nav'
import { ProductPreview } from '../components/ProductPreview'
import { HeroRoleCycle } from '../components/HeroRoleCycle'
import { BrandLockup } from '../components/BrandLockup'
import '../components/home-page.css?v=desktop-rect'

export function HomePage() {
  return (
    <div className="home-page relative flex min-h-screen flex-col overflow-x-hidden">
      <Nav flush />

      <main className="flex flex-1 flex-col">
        <Hero />
      </main>

      <footer
        className="flex justify-center px-5 py-16 sm:px-8 sm:py-20 lg:px-12"
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
  const [copyMinHeight, setCopyMinHeight] = useState<string>()

  useLayoutEffect(() => {
    const apply = () => {
      const page = document.querySelector('.home-page') as HTMLElement | null
      const fit = document.querySelector('[data-hero-fit]') as HTMLElement | null
      const styles = page ? getComputedStyle(page) : null
      const peek = styles
        ? Number.parseFloat(styles.getPropertyValue('--hero-peek')) || 0.52
        : 0.52
      const native =
        styles
          ? Number.parseFloat(styles.getPropertyValue('--hero-preview-w')) ||
            1100
          : 1100
      const viewport = window.visualViewport?.height ?? window.innerHeight
      const copyFloor = 13 * 16
      setCopyMinHeight(
        `${Math.max(copyFloor, viewport - 64 - peek * viewport)}px`,
      )
      const scaleEl = document.querySelector(
        '[data-hero-scale]',
      ) as HTMLElement | null
      if (scaleEl && fit && fit.clientWidth > 0) {
        scaleEl.style.setProperty(
          '--hero-product-scale',
          String(Math.min(1, fit.clientWidth / native)),
        )
      }
    }

    apply()
    const fitEl = document.querySelector('[data-hero-fit]')
    const observer =
      fitEl && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(apply)
        : null
    if (fitEl && observer) observer.observe(fitEl)
    window.addEventListener('resize', apply)
    window.visualViewport?.addEventListener('resize', apply)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', apply)
      window.visualViewport?.removeEventListener('resize', apply)
    }
  }, [])

  return (
    <section
      className="hero-fold mx-auto w-full max-w-[1320px] px-5 sm:px-8 lg:px-12"
      data-hero-fold=""
    >
      <div
        className="hero-copy"
        data-hero-copy=""
        style={copyMinHeight ? { minHeight: copyMinHeight } : undefined}
      >
        <h1
          className="text-left text-[40px] leading-[1.08] font-medium tracking-[-0.03em] text-fg1 sm:text-[54px] lg:text-[64px]"
          aria-label="Human-agent interaction for builders, developers, and designers"
        >
          <span className="block" aria-hidden>
            Human-agent interaction
          </span>
          <span className="mt-[0.08em] block whitespace-nowrap" aria-hidden>
            for <HeroRoleCycle />
          </span>
        </h1>
        <p className="mt-3.5 max-w-[42ch] text-left text-[15px] leading-relaxed text-fg2 sm:mt-4 sm:text-[17px]">
          Run a team of coding & design agents
        </p>
      </div>
      <div className="hero-product" data-hero-product="">
        <div className="hero-horizon" aria-hidden />
        <div className="hero-product-fit" data-hero-fit="">
          <div className="hero-product-scale" data-hero-scale="">
            <ProductPreview />
          </div>
        </div>
      </div>
    </section>
  )
}

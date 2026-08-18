import { ArrowRight } from 'lucide-react'
import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'
import { ProductPreview } from '../components/ProductPreview'
import { DownloadButton } from '../components/DownloadButton'
import { AgentLogoImg, type AgentName } from '../components/AgentLogos'
import { CURRENT_VERSION, DOWNLOAD_META } from '../lib/site'

export function HomePage() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-x-hidden">
      <BackgroundGlow />
      <Nav />

      <main className="flex-1">
        <Hero />
        <ProductSection />
        <AgentsStrip />
        <FinalCTA />
      </main>

      <Footer />
    </div>
  )
}

/* ─────────────────────────── Hero ─────────────────────────── */

function Hero() {
  return (
    <section className="mx-auto w-full max-w-[1240px] px-5 pt-20 pb-4 text-center sm:px-8 sm:pt-28 lg:px-10 lg:pt-32">
      <a
        href="/changelog"
        className="group inline-flex items-center gap-2 rounded-full border border-border2 bg-bg2 px-3.5 py-1.5 text-[12.5px] text-fg2 transition-colors hover:border-border3 hover:text-fg1"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_6px_var(--success)]" />
        Public beta — v{CURRENT_VERSION} is live
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </a>

      <h1 className="mx-auto mt-7 max-w-[16ch] text-[40px] leading-[1.05] font-medium tracking-[-0.03em] text-balance text-fg1 sm:text-[56px] lg:text-[68px]">
        Design and code, <span className="text-fg3">in parallel.</span>
      </h1>

      <div className="mt-9 flex flex-col items-center gap-4">
        <DownloadButton size="lg" />
        <span className="text-[12px] tracking-tight text-fg3">{DOWNLOAD_META}</span>
      </div>
    </section>
  )
}

function ProductSection() {
  return (
    <section className="mx-auto mt-10 w-full max-w-[1240px] px-5 sm:mt-14 sm:px-8 lg:px-10">
      <div className="mb-5 flex justify-center sm:mb-6">
        <ModeToggle />
      </div>
      <ProductPreview />
    </section>
  )
}

/**
 * Dev / Design segmented toggle shown above the product window.
 * Dev is the active surface; Design is disabled until design mode ships.
 */
function ModeToggle() {
  return (
    <div
      role="tablist"
      aria-label="Workspace mode"
      className="inline-flex items-center gap-1 rounded-full border border-border3 bg-bg2 p-1"
    >
      <span
        role="tab"
        aria-selected="true"
        className="rounded-full bg-bg3 px-4 py-1.5 text-[13px] font-medium text-fg1"
      >
        Dev
      </span>
      <span
        role="tab"
        aria-selected="false"
        aria-disabled="true"
        title="Design mode — coming soon"
        className="flex cursor-not-allowed items-center gap-1.5 rounded-full px-4 py-1.5 text-[13px] text-fg3"
      >
        Design
        <span className="rounded-full border border-border3 px-1.5 py-px text-[9px] font-medium tracking-wide text-fg3 uppercase">
          Soon
        </span>
      </span>
    </div>
  )
}

/* ─────────────────────────── Agents strip ─────────────────────────── */

const AGENTS: { name: AgentName; label: string }[] = [
  { name: 'Codex', label: 'Codex' },
  { name: 'Claude', label: 'Claude' },
  { name: 'Cursor', label: 'Cursor' },
]

function AgentsStrip() {
  return (
    <section className="mx-auto w-full max-w-[1240px] px-5 pt-20 sm:px-8 sm:pt-28 lg:px-10">
      <p className="text-center text-[12.5px] font-medium tracking-wide text-fg3 uppercase">
        Bring your own agents
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
        {AGENTS.map((a) => (
          <div key={a.label} className="flex items-center gap-2.5">
            <AgentLogoImg name={a.name} className="h-5 w-5 object-contain opacity-90" />
            <span className="text-[15px] font-medium text-fg2">{a.label}</span>
          </div>
        ))}
        <span className="text-[15px] text-fg3">+ more</span>
      </div>
      <p className="mx-auto mt-6 max-w-[48ch] text-center text-[13.5px] leading-relaxed text-fg3">
        Your models, your keys, your machine. Sign in with the agents you already
        use — nothing runs in our cloud.
      </p>
    </section>
  )
}

/* ─────────────────────────── Final CTA ─────────────────────────── */

function FinalCTA() {
  return (
    <section className="mx-auto w-full max-w-[1240px] px-5 pt-28 pb-24 sm:px-8 sm:pt-36 lg:px-10">
      <div className="relative overflow-hidden rounded-3xl px-6 py-16 text-center sm:py-20">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(60% 120% at 50% 0%, rgba(255,255,255,0.06), transparent 70%)',
          }}
        />
        <h2 className="mx-auto max-w-[18ch] text-[32px] leading-[1.1] font-medium tracking-[-0.025em] text-balance text-fg1 sm:text-[44px]">
          Start shipping in parallel.
        </h2>
        <p className="mx-auto mt-4 max-w-[52ch] text-[15px] leading-[1.6] text-fg2">
          Download Zeros and put a fleet of agents to work — on your Mac, on your
          terms.
        </p>
        <div className="mt-9 flex flex-col items-center gap-4">
          <DownloadButton size="lg" />
          <span className="text-[12px] tracking-tight text-fg3">{DOWNLOAD_META}</span>
        </div>
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
            'radial-gradient(900px 520px at 50% -10%, rgba(255,255,255,0.06), transparent 60%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.04]"
        style={{
          backgroundImage:
            'radial-gradient(rgba(255,255,255,0.6) 1px, transparent 1px)',
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

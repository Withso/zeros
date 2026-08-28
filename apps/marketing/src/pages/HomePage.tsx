import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'
import { ProductPreview } from '../components/ProductPreview'
import { DownloadButton } from '../components/DownloadButton'
import { AgentLogoImg, type AgentName } from '../components/AgentLogos'
import { DOWNLOAD_META } from '../lib/site'

export function HomePage() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-x-hidden">
      <BackgroundGlow />
      <Nav />

      <main className="flex-1">
        <Hero />
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
              'radial-gradient(60% 120% at 50% 0%, color-mix(in srgb, var(--fg1) 8%, transparent), transparent 70%)',
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

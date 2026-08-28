import { type ReactNode } from 'react'
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDollarSign,
  Copy,
  Ellipsis,
  FileCode,
  FileEdit,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Github,
  Globe,
  Home,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Plus,
  Search,
  Shield,
  Terminal,
  Zap,
} from 'lucide-react'
import { AgentLogoImg } from './AgentLogos'

/**
 * Hero product showpiece — the live Zeros conversation: chat streaming
 * (composer, tool rows, summary chip, turn footer) plus a floating inspector
 * on the right. Chrome matches styles/zeros-tokens.css (Neutral Dark + Light)
 * and the real shell in apps/desktop/src/renderer/features/agent/*.
 */
export function ProductPreview() {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-10 -inset-y-12 -z-10 rounded-[40px] blur-2xl"
        style={{
          background:
            'radial-gradient(60% 60% at 50% 30%, color-mix(in srgb, var(--fg1) 6%, transparent), transparent 70%)',
        }}
      />

      <div
        className="relative overflow-hidden rounded-lg border border-border2 bg-bg1 shadow-[var(--shadow-product)]"
        aria-label="Zeros workspace preview"
      >
        <TopBar />

        <div className="relative overflow-x-auto lg:overflow-x-visible">
          <div className="relative h-[560px] min-w-[980px] sm:h-[620px] lg:h-[680px] lg:min-w-0">
            <ChatPane />
            <FloatingInspector />
          </div>

          <div
            aria-hidden
            className="pointer-events-none absolute top-0 right-0 bottom-0 w-10 bg-gradient-to-l from-bg1 to-transparent lg:hidden"
          />
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────── Top bar ─────────────────────────── */

function TopBar() {
  return (
    <header className="box-content flex h-10 w-full shrink-0 items-center overflow-hidden border-b border-border1 bg-sidebar-bg">
      <div
        className="flex h-full w-[85px] shrink-0 items-center gap-2 border-r border-border1 px-3.5"
        aria-hidden
      >
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </div>

      <div className="flex h-full shrink-0 items-center border-r border-border1 px-1">
        <IconBtn>
          <Home className="size-4" strokeWidth={1.5} />
        </IconBtn>
      </div>

      <div className="flex h-full min-w-0 flex-1 items-center border-r border-border1 px-1">
        <button
          type="button"
          tabIndex={-1}
          className="flex h-7 w-[clamp(100px,calc(10vw_+_20px),140px)] min-w-[100px] max-w-[140px] shrink-0 items-center justify-start gap-2 rounded-sm px-2 text-xs text-fg2"
        >
          <span className="inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-bg2-hover">
            <img
              src="/zeros-logo.svg"
              alt=""
              className="size-2.5 object-contain opacity-90 invert dark:invert-0"
              draggable={false}
            />
          </span>
          <span className="min-w-0 truncate font-medium">0docs</span>
          <ChevronDown className="size-3 shrink-0 text-fg3" strokeWidth={1.5} />
        </button>
      </div>
    </header>
  )
}

function IconBtn({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-fg2">
      {children}
    </span>
  )
}

/* ─────────────────────────── Chat ─────────────────────────── */

function ChatPane() {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-bg1">
      <ChatTabStrip />
      <StreamingTranscript />
      <Composer placeholder='Type your message... "/" for commands, "@" for files' />
    </section>
  )
}

function ChatTabStrip() {
  return (
    <div className="flex h-11 shrink-0 items-center overflow-hidden">
      <div className="flex h-full shrink-0 items-center pl-2">
        <span className="inline-flex size-7 items-center justify-center rounded-sm text-fg2">
          <MessageSquare className="size-3.5" strokeWidth={1.5} />
        </span>
      </div>
      <div className="relative flex h-full min-w-0 flex-1 items-center overflow-hidden px-1">
        <span
          data-active
          className="relative flex h-7 min-w-[70px] max-w-[180px] shrink-0 items-center gap-2 overflow-hidden rounded-sm bg-bg2 px-2 text-left text-xs font-medium text-fg1"
        >
          <AgentLogoImg name="Claude" className="size-3 shrink-0 object-contain" />
          <span className="min-w-0 truncate leading-none">Homepage restyle</span>
        </span>
        <span className="ml-1 inline-flex size-7 items-center justify-center rounded-sm text-fg2">
          <Plus className="size-3.5" strokeWidth={1.5} />
        </span>
      </div>
      <div className="flex h-full shrink-0 items-center pr-2">
        <span className="inline-flex size-7 items-center justify-center rounded-sm text-fg2">
          <Ellipsis className="size-3.5" strokeWidth={1.5} />
        </span>
      </div>
    </div>
  )
}

function StreamingTranscript() {
  return (
    <div className="mx-auto flex w-full max-w-[1152px] min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-hidden pt-3 pr-[300px] pb-3 pl-7">
      <SettledSummaryChip />

      <div className="flex max-w-[768px] flex-col gap-2.5 self-start text-sm leading-relaxed text-fg1">
        <p>
          Ready in{' '}
          <code className="rounded-sm bg-bg2 px-1 py-0.5 font-mono text-xs text-fg1">
            0docs
          </code>
          . What should we ship?
        </p>
        <TurnFooter duration="5s" />
      </div>

      <UserBubble>
        Restyle the homepage after Linear — left tagline, chat plus inspector.
      </UserBubble>

      <div className="flex max-w-[768px] flex-col self-start">
        <EventRow
          icon={<FileText strokeWidth={1.75} />}
          label="Read 86 lines"
          targetFile="HomePage.tsx"
        />
        <EventRow
          icon={<Search strokeWidth={1.75} />}
          label="Grep"
          target="text-center"
          trailing="3 matches"
        />
        <EventRow
          icon={<Terminal strokeWidth={1.75} />}
          label="Check marketing types"
          target="pnpm --dir apps/marketing typecheck"
        />
        <EventRow
          icon={<FileEdit strokeWidth={1.75} />}
          label="Edit"
          targetFile="ProductPreview.tsx"
          trailingNode={
            <span className="shrink-0 text-xs tabular-nums">
              <span className="text-green-primary">+81</span>
              <span className="text-red-primary ml-1">−13</span>
            </span>
          }
        />
        <p className="mt-2 text-sm leading-relaxed text-fg1">
          Dropping the hero download and Dev/Design toggle, left-aligning the
          tagline, and replacing the three-pane mock with chat streaming plus
          the inspector.
          <span
            aria-hidden
            className="ml-0.5 inline-block h-[0.9em] w-px translate-y-[0.12em] bg-fg1"
          />
        </p>
        <AgentWorking duration="12s" />
      </div>
    </div>
  )
}

function SettledSummaryChip() {
  return (
    <div className="-ml-1 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-1 py-1">
      <ChevronRight className="size-3 shrink-0 text-fg2" strokeWidth={1.75} />
      <span className="min-w-0 truncate text-sm text-fg2">
        3 tool calls, 1 message
      </span>
      <FileText className="size-3 shrink-0 text-fg2" strokeWidth={1.75} />
      <Terminal className="size-3 shrink-0 text-fg2" strokeWidth={1.75} />
      <Globe className="size-3 shrink-0 text-fg2" strokeWidth={1.75} />
    </div>
  )
}

function EventRow({
  icon,
  label,
  target,
  targetFile,
  trailing,
  trailingNode,
}: {
  icon: ReactNode
  label: string
  target?: string
  targetFile?: string
  trailing?: string
  trailingNode?: ReactNode
}) {
  return (
    <div className="-ml-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left">
      <span
        className="inline-flex size-3 shrink-0 items-center justify-center text-fg2 [&_svg]:size-3"
        aria-hidden
      >
        {icon}
      </span>
      <span className="max-w-[60ch] shrink-0 truncate text-sm text-fg1">
        {label}
      </span>
      {targetFile ? (
        <FileTag name={targetFile} />
      ) : target ? (
        <span className="max-w-[440px] min-w-0 truncate rounded-sm bg-bg1-hover px-1.5 py-0.5 text-xs text-fg2">
          {target}
        </span>
      ) : null}
      {trailingNode ??
        (trailing ? (
          <span className="shrink-0 text-xs text-fg2 tabular-nums">
            {trailing}
          </span>
        ) : null)}
    </div>
  )
}

function FileTag({ name }: { name: string }) {
  return (
    <span className="inline-flex h-5 min-w-0 max-w-[440px] items-center gap-1.5 rounded-sm border border-border3 bg-bg1 px-1.5 text-xs text-fg2">
      <FileCode className="size-[13px] shrink-0" strokeWidth={1.5} />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  )
}

function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="w-fit max-w-[768px] rounded-sm border border-border1 bg-highlighted-bg px-3 py-2 text-sm leading-relaxed text-fg1">
        {children}
      </div>
    </div>
  )
}

function TurnFooter({ duration }: { duration: string }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs text-fg2">
      <span className="tabular-nums">{duration}</span>
      <span className="inline-flex size-5 items-center justify-center rounded-sm text-fg2">
        <CircleDollarSign className="size-3.5" strokeWidth={1.5} />
      </span>
      <span className="inline-flex size-5 items-center justify-center rounded-sm text-fg2">
        <Copy className="size-3.5" strokeWidth={1.5} />
      </span>
      <span className="inline-flex size-5 items-center justify-center rounded-sm text-fg2">
        <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
      </span>
    </div>
  )
}

/** Static stand-in for ActivityShimmer — 4×4 rest grid + lit tetromino. */
function AgentWorking({ duration }: { duration: string }) {
  const lit = new Set([0, 1, 5, 9])
  return (
    <div
      className="flex items-center gap-2 py-1.5 text-xs text-fg2"
      role="status"
    >
      <span
        className="inline-grid size-4 shrink-0 grid-cols-4 grid-rows-4"
        aria-hidden
      >
        {Array.from({ length: 16 }, (_, i) => (
          <span
            key={i}
            className="place-self-center size-[3px] rounded-full"
            style={{
              background: lit.has(i) ? 'var(--fg2)' : 'var(--muted-fg)',
              opacity: lit.has(i) ? 0.7 : 0.28,
            }}
          />
        ))}
      </span>
      <span className="tabular-nums">{duration}</span>
    </div>
  )
}

function Composer({ placeholder }: { placeholder: string }) {
  return (
    <div className="mx-auto w-full max-w-[1152px] shrink-0 pr-[300px] pb-3 pl-7">
      <div className="relative flex w-full min-w-0 flex-col rounded-lg border border-border1 bg-bg2 px-3.5 py-3">
        <div className="min-h-[20px] text-sm leading-relaxed text-muted-fg">
          {placeholder}
        </div>
        <div className="flex min-w-0 items-center justify-between gap-1.5 pt-1 pr-0 pb-1 pl-0">
          <div className="flex min-w-0 items-center gap-0.5">
            <span className="inline-flex size-7 items-center justify-center rounded-md text-fg2">
              <Plus className="size-3.5" strokeWidth={1.5} />
            </span>
            <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-fg2">
              <AgentLogoImg name="Claude" className="size-3 object-contain" />
              Opus 4.8
            </span>
            <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-fg2">
              <Zap className="size-3" strokeWidth={1.5} />
              High
            </span>
            <span className="inline-flex size-7 items-center justify-center rounded-md text-fg2">
              <Shield className="size-3.5" strokeWidth={1.5} />
            </span>
          </div>
          <span className="inline-flex size-8 items-center justify-center rounded-sm bg-primary-button-bg text-primary-button-fg">
            <ArrowUp className="size-3.5" strokeWidth={2.25} />
          </span>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────── Floating inspector ─────────────────────────── */

function FloatingInspector() {
  return (
    <aside
      className="absolute top-[88px] right-4 bottom-4 z-10 flex w-[272px] flex-col overflow-hidden rounded-lg border border-border2 bg-bg3 shadow-[var(--shadow-dropdown)]"
      aria-label="Session inspector"
    >
      <InspectorSection title="Environment">
        <InspectorRow
          icon={<FileEdit className="size-3.5" strokeWidth={1.5} />}
          label="Changes"
          trailing={
            <span className="text-xs tabular-nums">
              <span className="text-green-primary">+81</span>
              <span className="text-red-primary ml-1">−13</span>
            </span>
          }
        />
        <InspectorRow
          icon={<FolderGit2 className="size-3.5" strokeWidth={1.5} />}
          label="Worktree"
          trailing={<ChevronDown className="size-3 text-fg3" strokeWidth={1.5} />}
        />
        <InspectorRow
          icon={<GitBranch className="size-3.5" strokeWidth={1.5} />}
          label="feat/homepage-hero"
          trailing={<ChevronDown className="size-3 text-fg3" strokeWidth={1.5} />}
        />
        <InspectorRow
          icon={<Circle className="size-3.5" strokeWidth={1.5} />}
          label="Commit or push"
          muted
        />
        <InspectorRow
          icon={<GitCommitHorizontal className="size-3.5" strokeWidth={1.5} />}
          label="Left-align homepage hero"
          trailing={
            <span className="inline-flex items-center gap-1 text-fg2">
              <Github className="size-3.5" strokeWidth={1.5} />
            </span>
          }
        />
      </InspectorSection>

      <InspectorSection title="Browser" action={null}>
        <InspectorRow
          icon={<Monitor className="size-3.5" strokeWidth={1.5} />}
          label="Picture in Picture"
          trailing={<span className="text-xs text-fg3">Hide</span>}
        />
      </InspectorSection>

      <InspectorSection title="Sources">
        <InspectorRow
          icon={<FileText className="size-3.5" strokeWidth={1.5} />}
          label="HomePage.tsx"
        />
        <InspectorRow
          icon={<FileText className="size-3.5" strokeWidth={1.5} />}
          label="ProductPreview.tsx"
        />
        <InspectorRow
          icon={<FileText className="size-3.5" strokeWidth={1.5} />}
          label="BrandLockup.tsx"
        />
        <InspectorRow
          icon={<Globe className="size-3.5" strokeWidth={1.5} />}
          label="View all"
          muted
        />
      </InspectorSection>
    </aside>
  )
}

function InspectorSection({
  title,
  action = true,
  children,
}: {
  title: string
  action?: boolean | null
  children: ReactNode
}) {
  return (
    <section className="border-b border-border1 px-1.5 py-1.5 last:border-b-0">
      <div className="flex h-7 items-center justify-between px-1.5">
        <h3 className="text-xs font-medium text-fg3">{title}</h3>
        {action ? (
          <Plus className="size-3.5 text-fg3" strokeWidth={1.5} aria-hidden />
        ) : null}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

function InspectorRow({
  icon,
  label,
  trailing,
  muted,
}: {
  icon: ReactNode
  label: string
  trailing?: ReactNode
  muted?: boolean
}) {
  return (
    <div
      className={`flex h-7 min-w-0 items-center gap-2 rounded-sm px-1.5 text-xs ${
        muted ? 'text-fg3' : 'text-fg1'
      }`}
    >
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-fg2">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </div>
  )
}

import { type ReactNode } from 'react'
import {
  ArrowUp,
  ChevronDown,
  CircleDollarSign,
  Copy,
  Ellipsis,
  FileCode,
  Folder,
  Home,
  LaptopMinimal,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Shield,
  Zap,
} from 'lucide-react'
import { AgentLogoImg } from './AgentLogos'

/**
 * Hero product showpiece — faithful mock of the live Zeros shell:
 *   TopBar (traffic reserve · Home · project · main · workspace tabs · +)
 *   Column 2 — split chat panes (active thread | stacked ready sessions)
 *   Column 3 — files/editor (row 1) + Setup / Run / Terminal (row 2)
 *
 * Surfaces and chrome match styles/zeros-tokens.css (Zeros Shade) and
 * the real shell classes in src/shell/* + src/zeros/agent/*.
 */
export function ProductPreview() {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-10 -inset-y-12 -z-10 rounded-[40px] blur-2xl"
        style={{
          background:
            'radial-gradient(60% 60% at 50% 30%, rgba(255,255,255,0.05), transparent 70%)',
        }}
      />

      <div className="relative overflow-hidden rounded-lg border border-border2 bg-bg1 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7)]">
        <TopBar />

        <div className="relative overflow-x-auto lg:overflow-x-visible">
          <div className="flex h-[560px] min-w-[1080px] sm:h-[600px] lg:h-[640px] lg:min-w-0">
            {/* Column 2 — chat splits: active thread | stacked ready panes */}
            <div className="flex min-w-0 flex-[1.25] border-r border-border1">
              <ChatPane
                focused
                tabLabel="Friendly greeti..."
                className="min-w-0 flex-[1.15]"
              >
                <ActiveTranscript />
              </ChatPane>

              <div className="flex min-w-0 flex-1 flex-col border-l border-border1 bg-bg0">
                <ChatPane
                  tabLabel="Untitled"
                  empty
                  className="min-h-0 flex-1 border-b border-border1"
                />
                <ChatPane tabLabel="Untitled" empty className="min-h-0 flex-1" />
              </div>
            </div>

            {/* Column 3 — files/editor + Setup/Run/Terminal */}
            <WorkColumn />
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

const WORKSPACES = [
  { name: 'marketing-site', active: true },
  { name: 'auth-pages', active: false },
  { name: 'cf-pages', active: false },
  { name: 'token-system', active: false },
] as const

function TopBar() {
  return (
    <header className="box-content flex h-10 w-full shrink-0 items-center overflow-hidden border-b border-border1 bg-sidebar-bg">
      {/* Native traffic-light reserve (painted for the marketing mock). */}
      <div
        className="flex h-full w-[85px] shrink-0 items-center gap-2 border-r border-border1 px-3.5"
        aria-hidden
      >
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </div>

      <div className="flex h-full shrink-0 items-center border-r border-border1 px-1">
        <IconBtn active={false}>
          <Home className="size-4" strokeWidth={1.5} />
        </IconBtn>
      </div>

      <div className="flex h-full shrink-0 items-center border-r border-border1 px-1">
        <button
          type="button"
          tabIndex={-1}
          className="flex h-7 w-[clamp(100px,calc(10vw_+_20px),140px)] min-w-[100px] max-w-[140px] shrink-0 items-center justify-start gap-2 rounded-sm px-2 text-xs text-fg2"
        >
          <span className="inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-bg2-hover">
            <img
              src="/zeros-logo.svg"
              alt=""
              className="size-2.5 object-contain opacity-90"
              draggable={false}
            />
          </span>
          <span className="min-w-0 truncate font-medium">0docs</span>
          <ChevronDown className="size-3 shrink-0 text-fg3" strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex h-full shrink-0 items-center border-r border-border1 px-1">
        <IconBtn>
          <LaptopMinimal className="size-4" strokeWidth={1.25} />
        </IconBtn>
      </div>

      <div className="relative flex h-full min-w-0 flex-1 items-stretch overflow-hidden">
        <nav
          className="flex h-full min-w-0 items-center gap-1 overflow-hidden px-1"
          aria-label="Workspaces"
        >
          {WORKSPACES.map((ws) => (
            <span
              key={ws.name}
              data-active={ws.active || undefined}
              className="relative flex h-7 w-[clamp(120px,calc(10vw_+_40px),160px)] min-w-[120px] max-w-[160px] shrink-0 select-none items-center overflow-hidden rounded-sm px-2 text-left text-xs text-fg2 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1"
            >
              <Folder className="mr-2 size-3.5 shrink-0" strokeWidth={1.5} />
              <span className="min-w-0 truncate">{ws.name}</span>
            </span>
          ))}
        </nav>
        <div className="flex h-full shrink-0 items-center px-1">
          <IconBtn>
            <Plus className="size-4" strokeWidth={1.5} />
          </IconBtn>
        </div>
        <div className="min-w-0 flex-1" aria-hidden />
      </div>
    </header>
  )
}

function IconBtn({
  children,
  active,
}: {
  children: ReactNode
  active?: boolean
}) {
  return (
    <span
      data-active={active || undefined}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-fg2 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1"
    >
      {children}
    </span>
  )
}

/* ─────────────────────────── Chat panes ─────────────────────────── */

function ChatPane({
  tabLabel,
  focused,
  empty,
  children,
  className = '',
}: {
  tabLabel: string
  focused?: boolean
  empty?: boolean
  children?: ReactNode
  className?: string
}) {
  return (
    <section
      className={`flex min-h-0 flex-col overflow-hidden ${
        focused ? 'bg-bg1' : 'bg-bg0'
      } ${className}`}
    >
      <ChatTabStrip label={tabLabel} focused={focused} />
      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="text-fg2 flex flex-1 items-start gap-1.5 px-7 pt-3 text-xs">
            <span className="p-3">Session ready. Ask the agent anything.</span>
          </div>
          <Composer placeholder='Type your message... "/" for commands, "@" for files' />
        </div>
      ) : (
        children
      )}
    </section>
  )
}

function ChatTabStrip({
  label,
  focused,
}: {
  label: string
  focused?: boolean
}) {
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
          className="relative flex h-7 min-w-[70px] max-w-[140px] shrink-0 items-center gap-2 overflow-hidden rounded-sm bg-bg2 px-2 text-left text-xs font-medium text-fg1"
        >
          <AgentLogoImg name="Claude" className="size-3 shrink-0 object-contain" />
          <span className="min-w-0 truncate leading-none">{label}</span>
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
      {!focused && (
        <span className="sr-only">Inactive pane</span>
      )}
    </div>
  )
}

function ActiveTranscript() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1152px] min-w-0 flex-1 flex-col gap-5 overflow-hidden px-7 pt-3 pb-3">
        <UserBubble>hi</UserBubble>

        <div className="flex max-w-[768px] flex-col gap-2.5 self-start text-sm leading-relaxed text-fg1">
          <p>Hi Arun! 👋</p>
          <p>
            I&apos;m ready to help with your work in the{' '}
            <code className="rounded-sm bg-bg2 px-1 py-0.5 font-mono text-xs text-fg1">
              0docs
            </code>{' '}
            repo. What would you like to do?
          </p>
          <p>Some things I can see from the current state:</p>
          <ul className="list-disc space-y-1 pl-5 text-fg1">
            <li>
              You&apos;re on{' '}
              <code className="rounded-sm bg-bg2 px-1 py-0.5 font-mono text-xs">
                main
              </code>{' '}
              with a clean working tree
            </li>
            <li>
              Recent work has been around a marketing site + Cloudflare Pages
              setup
            </li>
          </ul>
          <p>
            Let me know what you&apos;d like to tackle — a feature, a bug, a
            review, or something else entirely.
          </p>
          <TurnFooter />
        </div>
      </div>

      <Composer placeholder='Type your message... "/" for commands, "@" for files' />
    </div>
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

function TurnFooter() {
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs text-fg2">
      <span className="tabular-nums">5s</span>
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

function Composer({ placeholder }: { placeholder: string }) {
  return (
    <div className="mx-auto w-full max-w-[1152px] shrink-0 px-7 pb-3">
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

/* ─────────────────────────── Column 3 ─────────────────────────── */

function WorkColumn() {
  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg1">
      {/* Row 1 tab strip */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border1 px-2">
        <Col3Tab active>Dockerfile</Col3Tab>
        <Col3Tab>Changes</Col3Tab>
        <Col3Tab>Review</Col3Tab>
        <span className="inline-flex size-7 items-center justify-center rounded-sm text-fg2">
          <Plus className="size-3.5" strokeWidth={1.5} />
        </span>
      </div>

      {/* Files + editor */}
      <div className="grid min-h-0 flex-1 grid-cols-[148px_minmax(0,1fr)] overflow-hidden">
        <FileTree />
        <CodeEditor />
      </div>

      {/* Row 2 — Setup / Run / Terminal (pinned height so the empty state stays visible) */}
      <div className="flex h-[200px] shrink-0 flex-col border-t border-border1">
        <div className="flex h-10 shrink-0 items-center gap-1 px-2">
          <Col3Tab active>Setup</Col3Tab>
          <Col3Tab>Run</Col3Tab>
          <Col3Tab>Terminal</Col3Tab>
          <span className="inline-flex size-7 items-center justify-center rounded-sm text-fg2">
            <Plus className="size-3.5" strokeWidth={1.5} />
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileCode className="size-10 text-muted-fg" strokeWidth={1} aria-hidden />
          <span className="inline-flex h-7 items-center rounded-sm border border-border3 bg-bg1 px-3 text-xs font-medium text-fg1">
            Add setup script
          </span>
          <p className="max-w-sm text-xs text-fg2">
            This script runs on worktree creation to install dependencies or
            environment setup.
          </p>
        </div>
      </div>
    </section>
  )
}

function Col3Tab({
  children,
  active,
}: {
  children: ReactNode
  active?: boolean
}) {
  return (
    <span
      className={`relative flex h-7 shrink-0 items-center overflow-hidden rounded-md px-2.5 text-xs font-medium ${
        active ? 'bg-bg2 text-fg1' : 'text-fg2'
      }`}
    >
      {children}
    </span>
  )
}

type TreeNode =
  | { kind: 'folder'; label: string; open?: boolean }
  | { kind: 'file'; label: string; active?: boolean }

const TREE: TreeNode[] = [
  { kind: 'folder', label: 'artifacts', open: false },
  { kind: 'folder', label: 'lib', open: false },
  { kind: 'folder', label: 'screenshots', open: false },
  { kind: 'folder', label: 'scripts', open: false },
  { kind: 'folder', label: 'site', open: false },
  { kind: 'file', label: '.env.example' },
  { kind: 'file', label: '.gitignore' },
  { kind: 'file', label: '.npmrc' },
  { kind: 'file', label: 'AGENTS.md' },
  { kind: 'file', label: 'docker-compose.yml' },
  { kind: 'file', label: 'Dockerfile', active: true },
  { kind: 'file', label: 'install.sh' },
  { kind: 'file', label: 'package.json' },
  { kind: 'file', label: 'pnpm-lock.yaml' },
]

function FileTree() {
  return (
    <div className="flex flex-col gap-0.5 overflow-hidden border-r border-border1 bg-bg1 py-2 pr-1 pl-1.5">
      <div className="mb-1.5 px-1.5">
        <div className="flex h-7 items-center rounded-sm border border-border1 bg-bg1 px-2 text-xs text-muted-fg">
          Search…
        </div>
      </div>
      {TREE.map((node) => (
        <div
          key={node.label}
          className={`flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-xs ${
            node.kind === 'file' && node.active
              ? 'bg-bg2 text-fg1'
              : 'text-fg2'
          }`}
        >
          {node.kind === 'folder' ? (
            <ChevronDown
              className={`size-3 shrink-0 text-fg3 ${node.open ? '' : '-rotate-90'}`}
              strokeWidth={1.5}
            />
          ) : (
            <span
              className={`ml-0.5 size-1.5 shrink-0 rounded-full ${
                node.active ? 'bg-fg1' : 'bg-fg3'
              }`}
            />
          )}
          <span className="min-w-0 truncate font-mono text-[12px] leading-none">
            {node.label}
          </span>
        </div>
      ))}
    </div>
  )
}

type CodeLine =
  | { n: number; kind: 'comment'; text: string }
  | { n: number; kind: 'kw'; kw: string; rest: string }
  | { n: number; kind: 'plain'; text: string }

const DOCKERFILE: CodeLine[] = [
  { n: 21, kind: 'comment', text: '# Build marketing + assemble dist' },
  { n: 22, kind: 'kw', kw: 'RUN', rest: ' pnpm --filter @workspace/api-server run build \\' },
  { n: 23, kind: 'plain', text: '  && pnpm --filter @workspace/zdocs run build \\' },
  { n: 24, kind: 'plain', text: '  && pnpm --filter @workspace/marketing run build' },
  { n: 25, kind: 'plain', text: '' },
  { n: 26, kind: 'kw', kw: 'ENV', rest: ' NODE_ENV=production' },
  { n: 27, kind: 'kw', kw: 'COPY', rest: ' --from=build /app/dist ./dist' },
  { n: 28, kind: 'kw', kw: 'COPY', rest: ' package.json pnpm-lock.yaml ./' },
  { n: 29, kind: 'plain', text: '' },
  { n: 30, kind: 'kw', kw: 'EXPOSE', rest: ' 8788' },
  { n: 31, kind: 'kw', kw: 'CMD', rest: ' ["node", "dist/server.js"]' },
  { n: 32, kind: 'plain', text: '' },
  { n: 33, kind: 'comment', text: '# Cloudflare Pages serves ASSETS + Functions' },
  { n: 34, kind: 'kw', kw: 'FROM', rest: ' node:22-alpine AS runtime' },
  { n: 35, kind: 'kw', kw: 'WORKDIR', rest: ' /app' },
  { n: 36, kind: 'kw', kw: 'COPY', rest: ' --from=build /app .' },
  { n: 37, kind: 'kw', kw: 'RUN', rest: ' pnpm install --prod --frozen-lockfile' },
  { n: 38, kind: 'plain', text: '' },
  { n: 39, kind: 'comment', text: '# Health endpoint for the Pages proxy' },
  { n: 40, kind: 'kw', kw: 'ENV', rest: ' PORT=8788' },
  { n: 41, kind: 'kw', kw: 'EXPOSE', rest: ' 8788' },
  { n: 42, kind: 'kw', kw: 'CMD', rest: ' ["pnpm", "start"]' },
]

function CodeEditor() {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden bg-bg1">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border1 px-3">
        <span className="truncate font-mono text-xs text-fg1">Dockerfile</span>
        <Copy className="size-3.5 shrink-0 text-fg3" strokeWidth={1.5} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden py-2 font-mono text-[12px] leading-[1.65]">
        {DOCKERFILE.map((line) => (
          <div key={line.n} className="flex px-3">
            <span className="w-6 shrink-0 select-none text-right text-fg3/60">
              {line.n}
            </span>
            <span className="w-3 shrink-0" />
            <span className="min-w-0 whitespace-pre">
              {line.kind === 'comment' && (
                <span style={{ color: 'var(--green-fg)' }}>{line.text}</span>
              )}
              {line.kind === 'kw' && (
                <>
                  <span style={{ color: 'var(--yellow-primary)' }}>{line.kw}</span>
                  <span className="text-fg1">{line.rest}</span>
                </>
              )}
              {line.kind === 'plain' && (
                <span className="text-fg1">{line.text}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

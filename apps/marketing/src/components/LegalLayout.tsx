import type { ReactNode } from 'react'
import { Nav } from './Nav'
import { Footer } from './Footer'

// ──────────────────────────────────────────────────────────
// LegalLayout — shared shell for /privacy and /terms
// ──────────────────────────────────────────────────────────
//
// Both legal pages are plain prose with the same measure, the same
// heading rhythm and the same Nav/Footer chrome as ChangelogPage, so
// they share one shell rather than drifting apart every time the
// theme tokens move. The prose classes mirror ChangelogPage's PROSE
// constant, minus the markdown-only rules (no code blocks, images or
// <details> appear on a legal page).
// ──────────────────────────────────────────────────────────

const PROSE =
  'text-[14px] leading-[1.7] text-fg2 ' +
  '[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-[15px] [&_h2]:font-medium [&_h2]:text-fg1 ' +
  '[&_p]:my-3 ' +
  '[&_strong]:font-medium [&_strong]:text-fg1 ' +
  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1.5 [&_li]:marker:text-fg3 ' +
  '[&_a]:text-fg1 [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-fg2 ' +
  '[&_code]:rounded [&_code]:bg-bg3 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-fg1'

export function LegalLayout({
  title,
  updated,
  children,
}: {
  title: string
  /** ISO date the copy on this page was last reviewed. */
  updated: string
  children: ReactNode
}) {
  return (
    <div className="relative flex min-h-screen flex-col">
      <Nav />

      <main className="mx-auto w-full max-w-[760px] flex-1 px-5 pt-14 pb-24 sm:px-8 sm:pt-20">
        <h1 className="text-[28px] font-medium tracking-[-0.02em] text-fg1 sm:text-[34px]">
          {title}
        </h1>
        <p className="mt-3 text-[13px] text-fg3">
          Last updated{' '}
          <time dateTime={updated}>
            {new Date(updated).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </time>
        </p>

        <div className={`mt-10 ${PROSE}`}>{children}</div>
      </main>

      <Footer />
    </div>
  )
}

// ──────────────────────────────────────────────────────────
// Typography — shared role tokens
// ──────────────────────────────────────────────────────────
//
// 01g (2026-05-19). Single source of truth for typography
// roles across the Mac app. Each constant maps to a Zeros Foundation
// recipe defined in `styles/zeros-foundation.md` §1.3 / §4.
//
// Rules:
//   • Sentence case for ALL headers + labels. Never uppercase.
//   • text-fg1 for primary (titles, focal, body in markdown).
//   • text-fg2 for secondary (body in chrome, paths,
//     descriptions, labels).
//   • text-fg3 for tertiary (hints, captions, dates,
//     counts, "very quiet" metadata). See styles/zeros-foundation.md
//     §1.3 — strict 3-tier system; NO opacity variants like
//     `text-fg1/85` etc.
//   • Custom tracking ONLY on h1-h3 (tracking-tight). Body and
//     small text use default tracking.
//   • Mono only for code, paths, durations, line counts.
//
// Use these constants instead of writing raw `text-* font-* ...`
// strings on JSX. Drift is caught at the import site, not the
// pixel level.
// ──────────────────────────────────────────────────────────

// ─── Body text ───────────────────────────────────────────

/** Default body text — universal across the Mac app. Chat composer,
 *  user messages, sidebar items, settings rows, panel rows, popovers,
 *  description paragraphs. text-sm (14px) is the app-wide
 *  cadence. Per-surface drift down to text-xs is reserved for true
 *  CAPTIONS (hints under inputs, status meta) — see HINT_CLS below. */
export const BODY_CLS = "text-sm text-fg1";

/** Supporting / hint text — captions, help text under inputs.
 *  NOT for paragraph-style body content. */
export const HINT_CLS = "text-xs text-fg2";

// ─── Anti-pattern reminders (commented strings, not exported) ──
//
//   NEVER: `text-white`, `text-black`, `text-gray-*`, `bg-gray-*`
//   NEVER: `uppercase tracking-wider`, `text-[10px] uppercase`
//   NEVER: `font-bold` in chrome — max `font-semibold` for h1-h3
//   NEVER: `font-semibold` for active sidebar items — use `font-medium`
//   NEVER: arbitrary `text-[Npx]` when a stock token fits
//   NEVER: `shadow-lg` / `shadow-md` in dark mode — use `ring-1 ring-fg1/5`
//   NEVER: solid color status fills — use `bg-X/10 text-X` (tint pattern)
//   NEVER: `border-2` in chrome
//   NEVER: `rounded-[Npx]` — use the named scale

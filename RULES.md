# Zeros Development Rules

> These rules MUST be followed by everyone working in this repository — maintainers and AI agents alike. They exist to keep the UI consistent and top-class. Breaking one is treated as a defect, not a style preference.

Visual target, stated as intrinsic properties rather than by imitating other apps: dense professional-IDE chrome. Dark theme, slate-neutral palette, restrained blue accent (≤ 5% of pixels per screen), 3-tier text hierarchy, strict 4px spacing grid, tonal borders.

The design-token system is owned by one product:

- **Zeros** (Electron mac app) — IDE-scale chrome, `--h-control-sm|md|lg` (24/28/32).

Tokens live in two files — primitives in `/styles/zeros-tokens.css`, semantic/alias tokens in `/styles/semantic-tokens.css` (with `/styles/globals.css` holding the irreducible base layer). (The form-scale heights `--h-control-xl|2xl|3xl` (36/40/44) are a legacy web-form scale inherited from an earlier product that shared this token file. They are unused today — left in place rather than churned out; don't add new callers.)

---

## Rule 1 — Design Tokens (ONE source of truth)

### 1.1 Two files, one system
Tokens live in exactly **two** files at the repo root, split by tier:
- **`/styles/zeros-tokens.css`** — **primitives**: the raw palette + the `@theme inline` Tailwind wiring. The sole source of raw color / type / space / radius / shadow / motion / z-index values.
- **`/styles/semantic-tokens.css`** — **semantics**: feature / component aliases that resolve to different primitives per theme (`--primary-button-*`, `--pr-status-*`). No raw values — only `var(--primitive)` references.

(The irreducible base layer lives alongside them in **`/styles/globals.css`**.) These are the ONLY token files. Never add a third, never a per-feature `tokens/foo.css`, never fork. Load order in `src/main.tsx`: primitives → semantics → globals.

> Migration (2026-07-17): the split is in progress. `semantic-tokens.css` exists and owns the `--pr-status-*` set; the `--primary-button-*` aliases + the primitive/semantic boundary for `--bg1..5` / `--fg1..3` move over in a dedicated, app-verified PR.

### 1.2 Semantic tokens only in components
Components reference **semantic** names (`--surface-0`, `--text-primary`, `--accent`, `--radius-sm`, `--space-4`, `--text-13`, `--dur-fast`, `--z-dropdown`). Components NEVER reference **primitives** directly (`--grey-900`, `--blue-500`) — those are internal to `zeros-tokens.css`.

### 1.3 Banned in component code

| Banned | Use instead |
|---|---|
| Hex colors (`#171717`, `#10B981`, …) outside `zeros-tokens.css` | Semantic token |
| `rgba(...)` literals, EXCEPT the documented `--tint-*` + `--backdrop-*` set | Documented tint/backdrop token |
| `font-size: Npx` where N ∉ {8, 9, 10, 11, 12, 13, 15, 18, 20} | `var(--text-8|9|10|11|12|13|15|18|20)` |
| `font-weight: N` where N ∉ {400, 500, 600} | `var(--weight-body|control|heading)` |
| `border-radius: Npx` off-scale | `rounded-sm|md|lg` (4/6/8px) or `rounded-full` |
| Odd margin/gap values (3, 5, 7, 9, 11, 13, 15) | Closest `var(--space-N)` (or `--space-3x|5x|7x` for 6/10/14) |
| Arbitrary `z-index: N` | `var(--z-chrome|panel|dropdown|modal|toast)` |
| Raw `box-shadow` patterns | `var(--shadow-sm|md|lg|xl|glass|glass-deep|inset-subtle|inset-accent|ring|ring-halo)` |
| Raw `transition` durations / easings | `var(--dur-fast|base|slow) var(--ease-standard|emphasized)` |
| Tailwind color classes (`bg-blue-500`, `text-red-600`, …) | Semantic token via component CSS |
| `font-family: "Inter"` or any web font | `var(--font-ui)` (system stack) or `var(--font-mono)` |

### 1.4 Adding a token
If nothing fits, STOP. Do not invent inline. Either:
1. Use the nearest existing semantic token, or
2. Add the token in the same PR that introduces its first caller — a **primitive** to `zeros-tokens.css`, a **semantic/alias** to `semantic-tokens.css` (§1.5). Update this file's Quick Decision Table + the target file's section headers.

Do not carry legacy aliases. If a rename happens, codemod callers and drop the old name.

### 1.5 Semantic / alias tokens — only on explicit request
A **semantic token** — a component alias (`--primary-button-bg`) or a feature alias that resolves to different primitives per theme (`--pr-status-surface`, `--pr-status-action-bg`) — is added **only when the user explicitly asks for one**. An AI agent must **ask first**; it never introduces semantic/alias tokens on its own initiative (reach for an existing token per 1.4 instead). When approved, it lands in **`semantic-tokens.css`** (§1.1) as a `var(--primitive)` reference, in the same PR as its first caller.

---

## Rule 2 — Boundary Exceptions (when raw values ARE OK)

Not every pixel can be a token. These are documented exceptions:

### 2.1 User-rendered data
Values bound to runtime user state — color picker swatches, palette renderers, canvas HCT/OKLCH math. A text editor doesn't tokenize letters; a color editor doesn't tokenize swatches.

```tsx
// OK — user data
<div style={{ background: userChosenColor }} />
<div style={{ background: computeOklch(h, c, l) }} />
```

### 2.2 Library / platform boundaries
CSS can't reach into some runtimes. Keep hex values as raw at the boundary:
- **xterm.js** (`terminal-panel.tsx`) — `TERMINAL_THEME` paints to canvas/WebGL.
- **Canvas 2D** (`thumbnail-generator.ts`) — `ctx.fillStyle = '#1a1a1a'` can't read CSS vars.
- **Radix runtime vars** — `--radix-context-menu-content-available-height` etc. are injected by Radix at runtime.
- **LLM prompt / MCP schema strings** — hex values inside prompt text describe what to generate.

### 2.3 Local z-index stacking
`z-index: 1` or `z-index: 2` inside a parent's stacking context (e.g., a card's content over its `::before` pseudo) is fine as raw. Local stacking ≠ global chrome layering. Tokenize only when you're claiming a global layer (≥ `--z-chrome`).

### 2.4 Hair-line pixel details
`border: 1px solid …` stays as `1px`. 1-2px decorative bleeds (`margin-top: -3px` on a slider thumb) are fine. Adding a `--space-3px` token is anti-pattern — single-use tokens dilute the system.

### 2.5 Unique component geometry
If a component has a specific shape (e.g., TokenNodeCard's 19px outer radius, 80px hero empty-state vertical pad, 500px dialog max-width), leave as raw with an inline `/* FLAG: ... */` comment explaining the visual intent. These sit below our "token-worthy" threshold.

### 2.6 Keyframe internals
Animation `@keyframes` translation offsets and timing values (e.g., 2s pulse, 1.5s loader) are allowed raw. Token the *invocation* (`animation-duration: var(--dur-base)`), not the keyframe math.

**Rule:** any raw value that isn't in the above categories IS a violation. An inline FLAG comment signals a judgment call, not a pass.

---

## Rule 3 — File Organization

| Content | Location |
|---|---|
| Renderer engine/bridge client | `/src/zeros/engine/`, `/src/zeros/bridge/` |
| Agent chat (composer, renderers, sessions) | `/src/zeros/agent/` |
| Panel components | `/src/zeros/panels/` |
| Settings UI | `/src/zeros/settings/` |
| Auth (native sign-in) | `/src/zeros/auth/` |
| Browser tab / variant fork | `/src/zeros/browser/` |
| Appearance / theme tokens runtime | `/src/zeros/appearance/` |
| Analytics | `/src/zeros/analytics/` |
| State management | `/src/zeros/store/` |
| Utilities | `/src/zeros/lib/`, `/src/zeros/utils/` |
| **UI primitives** | `/src/zeros/ui/` |
| Agent MCP (external server registry + scan) | `/src/engine/agents/mcp-registry.ts`, `mcp-scan.ts` |
| **Design tokens (two tiers)** | `/styles/zeros-tokens.css` (primitives) + `/styles/semantic-tokens.css` (semantics) + base layer `/styles/globals.css` |
| App shell (Electron window chrome) | `/src/shell/` |
| Engine sidecar (agents, git, pty, transport) | `/src/engine/` |
| Electron main + preload + IPC | `/electron/` |
| Native IPC façade for renderer | `/src/native/` |
| Documentation (working notes; tracked, but superseded fast — a record, not spec) | `/docs/` |
| Scripts | `/scripts/` |

> Removed (do not recreate): `/src/zeros/inspector/`, `/src/zeros/canvas/`, `/src/zeros/editors/`, `/src/zeros/themes/`, `/src/zeros/db/`, `/src/demo/` (all deleted), `/src/zeros/format/` (the `.0c` file format — removed in favor of the `artifacts/` folder model), and `/src/zeros/acp/` (the ACP bridge — the entire ACP fabric was removed when the fleet was cut to Claude/Codex/Cursor).

NEVER put component code inside page files (import them).
NEVER put styling logic inside utility files.
NEVER put a new primitive outside `/src/zeros/ui/`.

---

## Rule 4 — Primitive-first (the shadcn rule)

Every visual element uses a component from `/src/zeros/ui/`. Per-feature classes that duplicate primitive behaviour are forbidden in new code.

| Need | Primitive |
|---|---|
| Button | `<Button variant="…" size="…">` |
| Icon-only button | `<Button variant="ghost" size="icon">` |
| Text / password / number input | `<Input type="…">` |
| Multi-line input | `<Textarea>` |
| Label above a form control | `<Label>` |
| Dropdown / select / menu | `<DropdownMenu>` with `.Trigger/.Content/.Item/.Label/.Separator` |
| Tabs | `<Tabs>` |
| Card | `<Card>` / `<CardHeader>` / `<CardBody>` / `<CardFooter>` |
| Dialog / modal | `<Dialog>` + friends |
| Tooltip | `<Tooltip label="…">` |
| Chip / compact control | `<Pill>` |
| Badge / tag | `<Badge variant="…">` |
| Status dot | `<StatusDot status="…">` |
| Keyboard chip | `<Kbd>` |
| Divider | `<Divider orientation="…">` |
| Icon wrapper | `<Icon as={Lucide} size="sm|md|lg">` |

If a primitive is missing, extend `/src/zeros/ui/` first. Never write per-feature CSS.

### Buttons — the canonical set

There are exactly **two** button types — **Primary** and **Secondary** — plus two destructive flavors and ghost (icon buttons + subtle text actions). Pick a variant from this set; never invent a new button style or override button visuals with `className`.

| Variant | Use for | Looks like |
|---|---|---|
| `secondary` | **The everyday button — the default choice.** | `bg2` fill + `border2`; hover → `bg2-hover` + `border3` |
| `default` (Primary) | The **single** main action on a view (used sparingly). | White fill (`primary-button-bg`) + dark text |
| `destructive` | A dangerous *confirm/commit* action. | Red fill, `fg1` text |
| `destructive-secondary` | A dangerous action that isn't the focal point (e.g. a "Remove …" entry point). | Same neutral surface as Secondary (`bg2` + `border2`; hover `bg2-hover` + `border3`) with `red-primary` text |
| `ghost` | Icon-only buttons + subtle/secondary text actions (e.g. Cancel / Resend). | Transparent; hover `bg3` |

- **Secondary is the default — omit the variant (or pass `variant="secondary"`) for everyday buttons. Primary is opt-in via `variant="default"`, reserved for the single main CTA on a view.** `outline` is **retired** (2026-07-12) — the v0 primitive no longer ships it; wherever it appeared, use `secondary`. (The legacy `@/zeros/ui/button` wrapper still accepts `variant="outline"` and renders Secondary.)
- **Shared by every button:** 4px radius (`--radius-sm`), 10px horizontal padding, 8px icon↔text gap, and **width fits the content** (no fixed width).
- **Size = height only:** `sm` = 24px, `default` = 28px, `lg` = 32px. Icon-only squares sit on the **same 24/28/32 scale**: `size="icon-sm"` (24px, pairs with `sm`), `size="icon"` (28px, pairs with `default`), `size="icon-lg"` (32px, pairs with `lg`). *(2026-07-12: was `icon` 36px / `icon-sm` 28px. The legacy wrapper maps old names to the size-preserving step: legacy `icon-sm` → 28px `icon`, legacy `icon` → 32px `icon-lg`.)*
- **Inline text links** in agent/markdown output are real `<a>` elements colored `--info` (handled by the markdown renderer) — there is **no Button `link` variant**. For link-styled *actions* (Cancel, Resend, …), use `ghost`.
- Need a new treatment? Add a variant to `src/zeros/ui/primitives/button.tsx` — don't restyle with `className`.

### Inputs & control sizing

`<Input>` / `<Textarea>` are the only text fields. They share: **`border3`** rest border on a **transparent** bg, **4px** radius, and focus = a **`highlighted-bright` border with NO ring**. `InputGroup` and the dropdown trigger (`SelectTrigger`) match this exactly.

- **32px is the control-height ceiling.** Inputs default to 32px (`h-8`); dropdown triggers are 32px too. A control may be made SHORTER for a compact spot (e.g. an inline tab rename) but **never taller than 32px** (RULES Rule 6's 24/28/32 scale — buttons default to 28px).
- **Same-row controls match heights.** When a button or dropdown sits next to a 32px input (e.g. an API-key field + Save), give the button `size="lg"` so it's 32px too.
- Don't hand-roll `<input>`/`<textarea>` or override border/bg/focus/radius with `className` — use the primitive (a shorter `h-*` or a `text-*`/`font-mono` tweak is fine). The only sanctioned exceptions today: the **chat-tab and workspace rename** fields, and the **settings.toml syntax-overlay** textarea.

---

## Rule 5 — `className` is for layout only

`className` may contain Tailwind layout utilities: `flex`, `grid`, `gap-*`, `items-*`, `justify-*`, `max-w-*`, `min-h-*`, `mx-auto`, `overflow-*`, `truncate`, `w-full`, `h-full`, `size-*`. Anything visual — color, typography, spacing, radius, shadow, border — must come from a primitive or a token.

```tsx
// ❌ Tailwind colors / typography / spacing
<div className="bg-blue-500 text-white p-4 rounded-lg">…</div>

// ❌ Overriding primitive visuals
<Button className="bg-red-600 text-white">Delete</Button>

// ❌ Inline style for static visuals
<p style={{ color: "#aaa", fontSize: 14 }}>…</p>

// ✅ Layout classes + primitives
<div className="flex items-center gap-2">
  <Badge variant="primary">New</Badge>
  <Button variant="destructive">Delete</Button>
</div>
```

---

## Rule 6 — Density

- **Control heights**:
  - Zeros IDE chrome: 24 / 28 / 32 px (`--h-control-sm|md|lg`). Never exceed 32.
  - Form-scale 36 / 40 / 44 px (`--h-control-xl|2xl|3xl`) — legacy web-form scale inherited from an earlier product; unused today.
- **Body text** 13 px (`var(--text-13)`). **Controls** 12 px. **Metadata** 11 px. **Panel heading** 15 px. **Page heading** 18–20 px. Micro-labels (timestamps, tiny badges) may use 9–10 px where essential.
- **Accent discipline**: brand-accent surfaces appear on **< 5%** of pixels. Two token families count as accent:
  - **Legacy era** (consumed by `src/zeros/ui/*` until Phase 9 migration): `--accent`, `--accent-hover`, `--accent-soft-bg`, `--ring-focus`, `--text-link`.
  - **v0 era** (consumed by `src/zeros/ui/primitives/*` shadcn primitives): `--v0-brand`, `--v0-brand-foreground`, and the Tailwind utilities `bg-brand`, `text-brand`, `ring-brand`, `border-brand`, `bg-brand-foreground`, etc.

  Both flow from the user's appearance-store accent slider. They are allowed on, and only on:
  1. Primary-button fill — **only when the button is the brand CTA** (e.g. "Send to agent"); default buttons use neutral primary.
  2. Active-tab indicator
  3. Focus-ring outline (only on accent-tagged controls; ordinary focus uses `--v0-ring` neutral)
  4. Link text
  5. Selection-highlight bg
  6. Brand mark (logo, app icon, distinctive status pills / badges in tiny doses)

  shadcn's `--color-accent` / `bg-accent` / `text-accent-foreground` is **NOT** brand-accent — it's a *subtle hover surface* (zinc-tinted) used by hover states across every primitive. Use freely; this rule does not constrain it.

  Anywhere else, the brand token requires an inline `check:ui ignore-line (accent: <reason>)` comment that justifies the deliberate use, or the consistency lint will fail the build.
- **Surface hierarchy**: 5-tier (`--surface-floor/0/1/2/3`). Hover swaps to `--surface-2`; selected swaps to `--surface-3`. Never gradient chrome.
- **Borders**: solid tonal steps, not alpha overlays. Use `--border-subtle|default|strong` per visual weight.
- **1px column seams**, always `--border-subtle`.

---

## Rule 7 — No inline visual styles

`style={{}}` is ONLY for values that can't be expressed as a class:

- User-data swatches (`style={{ background: user.color }}`)
- Runtime-computed position (`style={{ top: rect.y, left: rect.x }}`)
- Dynamic width from a resize handle (`style={{ width: dims.w }}`)

NEVER use `style={{}}` for static `background`, `color`, `padding`, `margin`, `fontSize`, `fontWeight`, `fontFamily`, `border`, `borderRadius`, `boxShadow`, `zIndex`, or `width/height` on non-interactive elements. If you're tempted, add a class.

---

## Rule 8 — No manual `z-index`

Overlays use the primitives (`<DropdownMenu>`, `<Dialog>`, `<Tooltip>`, `<Popover>`) which already own the right layer via `--z-dropdown|modal|toast`. Writing `z-index: 999` or `z-index: 50` in a component is a bug.

**Exception:** local stacking `z-index: 1|2` inside a parent's contained context (see Rule 2.3).

If you need a new global layer, add a token (`--z-foo`) to `zeros-tokens.css`, document it, and use it.

---

## Rule 9 — Component Structure

```tsx
// ============================================
// COMPONENT: ComponentName
// PURPOSE: What this component does
// USED IN: Which pages/components use this
// ============================================

// --- IMPORTS ---
// --- TYPES ---          (each prop commented)
// --- STATE ---          (each useState commented)
// --- WORKFLOWS ---      (each function commented)
// --- EVENT HANDLERS --- (each handler commented)
// --- RENDER ---         (only primitives + layout classes)
```

Pages follow the same pattern with `PAGE:` / `ROUTE:` / `PURPOSE:` header.

Every `useState` / `useRef` has a one-line comment explaining what it holds. Every prop has a comment. Every workflow function has a block comment.

Comments explain **why**, never **what**.

---

## Rule 10 — Keep It Simple

- No complex abstractions for their own sake.
- React `useState` + `useEffect` is enough for isolated ephemeral component
  state. Shared bridge/native/remote data follows Rule 11 instead.
- If a designer can't read the JSX, simplify.
- Prefer CSS `:hover` / `:focus-visible` over JS handlers for styling.

---

## Rule 11 — Instant Interaction Performance

For any renderer state, navigation, data-fetching, tab, panel, list, or
loading-state change, follow the bullets below. They are the binding statement
of the rule; `/docs/ui-interaction-performance.md` expands on them with worked
examples but is local-only working notes (gitignored, not in a public clone), so
never treat its absence as the rule not applying.

- Publish route + destination identity atomically.
- Assign every durable selection to its semantic owner: app-global preference,
  repository, workspace/worktree, or individual tab. Persist it under that key
  and restore it in the destination's first render; never use one global local
  `useState` value for a repo/workspace-scoped tab. Dialog and unsaved-create
  draft selections remain ephemeral.
- Validate remembered targets against an authoritative exact-key snapshot.
  A cold cache preserves the remembered identity; fall back only after the
  settled snapshot proves it stale. Bound scoped maps and prune removed owners.
- Deleting an owner must prune normalized descendant cwd keys while protecting
  any separately registered, more-specific nested repository owner.
- Model IPC/Git/SQLite/cloud reads as exact-key, bounded server-state caches.
  Deduplicate requests and retain the last successful same-key snapshot during
  refresh; never reset confirmed data to an empty loading value.
- Warm likely destinations on pointer/focus intent. Urgent click handlers do not
  await I/O, parsing, highlighting, or hydration.
- Reuse aggregate data instead of issuing a second per-item request.
- Keep Zustand selectors and unchanged collection/row/turn references stable.
  Memoized rows receive row-local props, not a global selected id.
- Retain expensive DOM only in a bounded MRU deck. Hidden views are inert and
  gate active-only shortcuts, focus, measurement, polling, and side effects.
- Do not add fades, skeletons, spinners, or timeouts to hide a waterfall. Fix
  readiness first; delay a genuine cold-load indicator only to avoid a flash.
- Verify exact-key isolation, stale races, request deduplication, reference
  stability, and bounded eviction with tests; confirm localized commits in the
  React Profiler for interaction-sensitive work.
- For selection work, test A → B → A at every affected owner boundary, reload,
  corrupt/stale persistence, owner deletion, and one-notification atomicity.

---

## Quick Decision Table — "I need X → use Y"

| I need… | Use… |
|---|---|
| Deepest chrome bg (title/activity/status bar) | `var(--surface-floor)` |
| App canvas background | `var(--surface-0)` |
| Card / input / menu bg | `var(--surface-1)` |
| Row hover / menu-item hover bg | `var(--surface-2)` |
| Active tab / selected row bg | `var(--surface-3)` or `var(--accent-soft-bg)` |
| Body text | `var(--text-primary)` |
| Secondary label text | `var(--text-muted)` |
| Placeholder / hint text | `var(--text-placeholder)` |
| Disabled text | `var(--text-disabled)` |
| Link text | `var(--text-link)` (resolves to `--accent`) |
| Primary button fill | `var(--accent)` → hover `var(--accent-hover)` |
| Primary button text | `var(--text-on-accent)` |
| Focus ring outline | `var(--ring-focus)` + `outline-offset: 1px` |
| Destructive fill | `var(--text-critical)` |
| Success indicator | `var(--text-success)` |
| Warning indicator | `var(--text-warning)` |
| Info indicator | `var(--text-info)` |
| Subtle border / column seam | `var(--border-subtle)` |
| Input / button border | `var(--border-default)` |
| Focused input / dialog edge | `var(--border-strong)` |
| Panel padding | `var(--space-5)` (20px) or `var(--space-6)` (24px) |
| Row padding Y | `var(--space-5x)` (10px) |
| Item gap | `var(--space-3)` (12px) |
| Button / pill / input radius | `var(--radius-sm)` (4px, DEFAULT) |
| Tab / sidebar-row / small-card radius | `var(--radius-md)` (6px) |
| Card / menu / dialog radius | `var(--radius-lg)` (8px) |
| Selected row bg | `background: var(--accent-soft-bg)` |
| Card floating shadow | `var(--shadow-glass)` |
| Modal deep shadow | `var(--shadow-glass-deep)` |
| Opaque drop shadow (IDE chrome) | `var(--shadow-lg)` / `var(--shadow-xl)` |
| Focus ring (solid) | `box-shadow: var(--shadow-ring)` |
| Focus halo (soft) | `box-shadow: var(--shadow-ring-halo)` |
| Card inner hairline | `box-shadow: var(--shadow-inset-subtle)` |
| Selection inset | `box-shadow: var(--shadow-inset-accent)` |
| Dropdown z-index | (primitive owns it — `var(--z-dropdown)`) |
| Modal z-index | (primitive owns it — `var(--z-modal)`) |
| Transition for color/bg | `var(--dur-fast) var(--ease-standard)` |
| Transition for layout | `var(--dur-base) var(--ease-standard)` |
| System font stack | `var(--font-ui)` |
| Monospace | `var(--font-mono)` |
| Icon next to 13px text | `size={14}` (`var(--icon-md)`) |
| Icon in nav / activity bar | `size={16}` (`var(--icon-lg)`) |
| Chevron in pill | `size={10}` (`var(--icon-xs)`) |
| Dropdown min-width | `var(--menu-min-width)` (8rem) |

---

## Pre-commit Checklist

Before every UI-touching commit, verify with the grep one-liners below. Each should light up zero lines (or only files listed in Rule 2 — boundary exceptions):

```bash
# No raw hex in components
grep -rnE '#[0-9a-fA-F]{6,8}\b' src/ --include='*.css' --include='*.tsx' | grep -vE 'styles/(zeros-tokens|globals)\.css'

# No raw rgba in components
grep -rnE 'rgba\(' src/ --include='*.css' | grep -vE 'styles/(zeros-tokens|globals)\.css'

# No off-scale font-size
grep -rnE 'font-size:\s*[0-9]+' src/ --include='*.css' | grep -v 'var(--text-'

# No raw z-index in components (except local stacking 1-2)
grep -rnE 'z-index:\s*[3-9][0-9]*' src/ --include='*.css' | grep -v 'var(--z-'

# No raw transition
grep -rnE 'transition:' src/ --include='*.css' | grep -vE 'var\(--(dur|ease)'

# Typecheck — app + electron + packages. (NOT `-p tsconfig.build.json`: that's a
# build config and reports false errors on engine code; the wired script uses the
# dedicated tsconfig.typecheck.json gates.)
pnpm typecheck
```

A violation that falls under Rule 2's boundary exceptions is fine — leave an inline `/* FLAG: <reason> */` comment on the line so reviewers can see it's intentional.

---

## Reference: Sections of `zeros-tokens.css`

1. Internal primitives — NEVER reference from components
2. Surfaces (5-tier + inverted pair)
3. Borders (3 solid tonal steps)
4. Text (3 tiers + disabled + on-accent/-inverted)
5. Accent (+ hover / pressed / soft-bg / ring-focus)
6. Status (text color + soft-bg pair for each)
7. Tints (state overlays — the ONLY rgba allowed in components, indirectly)
8. Typography (font stacks + px scale 8/9/10/11/12/13/15/18/20 + weights + leading + tracking)
9. Spacing (strict 4px grid + `-3x/-5x/-7x` odd steps)
10. Radius (`sm|md|lg` = 4/6/8px + `full`)
11. Motion (`dur-fast|base|slow`, `ease-standard|emphasized`)
12. Shadows (opaque elevation `sm|md|lg|xl` + glass `glass|glass-deep` + insets + rings)
13. Z-index (5-tier scale)
14. Control heights (IDE-scale `sm|md|lg` + form-scale `xl|2xl|3xl`)
15. Icon sizes (`xs|sm|md|lg|xl`)
16. Chrome layout (shell dims + menu min-widths)
17. Syntax highlighting (generic + DSL-specific)
18. Brand (third-party product tints — Claude, Codex, …)
19. Utility (domain indicators — build, project, API, … — legacy, pre-Zeros era)

Any new token lands in the matching section with a one-line comment; no ad-hoc additions outside the taxonomy.

# Theme system tour — how every UI gets its colors

**Status:** 2026-05-26. Active. Single answer to "where do the colors come from, what does the AI read when I ask for new UI, and how do I instruct it properly?"

For the **rules** (which token paints what, component recipes, anti-patterns), see `styles/zeros-foundation.md`. This doc explains the **system** — file map, load order, AI workflow, maintenance.

---

## §1 — The five files

| # | File | Role | Read by |
|---|---|---|---|
| 1 | `~/.claude/skills/zeros-foundation/SKILL.md` | Auto-loaded skill (one-shot at task start) | Claude (every UI task) |
| 2 | `styles/zeros-foundation.md` | Operational rule sheet (recipes, anti-patterns, scales) | Claude + humans |
| 3 | `styles/theme-system-tour.md` | **This doc** — where everything lives + AI workflow | Claude + humans |
| 4 | `styles/zeros-tokens.css` | THE token implementation (primitive HSL values) | The browser |
| 5 | `styles/globals.css` | Markdown CSS + scrollbars + global focus outline | The browser |

**`website/**` is out of scope.** It has its own token system and doesn't share `zeros-tokens.css`. This doc covers `src/shell/**`, `src/zeros/**`, and `styles/**`.

---

## §2 — How Claude finds the rules (skill resolution)

When you ask Claude to do any UI task in this repo, the Zeros Foundation skill auto-loads. The skill is a global file at `~/.claude/skills/zeros-foundation/SKILL.md` — it isn't per-project. The skill content:

- Names the canonical doc (`styles/zeros-foundation.md`)
- Lists "rules most likely to slip" so Claude has them in context without re-reading the foundation
- Points at recipe sections to consult for specific surfaces

The flow:

```
You: "polish the chat composer"
  ↓
Claude: auto-loads zeros-foundation skill (system reminder lists it)
  ↓
Claude: skill content gives quick-reference rules + paths
  ↓
Claude: reads styles/zeros-foundation.md §4 (recipes) + §5 (anti-patterns)
  ↓
Claude: opens the surface file, applies the recipe, checks anti-patterns
```

The skill never gets re-read mid-task. It's a one-shot injection at the start of any UI-flavored request. **To change Claude's behavior across all future sessions, edit `~/.claude/skills/zeros-foundation/SKILL.md` — repo-side edits don't reach it.**

---

## §3 — Load order at runtime (CSS perspective)

When the Electron app starts, the CSS arrives in this order:

```
1. Tailwind preflight (browser reset)
2. styles/zeros-tokens.css
   ├── @import "tailwindcss"
   ├── @import "@fontsource-variable/geist"
   ├── @import "@fontsource-variable/geist-mono"
   ├── @custom-variant dark (...)
   ├── @theme inline { ... }   ← wires primitives → utility classes
   ├── :root { ... }            ← primitive token values (dark)
   └── @layer base { ... }      ← border-color + outline-color defaults
3. styles/globals.css            ← markdown CSS, scrollbars, slider
4. (per-component Tailwind classes compiled at build time)
```

Then on the JS side, the appearance store runs:

```
src/zeros/appearance/store.ts (module load)
  ↓ readStoredPrefs() — read localStorage (key: zeros.appearance.v2)
  ↓ applyTheme(prefs, { systemPrefersDark }) — write data-theme on <html>
React mounts
```

`data-theme` on `<html>` selects the theme: `:root` carries the dark default (Zeros Shade) and the `[data-theme="light"]` block (added 2026-07-11) overrides every primitive with the light values. `applyTheme` also reports the resolved `--bg1` to the Electron main process (`window_set_background`) so the native window's pre-paint background tracks the theme across launches.

This is why **theme changes are instant** — there's no React state, no virtual DOM, no per-component re-render. The CSS variables propagate via the cascade, and modern browsers handle it under 16 ms.

---

## §4 — Token system at a glance

**One layer of primitives** plus a small set of **component aliases**. Full reference in `styles/zeros-foundation.md` §2.

| Family | Tokens | Tailwind prefix |
|---|---|---|
| Backgrounds | `--bg1` … `--bg5` + `--bg{1,2,3}-hover` + `--bg1-highlight` | `bg-bg1`, `bg-bg2-hover`, etc. |
| Foregrounds | `--fg1`, `--fg2`, `--muted-fg` | `text-fg1`, `text-fg2`, `text-muted-fg` |
| Sidebar (workspace col 1) | `--sidebar-bg`, `--sidebar-bg-hover` | `bg-sidebar-bg`, `bg-sidebar-bg-hover` |
| Borders | `--border1` … `--border4` | `border-border1`, etc. |
| Highlighted (brand) | `--highlighted-bg`, `--highlighted-bright` | `bg-highlighted-bright`, etc. |
| Inverted (polarity pair) | `--inverted-bg`, `--inverted-fg` | `bg-inverted-bg`, `text-inverted-fg` |
| Component aliases | `--primary-button-bg/-hover/-fg` | `bg-primary-button-bg`, etc. |
| Color palettes (semantic) | `--{red,green,yellow,blue,violet}-{primary,bg,fg}` + `--red-secondary`/`--red-secondary-fg` | `text-red-primary`, `bg-red-bg`, `text-green-fg`, etc. |

**Tailwind utility naming is verbatim**: `--color-bg1` → class `bg-bg1`. The `bg-bg1` repeat reads slightly odd but it's unambiguous and matches the token name exactly. No shadcn aliases, no canonical depth tokens, no `--tint` family.

---

## §5 — AI workflow example

You say:

> "Add a workspace-switcher dropdown to the top bar. Should match the project breadcrumb's hover style and have a search input at the top."

The internal flow:

1. **Skill activates.** Zeros Foundation skill content lands in context. Claude now knows the quick-reference rules, the doc paths, and the workflow.
2. **Open the canonical docs.** Claude opens `styles/zeros-foundation.md` and skims §3 (surface map) + §4 (recipes). For a popover/dropdown, the relevant recipe is §4.3.
3. **Find the existing surface.** Claude reads `src/shell/column2-topbar.tsx` to see how the project breadcrumb is styled — `text-fg2` idle, `hover:bg-bg1-hover hover:text-fg1`.
4. **Compose the new component.** Picks tokens:
   - Trigger button: `text-fg2 hover:bg-bg1-hover hover:text-fg1` (matches breadcrumb)
   - Popover panel: `bg-bg3 border border-border1 rounded-lg`
   - Search input: existing `<Input>` primitive (`bg-bg3` since it's inside a popover; if you want it on the trigger side, `bg-bg1`)
   - Item rows: `text-fg1` idle, `hover:bg-bg3-hover hover:text-fg1`, `data-[active=true]:bg-bg3-hover`
   - Selected indicator: `Check` icon at `size-3.5`, `text-fg2`
5. **Anti-pattern check.** Compare to foundation §5:
   - No uppercase tracking-wider eyebrows ✓
   - No solid color status fills ✓
   - No `border-2` heavy borders ✓
   - No animated icon transforms ✓
   - Hover states surface-scoped (bg1 → bg1-hover, bg3 → bg3-hover) ✓
6. **Build to verify.** `pnpm vite build` — catches className typos or type errors.

What Claude **does not** do by default:
- Pick custom HSL / hex / oklch values — always references existing tokens
- Add new CSS files — tokens live in `zeros-tokens.css` only
- Use `bg-white` / `bg-black` / `text-gray-500` — primitive tokens only
- Add `font-size: 13px` or other off-scale values — sticks to `text-xs` / `text-sm`

If you want any of that, you have to say so explicitly. The skill is opinionated on the "no" side.

---

## §6 — How to instruct the AI properly

Five patterns that produce the right output.

### 6.1 Reference the tier, not the value

❌ "Make the workspace name dark gray"
✅ "Use `text-fg2`"

Telling Claude the *tier* (`fg1` / `fg2` / `muted-fg`) maps to a single token. Telling it the *color* invites a hex value.

### 6.2 Name the state, not the styling

❌ "Background should be 5% lighter on hover"
✅ "Apply the surface-scoped hover — on bg1, that's `bg-bg1-hover`; on bg3, `bg-bg3-hover`"

The hover rule (foundation §5 #4) is surface-scoped. Phrasing in terms of surfaces keeps the codebase consistent.

### 6.3 Cite the recipe when polishing

❌ "Make the composer prettier"
✅ "Polish the composer per zeros-foundation §4.4 and double-check §5 anti-patterns"

The foundation doc has a recipe for nearly every chrome surface. Naming the recipe puts Claude on the right path.

### 6.4 If you mean spotlight, say "highlighted"; if you mean focal CTA, say "primary"

Two tokens for "this thing pops" — not interchangeable:

| Phrase | Token | What it does |
|---|---|---|
| "Use the primary button" | `bg-primary-button-bg text-primary-button-fg` | Filled focal CTA, ONE per screen |
| "Use the highlighted accent" | `bg-highlighted-bg` (text on it: `text-fg1`/`text-fg2`) / `border-highlighted-bright` | Brand anchor moments (user bubble), input focus |

### 6.5 Lock the typography scale upfront

❌ "Title should be 16px, body 14px"
✅ "Use the 12/14 chrome scale: title `text-sm font-medium`, body `text-sm`"

The strict 12/14 in chrome is the rule. Saying "16px" invites the agent to break the scale for one surface; saying "text-sm font-medium" keeps everything aligned.

---

## §7 — Maintenance: where to make changes

When the design direction shifts, here's where each kind of change lands:

| Change | Edit this file | Why |
|---|---|---|
| Change a token *value* (e.g., make composer darker) | `styles/zeros-tokens.css` | Single source of truth |
| Add a new token (e.g., `--bg6` for a new surface) | `styles/zeros-tokens.css` + `zeros-foundation.md` §2/§3 | Token first, then doc |
| Add a new component recipe (e.g., new pill style) | `styles/zeros-foundation.md` §4 | Recipe sheet |
| Add a new anti-pattern | `styles/zeros-foundation.md` §5 | Anti-pattern list |
| Update Claude's behavior across all sessions | `~/.claude/skills/zeros-foundation/SKILL.md` | The skill is what Claude loads |

**Update propagation order:**
1. Token in `zeros-tokens.css`
2. Doc in `zeros-foundation.md` (and `theme-system-tour.md` §4 if the family changes)
3. Skill in `~/.claude/skills/zeros-foundation/SKILL.md` if the rule changed
4. Migrate call sites opportunistically (don't churn the codebase in one PR)

---

## §8 — TL;DR

- **Tokens live in `styles/zeros-tokens.css`.** Primitive HSL values; edit the token, not the component.
- **Only knob: theme mode** (system / light / dark). Dark is Zeros Shade in `:root`; light is the `[data-theme="light"]` override block; System follows macOS.
- **Backgrounds**: `bg-bg1` (canvas) → `bg-bg2` (composer) → `bg-bg3` (popover/dropdown/dialog). Hovers are surface-scoped (`bg-bg1-hover`, `bg-bg2-hover`, `bg-bg3-hover`).
- **Foregrounds**: `text-fg1` (highlighted), `text-fg2` (default), `text-muted-fg` (placeholders).
- **Borders**: `border-border1` (default) → `border-border3` (component) → `border-border4` (highlighted).
- **Two "stand-out" tokens**:
  - `bg-primary-button-bg text-primary-button-fg` — inverted focal CTA button. One per screen.
  - `bg-highlighted-bg` / `border-highlighted-bright` — brand anchor moments, input focus, code-link highlights.
- **Sidebar (workspace col 1 only)** = `bg-sidebar-bg` / `bg-sidebar-bg-hover`. The settings sidebar uses the default tokens.
- **Semantic status = the color families** — error→red, success→green, warning→yellow, info→blue, done→violet. Use `text-<family>-primary`, or `bg-<family>-bg`+`text-<family>-fg` for callouts.
- **Diff renderer** = the Zeros palette via `diff-theme.ts` — warm surface (`--sidebar-bg` in column 3, `--bg1` in EditCards) + green/red/neutral `--diffs-*-color-override` bases; @pierre derives the rest, syntax from Shiki.
- **Claude follows the Zeros Foundation skill on every UI task.** To steer it, reference recipes from `zeros-foundation.md` §4 and anti-patterns from §5. Say "primary button" for inverted CTA, "highlighted" for brand accent.

# Theme system tour — how every UI gets its colors

**Status:** Living reference. This document explains where desktop colors come
from, their runtime load order, and how to maintain the cascade.

For the **rules** (which token paints what, component recipes, anti-patterns), see `styles/zeros-foundation.md`. This doc explains the **system** — file map, load order, AI workflow, maintenance.

---

## §1 — File map

| #   | File                                    | Role                                                      | Read by                    |
| --- | --------------------------------------- | --------------------------------------------------------- | -------------------------- |
| 1   | `styles/zeros-foundation.md`            | Operational recipes, anti-patterns, and scales            | Maintainers and automation |
| 2   | `styles/theme-system-tour.md`           | **This document** — runtime and maintenance tour          | Maintainers and automation |
| 3   | `styles/zeros-tokens.css`               | Primitive values, core aliases, and Tailwind theme wiring | Renderer build             |
| 4   | `styles/semantic-tokens.css`            | Feature-specific semantic aliases                         | Renderer build             |
| 5   | `styles/globals.css` + `styles/global/` | Ordered cross-boundary cascade                            | Renderer build             |

`apps/marketing/` is out of scope and does not share the desktop token files.
This document covers `apps/desktop/src/renderer/**` and `styles/**`.

---

## §2 — How changes are governed

`RULES.md` is binding. This tour and `styles/zeros-foundation.md` provide the
implementation detail. A UI change should identify its owning component, reuse a
shared primitive where appropriate, select semantic tokens, run `pnpm check:ui`,
and verify the production renderer build. Changes to global import order require
visual regression coverage because unlayered precedence is load-bearing.

---

## §3 — Load order at runtime (CSS perspective)

When the Electron app starts, the CSS arrives in this order:

```
1. styles/zeros-tokens.css
   ├── @import "tailwindcss"
   ├── @import "@fontsource-variable/geist"
   ├── @import "@fontsource-variable/geist-mono"
   ├── @custom-variant dark (...)
   ├── @theme inline { ... }   ← wires primitives → utility classes
   ├── :root { ... }            ← primitive token values (neutral dark)
   ├── [data-theme-palette="orka-black"] ← preserved warm dark overrides
   ├── [data-theme="light"]     ← light overrides
   └── @layer base { ... }      ← border-color + outline-color defaults
2. styles/semantic-tokens.css    ← semantic/component aliases
3. styles/globals.css            ← ordered imports from styles/global/
4. Tailwind utilities compiled from renderer components
```

Then on the JS side, the appearance store runs:

```
apps/desktop/src/renderer/shared/theme/store.ts (module load)
  ↓ readStoredPrefs() — read localStorage (key: zeros.appearance.v2)
  ↓ applyTheme(prefs, { systemPrefersDark })
      ├── write data-theme="dark|light" on <html>
      └── set/remove data-theme-palette="orka-black"
React mounts
```

`data-theme` is deliberately only the resolved appearance (`dark` or `light`):
Tailwind's `dark:` variant, `color-scheme`, syntax-theme filtering, and embedded
surfaces all depend on that binary polarity. `:root` carries neutral Dark;
`data-theme-palette="orka-black"` restores the former warm-gray dark structural
tokens; and `[data-theme="light"]` overrides the full palette. System resolves to
neutral Dark or Light with macOS—Orka black is an explicit selection.

`applyTheme` also reports the resolved `--bg1` to Electron
(`window_set_background`) so the native window's pre-paint background tracks the
theme across launches. JS-painted surfaces subscribe to the concrete theme id,
not only dark/light, so xterm and canvas colors repaint during a Dark ↔ Orka
black switch.

This is why **theme changes are instant**: CSS-painted surfaces update through the
cascade without per-component theme props. The few JavaScript-painted surfaces
(terminals and canvas loaders) subscribe to the concrete theme identity so they
repaint when Dark and Orka black switch without changing dark/light polarity.

---

## §4 — Token system at a glance

**One layer of primitives** plus a small set of **component aliases**. Full reference in `styles/zeros-foundation.md` §2.

| Family                    | Tokens                                                                                      | Tailwind prefix                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Backgrounds               | `--bg0` … `--bg5` + `--pane-bg`, `--bg{1,2,3}-hover`, `--bg1-highlight`                     | `bg-bg1`, `bg-bg2-hover`, etc.                         |
| Foregrounds               | `--fg1`, `--fg2`, `--fg3`, `--muted-fg`                                                     | `text-fg1`, `text-fg2`, `text-muted-fg`                |
| Repository navigation     | `--sidebar-bg`, `--sidebar-bg-hover`                                                        | `bg-sidebar-bg`, `bg-sidebar-bg-hover`                 |
| Borders                   | `--border1` … `--border4`                                                                   | `border-border1`, etc.                                 |
| Highlighted (interaction) | `--highlighted-bg`, `--highlighted-bright`                                                  | `bg-highlighted-bright`, etc.                          |
| Inverted (polarity pair)  | `--inverted-bg`, `--inverted-fg`                                                            | `bg-inverted-bg`, `text-inverted-fg`                   |
| Component aliases         | `--primary-button-bg/-hover/-fg`                                                            | `bg-primary-button-bg`, etc.                           |
| Color palettes (semantic) | `--{red,green,yellow,blue,violet,brown}-{primary,bg,fg}` + red secondary pair                | `text-red-primary`, `bg-red-bg`, `text-green-fg`, etc. |

**Tailwind utility naming is verbatim**: `--color-bg1` → class `bg-bg1`. The `bg-bg1` repeat reads slightly odd but it's unambiguous and matches the token name exactly. No shadcn aliases, no canonical depth tokens, no `--tint` family.

“Neutral Dark” applies to structural primitives: backgrounds, foregrounds,
borders, interaction highlights, and the inverted pair. The six semantic color
families remain chromatic in both dark palettes because they identify errors,
success, warnings, information, merged/done state, file paths, and diff state.
Syntax themes, agent brand marks, and file-type icons are also independent
meaning-bearing or user-selected color systems and are not desaturated.

---

## §5 — AI workflow example

You say:

> "Add a workspace-switcher dropdown to the top bar. Should match the project breadcrumb's hover style and have a search input at the top."

The internal flow:

1. **Skill activates.** Zeros Foundation skill content lands in context. Claude now knows the quick-reference rules, the doc paths, and the workflow.
2. **Open the canonical docs.** Claude opens `styles/zeros-foundation.md` and skims §3 (surface map) + §4 (recipes). For a popover/dropdown, the relevant recipe is §4.3.
3. **Find the existing surface.** Claude reads `apps/desktop/src/renderer/shell/conversation/conversation-header.tsx` to see how the project breadcrumb is styled — `text-fg2` idle, `hover:bg-bg1-hover hover:text-fg1`.
4. **Compose the new component.** Picks tokens:
   - Trigger button: `text-fg2 hover:bg-bg1-hover hover:text-fg1` (matches breadcrumb)
   - Popover panel: `bg-bg3 border border-border2 rounded-lg`
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

Telling Claude the _tier_ (`fg1` / `fg2` / `muted-fg`) maps to a single token. Telling it the _color_ invites a hex value.

### 6.2 Name the state, not the styling

❌ "Background should be 5% lighter on hover"
✅ "Apply the surface-scoped hover — on bg1, that's `bg-bg1-hover`; on bg3, `bg-bg3-hover`"

The hover rule (foundation §5 #4) is surface-scoped. Phrasing in terms of surfaces keeps the codebase consistent.

### 6.3 Cite the recipe when polishing

❌ "Make the composer prettier"
✅ "Polish the composer per zeros-foundation §4.4 and double-check §5 anti-patterns"

The foundation doc has a recipe for nearly every chrome surface. Naming the recipe puts Claude on the right path.

### 6.4 If you mean interaction emphasis, say "highlighted"; if you mean focal CTA, say "primary"

Two tokens for "this thing pops" — not interchangeable:

| Phrase                          | Token                                                                                 | What it does                        |
| ------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- |
| "Use the primary button"        | `bg-primary-button-bg text-primary-button-fg`                                         | Filled focal CTA, ONE per screen    |
| "Use the highlighted treatment" | `bg-highlighted-bg` (text on it: `text-fg1`/`text-fg2`) / `border-highlighted-bright` | User bubble, selection, input focus |

### 6.5 Lock the typography scale upfront

❌ "Title should be 16px, body 14px"
✅ "Use the 12/14 chrome scale: title `text-sm font-medium`, body `text-sm`"

The strict 12/14 in chrome is the rule. Saying "16px" invites the agent to break the scale for one surface; saying "text-sm font-medium" keeps everything aligned.

---

## §7 — Maintenance: where to make changes

When the design direction shifts, here's where each kind of change lands:

| Change                                              | Edit this file                                          | Why                                             |
| --------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| Change a token _value_ (e.g., make composer darker) | `styles/zeros-tokens.css`                               | Single source of truth                          |
| Add a new token (e.g., `--bg6` for a new surface)   | `styles/zeros-tokens.css` + `zeros-foundation.md` §2/§3 | Token first, then doc                           |
| Add a new component recipe (e.g., new pill style)   | `styles/zeros-foundation.md` §4                         | Recipe sheet                                    |
| Add a new anti-pattern                              | `styles/zeros-foundation.md` §5                         | Anti-pattern list                               |
| Update repository-wide UI rules                     | `RULES.md`                                              | Binding guidance for maintainers and automation |

**Update propagation order:**

1. Token in `zeros-tokens.css`
2. Doc in `zeros-foundation.md` (and `theme-system-tour.md` §4 if the family changes)
3. `RULES.md` when the binding repository policy changed
4. Migrate call sites opportunistically (don't churn the codebase in one PR)

---

## §8 — TL;DR

- **Tokens live in `styles/zeros-tokens.css`.** Primitive HSL values; edit the token, not the component.
- **Only knob: theme mode** (System / Light / Dark / Orka black). Dark is neutral in `:root`; Orka black restores the previous warm-gray dark primitives; Light is the `[data-theme="light"]` override; System follows macOS and uses neutral Dark when macOS is dark.
- **Backgrounds**: `bg-bg0` (inactive pane), `bg-bg1` (canvas), `bg-bg2` (composer), and `bg-bg3` (floating popover/dropdown/menu only). Hovers are surface-scoped (`bg-bg1-hover`, `bg-bg2-hover`, `bg-bg3-hover`).
- **Foregrounds**: `text-fg1` (highlighted), `text-fg2` (default), `text-muted-fg` (placeholders).
- **Borders**: `border-border1` (default) → `border-border3` (component) → `border-border4` (highlighted).
- **Two "stand-out" tokens**:
  - `bg-primary-button-bg text-primary-button-fg` — inverted focal CTA button. One per screen.
  - `bg-highlighted-bg` / `border-highlighted-bright` — interaction emphasis, input focus, code-link highlights.
- **Repository sidebar only** = `bg-sidebar-bg` / `bg-sidebar-bg-hover`. The settings sidebar uses the default tokens.
- **Semantic status = the color families** — error→red, success→green, warning→yellow, info→blue, done→violet. Use `text-<family>-primary`, or `bg-<family>-bg`+`text-<family>-fg` for callouts.
- **Diff renderer** = the Zeros palette via `diff-theme.ts` — theme-adaptive structural surface (`--sidebar-bg` in the workbench, `--bg1` in EditCards) + green/red/neutral `--diffs-*-color-override` bases; @pierre derives the rest, syntax from Shiki.
- **Claude follows the Zeros Foundation skill on every UI task.** To steer it, reference recipes from `zeros-foundation.md` §4 and anti-patterns from §5. Say "primary button" for inverted CTA, "highlighted" for interaction emphasis.

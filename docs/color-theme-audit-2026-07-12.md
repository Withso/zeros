# Color & Theming Audit — 2026-07-12

Full-codebase review of the two-theme (dark default / light) color system: token
architecture, every UI surface, hardcoded colors, WCAG contrast, and the theme
plumbing (startup, live toggles, Electron pre-paint). Produced by a 5-track
parallel audit + programmatic contrast analysis of `styles/zeros-tokens.css`
(script preserved at `.context/contrast-audit.mjs`).

Severity legend: **BROKEN** = state/content invisible or unreadable in a theme ·
**DEGRADED** = readable but visibly wrong/weak · **STALE** = correct at mount,
wrong after a live theme flip · **NIT** = off-system but visually OK.

---

## 1. Executive summary

The token architecture is healthy and the `check:ui` linter keeps components
almost literal-free (only test-file hexes remain). The breakage is concentrated
in four systemic patterns, all light-theme, plus one family of live-toggle
staleness bugs:

1. **The code-theme never flips with the app theme** (`appearance/store.ts`) —
   light-theme users get dark syntax colors on white in the editor, chat code
   blocks, terminal ANSI, and diffs. Highest-impact single bug.
2. **`bg-bg3` used as chip/state fill on lower surfaces** (~29 call sites) —
   bg3 is pure white in light, so the fill vanishes.
3. **`bg-bg3/40`-style alpha washes on code/tool boxes** (~10 call sites) —
   white-at-alpha over white = invisible container in light.
4. **`--yellow-primary` was never re-anchored for light** (2.04:1 on white) and
   the @pierre file-icon palette is dark-only.
5. Four **stale-on-toggle** bugs (terminal in system mode, setup-tab xterm,
   review-tab diffs, chat EditCards).

Also: 3 dead shadcn utility classes that break in *both* themes, a mirror-image
dark-theme hover bug inside popovers, token-comment drift in the light block,
a startup FOUC window, and theme prefs stored in the OS-purgeable Caches dir.

---

## 2. What's solid (verified clean)

- **Token taxonomy & wiring** — primitives → `@theme inline` → utilities is
  coherent; `dark:` variant correctly matches `derive.ts` (always writes
  `data-theme="dark"|"light"`; legacy modes migrate on load).
- **`color-scheme`** is correctly declared per theme (`zeros-tokens.css:299,497`).
- **No raw hex/rgb/hsl literals** reach the UI outside documented allowlist
  files. No `text-white`/`bg-black` (except intentional scrims), no raw
  Tailwind families, no numeric ramp classes in components.
- **Family pairing discipline holds**: every `bg-<family>-bg` found carries
  `text-<family>-fg`; every `red-secondary` fill pairs `red-secondary-fg`;
  `inverted-bg` only ships with `inverted-fg` (switch, primary button).
- Popover primitives (dropdown/context/popover/hover-card/select/command) use
  bg3 + bg3-hover per spec; gradients fade from their true surface tokens;
  scrollbars, focus rings, markdown CSS, loaders, login, error boundary,
  electron IPC, assets (`currentColor` SVGs), globals.css — all token-pure.
- `window_set_background` pre-paint flow works end-to-end and re-reports on
  every flip.

---

## 3. CRITICAL — code-theme ↔ app-theme pairing is broken (BROKEN-LIGHT, systemic)

Design intent: code surfaces take backgrounds from app tokens; syntax colors
come from the user's `codeTheme`, whose *default* flips with the app variant
(`defaultCodeThemeForVariant`: dark → `github-dark-default`, light →
`catppuccin-latte`). Two bugs make the light branch unreachable:

- `src/zeros/appearance/store.ts:66-69` — the variant-aware default is computed
  **once, at module load**, only when no codeTheme is stored. Flipping the app
  theme at runtime never re-derives it.
- `src/zeros/appearance/store.ts:104-108` — `setPrefs` persists the **whole**
  prefs object, so the first settings change (e.g. `mode: "light"`) writes the
  load-time dark default into localStorage, converting it into a permanent
  "explicit pick". `code-themes.ts:76-78`'s light branch is dormant even though
  light shipped 2026-07-11.

Blast radius for a light-theme user (all default-config):
- **Code editor**: `shiki-highlight.ts:201` paints base fg `#e6edf3` (near-white)
  on white `--bg1` — near-invisible source text.
- **Terminal**: ANSI palette from the dark code theme; `ansiBrightWhite #ffffff`
  on white bg1 is literally invisible.
- **Chat code blocks**: dark-theme pastels on the light card.
- **Diffs (@pierre)**: `diff-theme.ts:45` feeds the same shiki theme to both
  slots and `themeType` follows the *code* theme, so @pierre's `light-dark()`
  derivations mix white into the white app bg — washed-out gutters/washes on
  top of wrong-polarity syntax colors.

**Fix shape (one place)**: re-derive the default codeTheme on variant change,
and stop persisting a codeTheme the user never explicitly picked.

Related staleness (independent one-line fixes):
- `terminal-session-view.tsx:596` — re-apply effect deps are
  `[prefs.mode, prefs.codeTheme, surfaceToken]`; in `mode:"system"` an OS
  appearance flip changes neither, so open terminals keep the old theme's
  resolved colors (wrong-theme block) until remount. Depend on the *resolved
  variant*.
- `src/shell/column3-tabs/setup-tab.tsx:178-181` — xterm theme resolved once in
  a mount-once effect; never re-applies on any toggle.
- `src/shell/column3-tabs/review-tab.tsx:301,381` — `zerosDiffOptions()` without
  a `useCodeTheme` subscription (file-viewer.tsx:792 does it correctly).
- `src/zeros/agent/renderers/tool-edit.tsx:195` — memo'd EditCard reads
  `getPrefs().codeTheme` per render but subscribes to nothing; existing chat
  diffs keep old syntax colors after a picker change.
- `store.ts:139-149` (root cause of the system-mode cases) — `onSystemChange`
  emits, but `prefs` is reference-equal, so `useSyncExternalStore` consumers
  bail; only CSS re-themes.

---

## 4. CRITICAL — `bg-bg3` as chip/state fill on lower surfaces (BROKEN-LIGHT)

In light, `--bg3` = `--bg1` = pure white; the documented rule (foundation §5.4)
is "never bg3 as a state/chip fill; the universal chip fill is `bg-bg2-hover`".
Violations found:

**Invisible chip/fill in light** —
- `src/shell/column1.tsx:313` (PROJECT_CHIP_CLS), `:319` (PENDING_CHIP_CLS) — sidebar project chips
- `src/shell/column2-topbar.tsx:143` (PROJECT_ICON_CLS)
- `src/shell/column3-tabs/changes-tab.tsx:467` — empty-state icon circle
- `src/shell/column3-tabs/discard-file.tsx:151,159`; `dialogs/publish-to-github.tsx:198,243`;
  `dialogs/open-github-project.tsx:198`; `dialogs/quick-start.tsx:191,341,345`;
  `dialogs/create-from-picker.tsx:325` — `<code>`/name chips + badges on bg1 dialogs
- `src/zeros/agent/composer-attachments.tsx:125` (+ redundant inner tile `:152`)
- `src/zeros/agent/composer-pills.tsx:81` — `bg-bg3-hover` resting pill on the bg2 composer
  (light: #F3F3F3 on #F3F3F2 — invisible)
- `src/zeros/agent/question-card.tsx:385` — selected checkbox fill
- `src/zeros/agent/jump-pills.tsx:73,101`; `renderers/text-message.tsx:234,238`
- `src/zeros/ui/primitives/badge.tsx:14` (secondary variant); `avatar.tsx:47,92`
- `src/zeros/ui/primitives/sidebar.tsx:484` — `hover:shadow-[0_0_0_1px_var(--bg3)]`:
  hover outline painted in white-on-white
- `src/zeros/browser/browser-variant-frame.tsx:201` — header drag bar
- `src/zeros/panels/dashboard-page.tsx:52`; `settings-page.tsx:426,834,1053`;
  `team-panel.tsx:745` (was `organization-panel.tsx`); `providers-panel.tsx:180,1088`;
  `github-section.tsx:46,155,242`
- `src/shell/column3-tabs/review-tab.tsx:434,515`; `dialogs/add-local-project.tsx:172`;
  `src/shell/column2-topbar.tsx:153` (rename input) — border-only survival, flat in light

**Same-on-same in BOTH themes** (bg3 chip inside a bg3 popover) —
- `src/shell/dispatcher/dispatcher-modal.tsx:231`; `dispatcher/create-from-source.tsx:179`;
  `src/shell/column3-tabs/browser-tab.tsx:1344`;
  `src/zeros/agent/project-context-chip.tsx:139`

**Sidebar hover misuse** — `src/shell/column1.tsx:307,339,345` use
`hover:bg-bg3-hover` on sidebar surfaces (taxonomy: `sidebar-bg-hover`); in
light it's near-invisible and lighter-than-rest on hovered rows.

---

## 5. CRITICAL — `bg-bg3/α` translucent washes (BROKEN-LIGHT, systemic in chat renderers)

White at 30-50% alpha over white = nothing. Borderless ones disappear entirely
in light:
- `src/zeros/agent/renderers/tool-edit.tsx:141`; `event-row-renderer.tsx:54,220`;
  `unknown-message.tsx:35`; `question-card.tsx:111`; `highlighted-code.tsx:192,201`;
  `src/zeros/panels/providers-panel.tsx:813` — all `bg-bg3/40`, borderless → invisible
- `src/zeros/ui/primitives/elements/tool.tsx:151` (`bg-bg3/30`),
  `code-block.tsx:26,32` (`bg-bg3/30` + `/50` header),
  `repositories-panel.tsx:235` — border survives, tint doesn't

**Fix shape**: use `bg1-highlight` / `bg2` (theme-aware greys) instead of
bg3-alpha for code/tool surfaces.

---

## 6. BROKEN IN BOTH THEMES — dead shadcn utility classes

`zeros-tokens.css` defines no shadcn aliases, so these classes generate no
color; `ring-1` then paints **full-opacity currentColor** instead of a subtle
tint:
- `src/zeros/browser/browser-variant-frame.tsx:197` — `ring-foreground/5`
- `src/zeros/agent/composer-editor/use-composer-editor.tsx:794` — `ring-foreground/10`
- `src/zeros/ui/primitives/elements/message.tsx:83` — `ring-border`

---

## 7. BROKEN-DARK — `bg2-hover` hovers inside bg3 popovers

Dark: `--bg2-hover` #292928 vs `--bg3` #2A2827 — imperceptible (and darkens,
wrong direction). Should be `bg3-hover`:
- `src/shell/column2-new-chat-menu.tsx:481` (also `border-border1` darker than
  the bg3 surface in dark → invisible outline)
- `src/shell/dispatcher/create-from-source.tsx:147,290`
- `src/shell/column3-tabs/browser-tab.tsx:1358`

---

## 8. Token-level contrast audit (WCAG 2.x, computed from actual CSS values)

### Light theme problems
| Pair | Ratio | Verdict |
|---|---|---|
| `yellow-primary` on bg1 (white) | **2.04** | FAIL — token kept its dark-theme value `hsl(37 75% 60%)`; every "modified / in-progress / warning" accent is barely visible. Used in 7 files (changes-tab modified counts, toast warning icons, question-card, composer pills, turn-footer, source-editor). |
| `yellow-primary` on bg2 | **1.84** | FAIL — `source-editor.tsx:140` save-error toast is unreadable in light |
| `yellow-fg` on `yellow-bg` | **2.75** | FAIL — warning containers |
| `muted-fg` on bg1/bg2 | **2.25 / 2.02** | FAIL — placeholders + empty-state icons very faint (`hsl(20 4% 68%)`); 40 usages |
| `fg3` on bg2 / bg1-hover / bg3-hover | 2.95 / 2.93 / 2.92 | below 3:1 (only 3 usages) |
| `green-primary` on bg1 | 3.37 | large-text only — but used for small +N diff counts |
| `red-fg` on `red-bg` / `green-fg` on `green-bg` | 4.13 / 4.00 | just under AA 4.5 |
| white on `green-primary` (Merge button, pr-status-island) | ~3.1 | marginal |

### Dark theme problems
| Pair | Ratio | Verdict |
|---|---|---|
| `fg2` on bg5 | 2.72 | FAIL (bg5 rare — no current usage found) |
| `fg3`/`muted-fg` on bg2-hover / bg3 / bg3-hover / bg4 | 2.9–2.2 | below 3:1 — muted text inside popovers/menus (e.g. shortcuts hints, placeholders in dialogs) |
| `muted-fg` on bg2 (composer placeholder) | 3.32 | borderline, conventional |

### Both themes — structural (design-review, not bugs)
- Borders are deliberately sub-3:1 (border1 vs bg1 ≈ 1.2), but in light
  `border3` — the **only** boundary of inputs/secondary buttons on white —
  is 1.40:1 (WCAG 1.4.11 non-text expects ≥3:1 for control boundaries).
- Terminal selection (`terminal-session-view.tsx:747`): opaque
  `--highlighted-bright` behind `--fg1` text ≈ 2.2:1 dark / 3.9:1 light —
  selected terminal text is hard to read in both themes.
- All fg1/fg2-on-surface pairs pass comfortably in both themes; all six
  family bg/fg pairs pass in dark; inverted + primary-button pairs are
  excellent in both.

---

## 9. Token file hygiene & doc drift

- **Hex comments no longer match actual values** in the light block —
  dangerous because the light theme was specified by exact user-provided hexes:
  - `--fg2`: actual **#625D5B** vs comment `#8E8885` (Δ44/channel). If #8E8885
    was the Figma spec, the shipped value is much darker (which incidentally
    *passes* AA at 6.49 where the comment hex would sit ≈3.2 — decide which is
    intended before "fixing").
  - `--fg3`: actual #938D8A vs comment `#B0ACAA` (and the comment hex equals
    `--muted-fg`'s — copy-paste drift).
  - `--brown-primary`: actual #AC5A53 vs comment `#BD7B75`; `--brown-fg`:
    actual #7A5252 vs `#6B4747`. Dark `--highlighted-bg`: actual #282624 vs
    `#231E1A`.
- `zeros-tokens.css:120-123` — stale comment "Kept for when the light theme
  returns" (light shipped 2026-07-11).
- `scripts/check-ui-consistency.mjs:51-52` — stale allowlist entries for
  deleted files `src/zeros/engine/zeros-styles.ts` and
  `src/zeros/engine/styles/index.ts`.
- Stale doc comments: `renderers/syntax.ts:362-364` references a
  `useCodeThemeColors` that doesn't exist; `markdown-code-block.tsx:6` and
  `code-theme-preview.tsx` headers still describe dark-only behavior;
  `terminal-tab.tsx:499` comment mentions bg3 the code no longer uses.

---

## 10. Startup & plumbing risks

- **FOUC window (light users)** — `index.html` has no inline `data-theme`
  stamp; the stylesheet applies dark `:root` before the JS bundle evaluates and
  the store's module-load flush runs. Pre-paint is white (persisted window bg),
  then possibly a dark paint, then light. Canonical fix: tiny inline script in
  `<head>` reading `zeros.appearance.v2`.
- **Theme pref durability** — `localStorage` (theme prefs) lives in the
  relocated `sessionData` under `~/Library/Caches/…` (electron/main.ts:333)
  while `window-background.json` lives in `userData`. If macOS purges Caches, a
  light user cold-starts white-pre-paint → dark app, pref silently lost.
- **`nativeTheme.themeSource` never set** — native context menus/dialogs follow
  the OS, not the app theme (forced-light app + dark OS = dark native menus).
  Note: naively setting it would break `matchMedia`-based system mode — sync it
  from the resolved variant carefully, or accept.
- **Cross-window `storage` handler skips mode validation**
  (`store.ts:154-164`) — the load path migrates legacy modes but the storage
  event path doesn't; a stale-version window can inject `mode:"zeros-shade"`
  (degrades to system resolution; Settings select renders empty). Low
  probability.
- `DEFAULT_PREFS.mode = "dark"` (not `"system"`) — first-launch macOS-light
  users get a dark app; consistent but worth a product decision.
- Dialog scrims are theme-static (`dialog.tsx:22` `bg-black/80`,
  `sheet.tsx:39` `bg-black/50`) — heavy over a light UI; design judgement.
- Toasts (`toast.tsx:100`, `update-toast.tsx:52`) hardcode a 45%-black shadow
  instead of `--shadow-dropdown` — it's the only lift a borderless white toast
  has in light, and it's off-system-heavy there.
- Popover primitives use Tailwind `shadow-md`/`shadow-lg` instead of
  `--shadow-dropdown` (dropdown-menu, context-menu, popover, hover-card,
  select; tooltip does it right) — works, but off-system, and shadow is
  load-bearing for lift in light.
- `code-editor/theme.ts:89` — CodeMirror `{ dark: true }` hardcoded; unstyled
  CM internals (autocomplete tooltip, fold placeholder) would take dark
  defaults on the light app. Should track the variant.
- @pierre file icons: `composer-editor/file-type-icon.tsx:58-89` (allowlisted
  dark palette via `style={{color}}`) and `workspace-file-tree.tsx:38-61`
  (TREE_THEME_VARS doesn't override `--trees-icon-*`) — file-type glyph colors
  are dark-theme pastels on white in light (yellow #ffd452 ≈ 1.3:1). Needs a
  light glyph palette (both places, to preserve the pill↔Files-tab parity).

## 11. NITs / asymmetries (fine today, fragile)

- shadcn `dark:` leftovers creating theme asymmetry: `select.tsx:41`,
  `input-group.tsx:15,28,137,153`, `settings-page.tsx:1332` (`dark:bg-bg1/30`
  tint only in dark), `alert.tsx:13` (`/50` border in light, full in dark);
  redundant `bg-bg2 dark:bg-bg2` in `agent-chat.tsx:3024`.
- Token-role misuse that happens to work: `browser-tab.tsx:1218` `bg-fg1` as a
  primary-button fill; `pr-status-island.tsx:92` + `file-viewer.tsx:565`
  `text-bg1`/`bg-fg2` swaps. Snap to `inverted-*`/`primary-button-*`.
- `electron/main.ts:789` dev-error page hardcodes dark (self-contained, fine);
  `iframe-picker-script.ts` fixed blue overlay into arbitrary web content
  (correct); `agent-brands.ts` fixed brand hexes (intentional).
- `dispatcher-modal.tsx:212`, `column2-chat-tabs.tsx:133` — bg3 inputs/chips on
  bg2 (visible, but violate "input bg matches parent").
- `question-card.tsx:392` — selected-check glyph is `text-fg2` (weak signal).

## 12. Out-of-scope surfaces (scoped, not deep-audited)

- **website/marketing** — separate deliverable, dark-only by design, with a
  *verbatim copy* of the token ramp → will silently drift from
  `zeros-tokens.css`. **website/web-app** — own hardcoded dark zinc palette.
- **backend** — email HTML is hardcoded light-on-white (correct for email).
- **apps/**, **packages/** — no UI surfaces.
- **snapshots/baseline/** — exactly one visual snapshot, dark only. **No
  light-theme visual regression coverage exists.**

## 13. Linter gap analysis (`check:ui` misses that let the above in)

1. `hsl()`/`oklch()` literals — not checked at all (only hex + rgba).
2. `*-white` / `*-black` Tailwind classes — regex only matches named families
   with numeric steps.
3. Dead shadcn token classes (`ring-border`, `ring-foreground`, `bg-input`…) —
   nothing validates that a color utility resolves to a defined token.
4. `bg-bg3` / `bg-bg3-hover` / `bg-bg3/α` as fills outside popover primitives —
   the documented §5.4 rule has no lint.
5. Tailwind `shadow-md|lg` on floating surfaces vs `--shadow-dropdown`.
6. Comment-hex ↔ value drift in the tokens file itself.
7. Stale allowlist entries aren't detected (files deleted).

## 14. Prioritized fix plan

1. **Code-theme pairing** (`store.ts`): derive codeTheme default from the
   *current* resolved variant; don't persist implicit defaults. Fixes editor,
   chat code, terminal ANSI, diff syntax for light in one change.
2. **bg3-as-fill sweep** (§4): mechanical replace with `bg-bg2-hover` (chips) /
   `sidebar-bg-hover` (sidebar) / `bg3-hover` (inside popovers).
3. **bg3-alpha washes** (§5): switch to `bg1-highlight`/`bg2`.
4. **Light anchors**: darken `--yellow-primary` (light) to ≥4.5:1 (~`hsl(37 95% 33%)`
   region), fix `--yellow-fg`, consider nudging `--muted-fg`, `green-primary`,
   `red-fg`/`green-fg`; resolve the `--fg2`/`--fg3` comment-vs-value question
   against the Figma source.
5. **Dead ring classes** (§6) + dark-theme popover hovers (§7).
6. **Staleness quartet** (§3 tail) + `{dark:true}` CM flag.
7. Light glyph palette for @pierre file icons (both call sites).
8. Startup: inline `data-theme` stamp in `index.html`; consider moving
   appearance prefs out of Caches-backed localStorage (or mirroring to
   userData).
9. Extend `check:ui` per §13; prune stale allowlist entries; fix token-file
   comments; add light-theme visual snapshots.

# Implementing the Zeros Design

The Zeros Design canvas holds the approved redesign of every Zeros surface: the
foundations (tokens), the shared components and every product page, desktop and
web. This plan turns it into code. It keeps the design system the single owner
of every look, and it leaves future agents a loop that keeps the UI consistent
as the direction changes.

- **Mode:** single session (the zstack default; no subagents were requested).
- **Instruction:** implement the canvas in the app, automate UI work for future
  agents through zstack, verify every frame, then update the canvas so each
  frame shows only the implemented UI.
- **Normative rules:** [design-system.md](../design-system.md). This plan never
  overrides it; when a decision here becomes a rule, it moves there.

## Sources

| Source | Holds |
| --- | --- |
| The Zeros Design canvas | One board per state, drawn as it ships. A board whose approved design is still scheduled carries a Planned line that names its section in `plans.md`. |
| `docs/design-implementation/<page>.md` | The approved changes and code notes, exported board by board from canvas version `1793762476-d72a`, before the canvas showed only the shipped UI (generated). Read the page's file before implementing any of its boards. |
| `styles/tokens/*.tokens.json` | Token values. The canvas palette lands here. |
| `apps/desktop/src/renderer/shared/ui/` | Primitives and layout blocks. Every page change composes them. |

Page specs: [Foundations](foundations.md) · [UI components](ui-components.md) ·
[Branding](branding.md) · [Web app](web-app.md) · [Agent chat](agent-chat.md) ·
[Sidebar](sidebar.md) · [Home](home.md) · [Files tab](files-tab.md) ·
[Changes tab](changes-tab.md) · [Review tab](review-tab.md) ·
[Design tab](design-tab.md) · [Terminal](terminal.md) · [Browser](browser.md) ·
[Simulators](simulators.md) · [Customize](customize.md) ·
[Settings](settings.md).

## The direction

These are the decisions the design rounds converged on. They are the bar for
any new surface, and the rules that can be checked move into
`docs/design-system.md` and `pnpm check:ui`.

1. **Few, quiet words.** A title and at most one line of description. A hint
   only when it adds something the label and value don't. Sentence case,
   tabular numbers, no `Error:` prefixes or transport detail.
2. **Rows in cards, not boxes in boxes.** Lists are grouped cards: `bg1-bright`,
   `border1`, 12px corners, 12 × 14 rows, 13/18 medium names, 12/16 `fg3` hints,
   28px controls right-aligned, one ⋯ menu for secondary actions. Status shows
   only when something needs the person.
3. **One banner, one message row, one empty state.** A banner is a 32px row on
   the panel's own background with a `border1` rule below; the 16px icon
   carries the tone (red error, yellow warning, a spinner or `fg3`); one line
   that ends in an ellipsis; 24px Ghost actions. A message inside content uses
   the same anatomy. An empty state is a 32px `fg3` icon and one 13/18 `fg2`
   line, plus one action only when it creates or configures something. The PR
   status row keeps its own strip.
4. **One surface language.** Canvas `bg1`; raised `bg2` or `sidebar-bg`;
   floating menus, popovers, tooltips, hover cards and toasts are `bg3` with
   `border2`, 12px corners, the dropdown shadow, a 4px inset and 28px rows with
   8px corners.
5. **One height per row.** 28 standard, 24 compact, 20 inline; glyphs 14, 12
   and 12. Controls in one row share a height.
6. **Color carries meaning, never decoration.** Status families keep one meaning
   each; errors are a true red; the selection blue belongs to the Design canvas
   and the active tool; everything else is neutral. Color is never the only
   signal.
7. **Keyboard focus is opaque and only for the keyboard.** Tab shows
   `highlighted-bright` with the 3px halo; a click or typing shows the caret.
8. **Hover belongs to the surface; selected is a step above it.** Rows use their
   surface's hover; sidebar, tree and layer selection is `bg2-highlight` with
   `fg1`.
9. **Two tab styles.** A segmented control switches a view; one strip tab serves
   chrome, workbench and chat. A closable tab shows ✕ on hover or focus over a
   fade in its own fill, so it never changes width.
10. **Menus say what kind of choice they are.** One choice: a check at the end of
    the chosen row. Several: a check column on the left. Destructive items last,
    in `red-primary`. Shortcuts are Kbd chips.
11. **Motion is color, opacity and transform**, 120ms ease-out, with reduced
    motion respected.
12. **Local and cloud are both first class.** Every surface states its Local
    and cloud behavior; cloud lifecycle never enters a tab banner.

## Workstreams

| # | Workstream | Outcome | Status |
| --- | --- | --- | --- |
| 1 | Canvas audit | Every frame renders without breakage in both themes; notes are clear. | Done |
| 2 | Foundation tokens | The proposed palette and the new feature tokens ship through `styles/tokens`, the contrast contract passes, hand-written copies follow. | Palette done; diff and canvas-label tokens land with their first callers |
| 3 | Primitives | Every shared component matches its UI components board, with tests. | Done |
| 4 | Shared patterns | Banner row, message row, empty state, settings group and row, list card row, canvas chip. | All but the canvas chip done; it lands with Design |
| 5 | Pages | Each page matches its boards, functional changes included, Local and cloud covered. | Every page done; the larger functional changes are scheduled in `plans.md` §1–8 |
| 6 | Automation | The direction lives in `docs/design-system.md`, checks enforce what structure can, and zstack carries a UI loop that learns from every approved change. | Done; it grows with each page |
| 7 | Verification | Gates green; harness renders compared with every board in both themes. | Gates and the ui-smoke registry pass; macOS-only checks not run here |
| 8 | Canvas final | Every board shows one final UI: the implemented one. | Done (canvas versions 358–359) |

Pages land in this order, simplest shared patterns first: Settings, Customize,
Sidebar, Home, Agent chat, Files, Changes, Review, Design, Terminal, Browser,
Simulators, Web app.

## 2. Foundation tokens

Values come from the canvas's proposed palette, which was checked against
`styles/policy/contrast-contract.json` in both themes. Dark changes:

| Token | Dark now | Dark proposed |
| --- | --- | --- |
| `bg1` (and `pane-bg`) | #121212 | #141414 |
| `sidebar-bg` | #171717 | #181818 |
| `bg3` | = `sidebar-bg` | #1C1C1C |
| `bg3-hover` | = `sidebar-bg-hover` | #2A2A2A |
| `border3` | #3D3D3D | #444444 |
| `border4` | #4C4C4C | #575757 |
| `highlighted-bright` | #A6A6A6 | #CACACA |
| `red-bg` / `red-fg` | #2C1B1A / #FDA172 | #341818 / #FFAAA7 |
| `red-secondary` / hover | #B62411 / #A82110 | #B32228 / #A72025 |
| `blue-bg` and `blue-pill-bg` | #142048 | #08233A |
| `blue-pill-hover` | #1A2B60 | #0E304D |
| `switch-thumb` | (semantic) | #0D0D0D |
| `design-selection-label-bg` | (semantic) | #0A6FC2 |

Light takes one warm tint (OKLCH hue 70) across neutrals at the same
lightness: `bg0` #FBFAF9, `bg1-highlight` #F8F7F5, `sidebar-bg` #FBFAF8,
`bg1-bright` and `bg2` #F5F3F0, `bg1-hover` and `bg3-hover` #F4F2F0,
`highlighted-bg` #EEEBE8, `bg2-hover` #EBE8E5, `sidebar-bg-hover` #EDEBE8,
`bg2-highlight` and `bg5` #E2E0DD, `bg4` #F1F0EE, `border1` #EBE8E4, `border2`
#E4E0DC, `border3` #CCC8C3, `border4` #BDB9B3, `fg1` and `inverted-bg` #2C2824,
`fg2` #514D49, `fg3` #5F5B57, `muted-fg` #6D6B67, `highlighted-bright` #4C4741,
`primary-button-hover` #443F3A, `red-bg` #FFE8E7, `red-fg` #AC262A.

New feature tokens, each with its first caller:

- Diff: `diff-add-row`, `-word`, `-gutter`, `-number` and the matching
  `diff-del-*` (dark #152D1A, #114320, #17351F, #4ADE80 / #3A1D1C, #5A2425,
  #462221, #F87272; light #E0F7E4, #BBE8C3, #D0EED5, #107234 / #FFE8E6, #FFC9C6,
  #FFDAD7, #C11F1F), read by `shared/theme/diff-theme.ts`.
- Design canvas: `design-gap-label-bg` #C21A87, `design-measure` #C11F1F and a
  named `design-selection-soft`; `padding-soft` and `gap-soft` retire.
- The selected-match wash moves from 55% to 54% over `sidebar-bg` so `fg1`
  stays above 4.5:1.

Hand-written copies that follow the dark `bg1`: `index.html` boot background,
the Electron native window background (`appearance-mode.ts`, `window.ts`), the
marketing `theme-color`, and the code editor wash in `theme.ts`.

## 3. Primitives

Each primitive changes in `shared/ui/primitives/` with its test in
`shared/ui/primitives/__tests__/`; APIs stay compatible until every caller has
migrated, then the retired names go in the same branch. The specs are in
[ui-components.md](ui-components.md). The summary:

| Primitive | Change |
| --- | --- |
| Button | Flat Primary and Destructive; Ghost shows Open; `aria-pressed` on Secondary and Ghost; built-in `loading`; disabled keeps hover for its reason tooltip; `variant="primary"` replaces `default`, one size name per height; the legacy `shared/ui/button.tsx` wrapper and icon sizes retire into IconButton. |
| IconButton | One hover (`bg2-highlight`) on every surface; inline 20 gets the ring and a fixed 12 glyph; neutral pressed; deprecated `hover` and `motion` options retire. |
| SplitButton, Toolbar | 28 halves, medium label, per-half focus, `muted-fg` chevron; one toolbar size (bar 36, buttons 28, icons 14), active tool in the selection blue. |
| Input, Textarea, Select | 13/18 text, 8px side padding, hover `border4`, keyboard-only ring, red invalid, compact 24; Select check at the end; Textarea three-line minimum. |
| Checkbox, RadioGroup, Switch, Slider | 16px boxes, 2px check, inverted fill when on, hover ring, 50% disabled; Switch thumb #0D0D0D in Dark; Slider track `border3`, range and thumb `fg1`. |
| Menus, Command, Popover, HoverCard, Tooltip | The floating recipe; menu choice rules; Kbd shortcuts; popover widths 240 / 320 / 400; tooltips solid `bg3`. |
| Dialog, Toast | 12px corners with `border2`; widths 400 / 520 / 640; one 16px inset; Ghost Cancel; toasts on the floating recipe at 360. |
| Tabs | Segmented and strip; active `bg2` + `fg1` medium; ✕ over a fade; Dark selected segment `bg4` without an edge. |
| PanelHeader, ListRow, SidebarRow | 28 actions; ListRow hover `bg1-hover` and no expanded fill; sidebar selected `bg2-highlight`. |
| Badge, Pill, Kbd, Avatar, StatusIcon | Badge one 20px size with tinted tones; two pill sizes; Kbd 18px `border2` chip; avatar badge outside the clip; status labels `fg3`. |
| ProgressBar, Card, Tile, Separator | `border3` 4px track; card `bg1-bright` + `border1` + 12; tile hover `bg2-highlight` + `border3`; scroll thumb `border2` → `border3`. |
| Banner (`WorkbenchTabFrame`) | The 32px row in the direction above. |

## 4. Shared patterns

| Pattern | Owner | Use |
| --- | --- | --- |
| Banner row | `shell/workbench/tab-status.tsx` | Every tab's persistent status. |
| Message row | `shared/ui/primitives/message-row.tsx` | A message inside content: setup checks, card warnings, section errors. |
| Empty state | `WorkbenchEmptyState` and a shared block | Tab bodies, lists, panels. |
| Settings group and row | `features/settings/settings-ui.tsx` | Settings, Customize, the web dashboard (CSS twin). |
| List card row | `SettingsRow`, `SettingsAddRow` and `features/agent-extensions/mcp-server-row.tsx` | MCP servers, skills, organization servers, any list of configured things. |
| Canvas chip | `features/design-workspace` | Every Design canvas readout. |

## 5. Pages

Visual changes follow from the foundation, primitives and patterns. The
functional changes below need their own tests (a usage example first, per
zstack) and their Local and cloud behavior stated.

| Page | Functional changes |
| --- | --- |
| Settings | One 640px column of grouped cards; status rows instead of filled callouts; GitHub method and agent rows on the list-card anatomy. |
| Customize | MCP servers and Skills as one segmented page; server rows with status badges only when needed, a ⋯ menu for Edit and Remove; gateway tool lists; the MCP editor and the Skill form share one layout (breadcrumb, title with the primary action, cards); Skill form Save is primary, Cancel retires. |
| Sidebar | Selected row `bg2-highlight`; counts 12px; one 16px icon column; repository actions appear over the name without reflow; every trailing mark in one 16px slot. |
| Home | List view as plain right-aligned rows on one subgrid with PR pills and status tags; the Create page for no repositories; the Island Z boot loader. |
| Agent chat | Composer and dock cards on `sidebar-bg` + `border2`; expanded tool output on `bg1` + `border1`; neutral chat and workspace link pills. |
| Files | Neutral tab names (only the status letter is tinted); File options uses the ellipsis; 24px empty-state icons; centered media islands; comments work like Changes. |
| Changes | One card per file with gaps; Retry diff as the header's one action; New/Deleted/Conflicted tags; bare Viewed checkbox (advances to the next unviewed file in the one-file view); message rows and skeleton loading; merge conflicts resolved in place with a navigator and side-coloured accept buttons (no Resolve panel); per-hunk Accept / Reject is removed, code included; gutter + comments with blue selection and no selection toolbar. |
| Review | Overview (Git status, PR status, Findings), Description, Activity, Checks and Commits; the Changes sub-tab goes; header in rows; Merge lives in PR status with the method menu. |
| Design | Setup screens and inspectors simplified; one canvas chip; property fields, popovers and the theme editor on the shared recipes. |
| Terminal, Browser, Simulators | Banner rows; empty states; one toolbar size; setup checks as message rows. |
| Web app | Settings-shell anatomy for the dashboard; the Island Z lockup; sign-in with Google and GitHub; no Local organization in the dashboard. |

## 6. Automation

The UI loop for future agents lives in zstack:

- `docs/design-system.md` carries the direction above in its agent brief, so
  the generated `zeros-ui` skills give every agent the same bar.
- `agents/zstack/playbooks/ui-design.md` adds the direction check and the
  learning step: when the person approves a new UI direction, the agent records
  it as a `changes/` fragment that names the rule and the check that will hold
  it, and `zstack-learn` folds it into `docs/design-system.md` and
  `pnpm check:ui`.
- Checks hold what structure can: the banner, message-row and empty-state
  blocks are the only way to render those states; menu, popover and tooltip
  surfaces come from one recipe; new arbitrary sizes fail `check:ui`.
- A render audit script screenshots harness pages in both themes and flags
  clipped text, overflow, overlaps, fallback fonts and unstyled controls, so a
  green check is never the only visual evidence.

## 7. Verification

Before each push: `pnpm typecheck`, `pnpm lint`, `pnpm check:ui`,
`pnpm test:git`, `pnpm check:secrets`, the adjacent `__tests__` suites,
`pnpm build:ui` for cascade changes and `pnpm test:ui-smoke` for overlays and
focus. Visual evidence comes from harness renders in Dark and Light compared
with each board. macOS-only gates (`pnpm smoke:engine`, the native app) are
listed as follow-ups when they cannot run here.

## Status log

Each landed step appends one line: date, workstream, what landed, evidence.

- 2026-11-04 · 1 · Canvas audit (version 357): lint over all 464 frames and
  local renders of every state in both themes (about 1,500 per theme). Fixed:
  an unclosed link and a stray closing tag; four notes whose text held raw
  tags, so words vanished; six helper classes no linked stylesheet defined;
  the Sidebar band overflowing 256px; a white Reset chip acting as a second
  primary; a blue filled callout with an underlined link in Files to copy; and
  the Foundations Red board still showing filled red boxes for in-content
  errors, now message rows. Remaining findings were intentional: user content
  (sample sites, canvas documents, PDF pages) stays white or serif.
- 2026-11-04 · 2 · Palette in `styles/tokens`: the dark and light values
  above, the dark switch thumb and selection label, the 54% wash; the contrast
  contract and the palette pins pass; the boot screen, Electron window and
  marketing theme colour follow. Unused `design-padding-soft` and
  `design-gap-soft` retire.
- 2026-11-04 · 3 · Primitives (commits `420f5dc`, `5059d93`, `7df2e03`): the
  action set (Button, IconButton, SplitButton, Toolbar), the field box and
  Field, choice controls, the floating family (menus, Command, Popover,
  Tooltip, Dialog, toasts, Kbd), the two tab styles, PanelHeader, ListRow, the
  sidebar row, Badge, Pill, Avatar, ProgressBar, Card, Tile and the workbench
  banner. 107 icon-only ghost Buttons moved to IconButton, `default` became
  `primary` and the legacy Button wrapper retired. Renderer suite 905 files
  pass; the 14 files that fail without ssh or a control-plane install fail
  identically on the base commit.
- 2026-11-04 · 6 · Automation: `docs/design-system.md` §0 holds the direction
  and how it changes, the agent brief that renders the `zeros-ui` skills
  carries it, `playbooks/ui-design.md` routes every corrected look to its
  owner and a check, `ui/icon-only-button` joins the policy, and four eval
  cases hold this round's escaped mistakes.
- 2026-11-04 · 4, 5 · Settings: the shared shell (40px title bars, 32px nav
  rows on one icon column, a hairline for the first and any one-item group,
  the 640px column, Open settings.toml in the title row), every panel on the
  grouped card, the shortened copy from the boards, Profile, Integrations,
  Agents, Models, Terminal Agents, Cloud Computer, Environment and Files to
  copy. Organization Agents is one titled card per agent with ⋯ for
  Disconnect and Remove, its load error said once and the browser note once.
  `MessageRow` joins the primitives; a Dialog footer straight under its header
  keeps the 16px inset. Renderer suite 904 files pass; harness renders in
  Dark and Light for Local and an organization.
  Decisions where a board was odd: method cards hover to `bg1-hover` like the
  RadioGroup card (a `bg2-highlight` hover read brighter than the chosen
  card); account rows use one 24px control height and the 32px avatar from
  the Avatar scale (the board mixed 24 and 28 and drew a 28 avatar); the
  first nav group has no label because the switcher above names it (the
  board said Local twice); the cloud credential notice keeps "until you
  disconnect"; organization copy says "this organization" rather than the
  sample name; the cloud browser note keeps the shared sentence; the
  simulator setup hint keeps its Xcode path, shared with the Simulators tab.
- 2026-11-04 · 4, 5 · Customize: the Settings shell (one 640px column, the
  title with the fixed scope select, MCP servers and Skills as a segmented
  control), server rows on one shared row (`McpServerRow`: a 48px transport
  column, status only when a server needs the person, one action, the
  switch and ⋯ for Edit and Remove), tool lists under the server name,
  message rows for errors and the tool cap, two skeleton rows while
  loading, and Add server as the card's last row. Skills are rows in one
  card with an inline Remove confirm; the Skill form and the MCP editor
  share a breadcrumb, a title with the primary action and cards of fields.
  The import and device-login dialogs say one line each. The organization
  page uses the same shell and rows. `SkeletonLine`, `SettingsAddRow` and
  `Badge mono` join the kit. The Customize ui-smoke run (form, tools,
  organization and connection flows) passes against the harness.
  Decisions: the server name still opens the editor (Edit is also in ⋯),
  which keeps one-click editing; "No browser?" reads "Sign in without a
  browser" as a menu item; row controls are one 24px height; the
  organization subtitle names the organization rather than "Shared with
  everyone", because the page also holds your own servers, whose add row
  reads "Add your own server" beside the header's Add server; columns end
  48px down (the 64px board value is off the spacing scale).
- 2026-11-04 · 4, 5 · Sidebar: 32px destination, folder and status rows on
  one 16px icon column (no layout border; the focus ring is drawn as an
  inset edge plus the 3px halo), section label 12/16 medium `fg3`, trailing
  controls 12px in, a fixed 48px profile row on the Avatar primitive with a
  12px `fg3` email. Repository settings and ⋯ appear over the end of the
  name on a fade instead of reflowing it; an open repository page fills
  its header `bg2-highlight`. Every trailing mark (stream, agent state,
  draft, unread, awaiting) takes one 16px slot, so Archive is one 24px
  button at one position; ± counts use one 4px gap; the repository chip
  is shared by headers, ungrouped and pending rows and the hover card,
  which now uses the floating recipe. The filter menu keeps 28px rows and
  two widths; the Set status check matches menu checks; repository menus
  are 208px.
  Decisions: grouped rows start their square on the header's 40px name
  column and centre the gutter mark on its 24px icon column (the board
  drew 38 and 20); the list keeps a 4px top inset so the first header's
  focus ring is whole; the filter button stays the 24px section-header
  size (the board drew 28); the organization switcher stays the
  full-width row from the Settings board with a 14px icon like the
  destinations; the Internal memory pill keeps its 280px sidebar floor,
  since at 256px it cannot sit beside the arrows (the board clipped the
  forward arrow).
- 2026-11-04 · 4, 5 · Home (board and list): the title drops its count
  (an announced status keeps it for search feedback), the view toggle is
  the segmented control on the shared segment tokens with lucide
  text-align-justify, search is 280px and leads the toolbar, repository
  filters are 28px pills that keep their fill under the pointer, columns
  sit on the 24px page edge 16px apart, and cards round to 12 with a
  border3 + bg2-highlight hover and a 4 / 8 / 8 rhythm. PR numbers are one
  `PrPill` (24px, the island's chip colours, no link icon) on cards, list
  rows, the repository page and the workspace hover card. The list is
  plain 40px rows 2px apart with a bg1-hover fill: title and branch on one
  line, then PR, a status tag, a repository chip, changes, a 20px owner
  avatar and the age, each sized to its content on shared columns; column
  names stay for screen readers without a drawn header row, and narrow
  windows drop labels, then Changes and Cost, then Owner. With the sidebar
  collapsed the Dashboard title row reserves the controls' corner instead
  of sitting under a 40px band. Compact controls carry 12px glyphs; line
  changes show only the side that changed, in sans with one 4px gap; the
  empty state is a 32 fg3 icon and one 13px line; dialog titles wrap long
  names; repository tabs use the segmented primitive's own sizes. The
  dashboard ui-smoke run (14 checks) passes against the harness.
  Decisions: the list keeps table semantics (rows are aligned columns, and
  the smoke and screen readers rely on them) rather than a list on a CSS
  subgrid; repository chips stay `bg2-hover` on cards (the board drew
  `bg2`, which vanishes on the `bg2` card); a measured 0 / 0 still reads
  +0 where an unknown count reads —; the owner avatar uses the profile
  initials rule.
- 2026-11-04 · 4, 5 · Home (start and boot): with no repositories, Home and
  the workspace page open the Create page beside the sidebar instead of the
  full-window welcome, and so does the workspace page with nothing chosen
  (routing only; the saved page is unchanged). Three start banners (Open
  project, Open GitHub project, Start from scratch) sit under the composer
  while no repository is chosen, one row as wide as it and one column when
  narrow, running the same flows as the Choose project menu; the branch
  picker waits for a repository. The Create composer is the shared
  `COMPOSER_SURFACE_CLS` (sidebar-bg + border2, no shadow, no focus
  change). The boot loader is the Island Z at 64px running the Weave in the
  fg1 → fg3 gradient on bg1; its colours are the token names with boot
  fallbacks a test holds equal to bg1, fg1 and fg3, and reduced motion
  rests on the Z. The welcome view and its PNG mask retire. The Create,
  folder-create, start-from-scratch and Create composer ui-smoke runs (40
  checks) pass against the harness.
  Decisions: Create stays an action, so with no repositories the sidebar
  keeps Home selected rather than drawing Create as a destination (the
  board drew Create selected); Start from scratch now chooses the new
  repository on the Create page instead of opening a workspace at once,
  as the menu entry already did; "nothing chosen" means no workspace
  folder at all, so a cloud or still-resolving workspace never reroutes.
- 2026-11-04 · 4, 5 · Agent chat (composer, dock cards, pickers, headers):
  the composer, sent prompts and every card above the composer (permission,
  question, approval, plan review, queued messages, goal) share
  `sidebar-bg` + `border2` with 12px corners, no shadow and no focus change,
  8px apart; the queued card is its own card rather than tucking under the
  composer. Cards pad 12 / 14 with a 10px rhythm and 13/18 titles; plan
  review and goal are 44px bars with a 14px icon. Answers are 32px
  borderless rows with 8px corners that fill `sidebar-bg-hover` (the Enter
  default rests filled), shortcuts are the 18px Kbd, and the command a
  permission asks about sits in a 36px `bg1` well with a `border1` edge, as
  does expanded tool output. The composer toolbar is one 28px height with
  4px gaps. The @, / and # pickers share one recipe (4px inset, 12px `fg3`
  header, 32px rows, 24px tabs, 232px cap) and the PR picker moves into the
  shared floating popover. Window headers are 40px with 12 / 6 padding and
  panel headers 36 with 12 / 4. Chat tab glyphs sit in a 16px slot, so titles
  no longer shift when a run starts, and labels are 13/18. The question
  card's dismiss and carousel controls are 24px icon buttons. Fixed on the
  way: `Button asChild` threw (Design layer rows, the API key link), a
  ListRow focus border moved rows off the subagent rail, and four smokes
  pinned replaced looks. Renderer suite 907 files pass; the chat ui-smoke
  runs pass against the harness at their registry viewports (composer
  editor 99, codex transcript 115, overlay positioning with tooltips 151,
  send failures 62, Codex runtime 36, Claude runtime 29, PR actions 28,
  summary 27, suggestions 24, sticky bottom 18, attachments 15, tools 9,
  activity 9, mentions 9, native tools 4, plus permission hints and the
  context gauge); chat titles needs the control-plane install and did not
  run here.
  Decisions: Close anyway, Discard and Approve keep their visible shortcut
  as one `ButtonShortcut` chip tinted from the button's text, with
  `aria-keyshortcuts`, replacing three hand-built hints; tooltips that only
  repeated a visible label (Copy, Reject, Approve) and the goal card's native
  `title` hints retire; every dialog Cancel is Ghost; Submit stays the 28px
  square primary from the board beside the round Send.
- 2026-11-04 · 4, 5 · Agent chat (header, strip, transcript states, pills):
  the first chat tab starts 8px in like the header and workbench strip; the
  workspace name starts on one column for branch, folder and cloud
  workspaces (one 28px placement box) and the workbench toggle is the 28px
  tool beside Summary; the Summary island's rows are 28 with 6px corners
  and its popover sits 6px off. Transcript loading, waiting, unavailable and
  "No chat history" share one 32px status row in the chat column, waiting
  reads like loading so the hand-off never jumps, Retry is a 24px Ghost,
  and the read-only history error is a message row in the same column. The
  read-only history bar is a dock card. Provenance icons sit on the
  composer's 14px text column; transcript pills and "N more" are the 24px
  control Pill; both attach dialogs take the shared 520px width; the
  Command search field fills its row instead of overflowing it. Checkpoint
  rows are 28px menu rows and the workflow panel is the floating surface
  with a 36px header. In the composer, every inline reference (mentions,
  attachments, chat links, older attachments) is the neutral 20px pill
  (bg2 + border2, 12/16, 4px gap) on 20px text lines, so a line holding one
  never grows; the queued-edit banner is a 32px row on the editor's column
  with a 24px Ghost Cancel; the Plan frame's dashes sit on the border so the
  edge no longer steps; the mode-name flash masks the pill it floats over;
  the context gauge and Tools popovers use the 12px inset with one 6px row
  edge, 28px tool rows on the group label's column, 14px status icons and
  one scroller; native `title` hints in the Tools popover and tool rows move
  to the shared Tooltip, and Truncated is a warning Badge. Fixed: the edit
  composer's class joined `relative` to its drag ring (both dropped while
  dragging a file); a new `ui/class-template-join` policy rule holds it.
  Renderer suite passes; 19 chat ui-smoke runs pass against the harness.
  Decisions: workspace links keep their blue pill and chat links take the
  neutral one, as the board draws; the 230px model popover and the sent
  prompt's absolute action row follow in the next step.
- 2026-11-04 · 4, 5 · Agent chat (menus, messages, transcript, cards,
  footer): the model menu is the shared menu (28px rows with no gap, 12px
  medium fg3 labels, every text 12px in, 20px row actions, the 240px small
  popover width); sent prompts' Edit and Copy are 20px inline icon buttons;
  message content clips without a scroll box and leaves 4px for focus
  rings. One code style everywhere in chat: 13/20 mono in markdown blocks,
  tool output and Read, inside the detail card with 8px corners at 13px.
  Every feed row (tools, agents, browser activity, the working timer, the
  thinking body) puts its label on one 20px column after a 12px icon
  column, nested bodies share the agent rail, and a group's list sits one
  8px gap under its header. The checkpoint rail spans 4–24px, clear of the
  lane's text. Task, compaction, budget, question and unknown records draw
  no card or scroller of their own inside the detail card, and their chips
  are Badges; the plan body gets the card's 12px sides. The composer's
  context chips (/add-dir, Design frame, Design tag) are the 24px control
  Pill, and at the 360px pane floor the Design tag keeps its mark so Design
  mode's toolbar fits one row. Continue is a 24px secondary button with the
  board's short hints; footer status is an outline Badge; the usage
  trigger is a 20px inline control. Notice actions keep even space above
  and below. Jump to your prompt now stays visible while the transcript
  scrolls (it lived inside the scroller) and sits on the column's edge. A
  split-down pane's floor is 240px, so the dock and a slice of transcript
  always fit. The transcript scroller is isolated, so code gutters and copy
  buttons no longer paint over the top fade, which now ends where the
  column starts instead of washing over the first prompt. The chat ui-smoke
  runs (20 scenarios, local links included) pass against the harness.
  Decisions: the sent prompt keeps the board's absolute action row with a
  2px gap; the 16px working loader hangs 2px into the gutter to centre on
  the icon column; budget and Continue copy follow the boards.
- 2026-11-04 · 4, 5 · Files (tab strip, header, tree, menus, empty
  states): workbench and terminal pills share one recipe (8px sides and
  gap, a 180px label cap, a 14px glyph slot, the 20px ✕ under a 40px fade);
  only the status letter is coloured. The file title is plain text on a
  28px row and every title action is a 28px tool, in Files, PDF, Word,
  media and the terminal header; row actions in the terminal session list
  stay 24px. Panel headers start text 12px in and end 4px from the edge,
  so the 32px banner lines up beneath them; a header too narrow for one row
  wraps its controls under the name instead of clipping. The open side
  column's toggle is a fill with no edge. Tree rows are 28px and the
  selected row fills bg2-highlight; the tree's menu is the shared menu.
  Every Files empty state is the one EmptyState block. File options is one
  28px row recipe behind an ellipsis. Viewed is the shared Checkbox and
  shows only beside a diff; in a File tab checking it keeps the file open,
  and the Changes host still walks to the next change. The view switch and
  the diff layout use the shared segmented control, Discard is a 28px icon
  button, and Copy is a 28px tool. Grouped files keep one 36px bar: the
  stepper and side toggle ride in the file header and the group name heads
  the side list. New-tab results are single 28px rows whose folder trims at
  its start (TruncateStart), the menu's search row is the 36px command
  input, and its load failure uses the list's one message line. Working
  folders' action bar is a 36px row with Ghost Select all and Deselect all.
  Markdown preview centres its column. Decisions: empty states keep the
  foundation's 32px icon (the boards show 24); the working folders bar keeps
  border2 to match the search row above it, as the board shows; the
  new-tab menu keeps its 280px width; Markdown keeps the 14px reading size
  of chat prose. The standalone Changes smoke cannot load its fixture here
  (outside Vite's serving boundary on this branch too) and is not in the
  ui-smoke registry.
- 2026-11-04 · 4, 5 · Files (Diff view, media, documents): workbench
  diffs (Changes and the Files Diff view) read in the plain editor's type,
  12px mono on a 1.6 line with numbers padded 12px, and the virtualizer
  estimates rows at that height; selection is the editor's fg1 at 18%. Chat
  edit cards and Review keep the 13/20 chat code style. In the Files Diff
  view removed lines are no longer part of the file: a drag passes over
  them and Copy leaves them out. A comparison that can't become an editor
  (too large, binary, deleted, partial) says so in the body with the one
  empty state and Turn off Diff view; only a partial read offers Retry, and
  the banner keeps read failures. Media controls are one centred floating
  Toolbar: playback, a divider, then zoom, at most 480px wide, the time
  hiding under 400px; an image's island fits its four tools. The PDF and
  Word island is the same Toolbar with the page stepper, a divider and zoom.
  The PDF password prompt is the empty state with the field and Open PDF.
  The save failure stays the floating toast, as the board shows. Follow-ups
  inside the diff library's shadow DOM: a + or − in the gutter padding with
  a 2px bar, no row wash for a new file, and the caret line's fg1 5% lift.
- 2026-11-04 · 5 · Files (comments in the editor): comments start as in
  Changes. The 24px comment column is gone, so code starts at the plain
  editor's edge; hovering a line puts a + on its number (the marker
  replaces the number, so nothing moves). A number click opens the
  composer on that line, a drag or Shift-click selects lines and opens it
  on release, and selecting code text stays a plain selection with no
  comment toolbar. ⌘⇧M still comments from the keyboard. The code-review
  and code-focus smokes hover the line before using its +.
- 2026-11-04 · 4, 5 · Changes (headers, states, list, comments): Retry
  diff is the file header's one action, a compact secondary button after
  the counts with the error in its tooltip. A status tag precedes the
  Viewed box (New green, Deleted and Conflicted red, Renamed grey; modified
  carries none), and Viewed is the checkbox alone with a Mark viewed
  tooltip. Every empty state is the shared EmptyState with one line, and
  the first load draws skeleton cards (the shared SkeletonLine, which has
  no shimmer) with Loading changes kept for screen readers. A viewed list
  row dims only its icon and name; rows are 28px, hover is the surface's
  and selection bg2-highlight. On every diff surface the + is a 16px blue
  chip, and releasing a number click or drag opens the composer: there is
  no selection toolbar. Follow-ups: per-file cards (border1, 8px corners,
  12px apart) need the virtualizer's item layout and the Changes smoke,
  which can't load its fixture here; retiring hunk review reaches the
  engine op, protocol schemas and the registered git-review-actions smoke,
  so it needs its own change; inline conflict blocks replace Resolve
  conflicts then.
- 2026-11-04 · 5 · Comments (Changes, Files, Review): the composer takes
  the agent composer's look, sidebar-bg with a border2 edge that stays put
  on focus, the range as its title and a borderless 13/20 field. One
  footer: where it goes (Workspace comment, or a Workspace / Pull request
  segmented control), ghost Cancel and the primary submit with its ⌘↵
  chip; the ⌘/Ctrl + Enter caption is gone, sending shows the spinner, and
  a moved PR diff is a yellow line above the footer. A reply keeps "Reply
  to …" as its name without printing it. A posted discussion is a bg2 card
  with a border2 edge whose 36px head sits over a border2 rule; Resolve and
  Reopen are compact secondary buttons, severity, Outdated and Original
  range unavailable are Badges, ↗ opens the source, a folded resolved
  thread shows a green Resolved pill with the author and comment count,
  and comments sit 16px apart with an initials avatar and the date beside
  the name; the Human label is gone and other authors carry a Badge.
  Follow-up: agent and review-app marks and GitHub photos in the avatar.
- 2026-11-04 · 5 · Review: merge methods use GitHub's names (Squash and
  merge, Create a merge commit, Rebase and merge) with the check at the end
  of the chosen row. The rest of Review is a rebuild with new reads (header
  rows, Overview with Git status, PR status and Findings, Description,
  Activity, Checks, Commits, the rail) and it must move Post to PR into
  Changes before the Changes sub-tab can go, so it has a code-level plan in
  `plans.md` with the other larger changes (Changes cards, hunk review,
  conflicts in place, diff gutter signs, comment author marks).
- 2026-11-04 · 4, 5 · Terminal, Browser, Simulators: the shared EmptyState
  takes an optional title (icon, title, one line, then the action), and the
  Setup and Run states use it ("Setup", or the action's name with its
  command or last outcome, then Start); the outcome badge that repeated the
  line is gone. A blocked terminal start is the tab's one banner row and
  the terminal stays empty; without a banner it still prints. The Browser
  toolbar holds 28px tools and a 28px omnibox with 6px corners and 13px
  text, its toggles use the shared pressed look, and a failure in a tab is
  only the banner row. The simulator check is one 32px status row (icon,
  what it found with the detail in fg3, the fix, then a refresh icon for
  Check again) instead of a filled card. The workbench-status smoke now
  pins the one-row banner.
- 2026-11-04 · 4, 5 · Design (states): no Design directory is the titled
  empty state (Design, Start designing) with Create design directory as
  the one primary action, which keeps its place and shows the spinner
  while it runs; checking is one quiet line with the spinner; a local main
  workspace and an unavailable directory use the shared empty state. The
  pages menu already puts the check at the end of the chosen row. The
  inspector, layer rows and the remaining Design states are in `plans.md`.
- 2026-11-04 · 5 · Web app: every centred page shares one shell on the
  app's tokens, so Light works: the Zeros logo top-left (16px mark, 12px
  gap), a 32px mark centred with no container, an 18/24 title, one 13/18
  line up to 560px, fit-width 28px actions that never underline, and quiet
  12px lines; the GitHub hero comes down to the same scale. The dashboard,
  account pages, Ops and the per-page copy are in `plans.md`.
- 2026-11-04 · 5 · Files: the video seek bar is the shared Slider (border3
  track, fg1 range and thumb) instead of a native range input. Slider takes
  `label` and `valueText` for its thumb, so the bar is named Seek video and
  reads its time in words ("0:12 of 1:30"), with a test.
- 2026-11-04 · 8 · Canvas (versions 358–359): every board now shows one UI,
  drawn as it ships. Current halves, Proposed dividers, change lists and
  proposal notes are gone; sheets keep their variants and specs; the five
  split All states composites fold into one board each. Where the build
  settled a board differently, the board follows the build (Settings and
  Customize copy and compact actions, Home's no-repositories sidebar, the
  Design setup states, the Changes and Review empty states). 108 boards whose
  approved design is still scheduled carry one Planned line naming their
  `plans.md` section: Review §1, Changes §2–6, the Files diff §5, Design §7
  and the Web app §8. Component sheets give usage as JSX elements outside
  tests, counted 2026-11-04. Boards take their natural height, so the canvas
  shrinks from 842,229 to 400,672 px of boards. Checked as plain local
  renders of every state in both themes (not the real viewer): 459 boards,
  no unfilled template text, no overflow, no leftover Current or Proposed
  tag.
- 2026-11-04 · 5, 6 · Review: a full review of the branch fixed nine issues,
  each with a test. A skill or connector that needs you shows its remedy
  again. One `initialsOf` helper replaces four. A text field in a Toolbar
  keeps its own Tab stop. Review on another Git host says it needs a
  github.com remote. The terminal's run action passes its registry icon.
  The import dialog's line says where values are saved. The organization MCP
  page says loading or a failed read once, without an empty shared card. A
  test pins the web pages' palette to the app tokens. The comment gutter
  looks up its line once per frame.
- 2026-11-04 · 5, 8 · Merge of main: its MCP import naming and recovery
  navigation render in the new layouts. Import rows stay checkboxes, with
  Imported and Name in use badges and an Import name field, and main's
  import test finds them by the checkbox role. The organization page opens
  a recovered server, says when it is gone, and keeps one status row.
  Canvas version 360 draws those states on the import dialog and
  organization page boards.
- 2026-11-04 · 7 · Verification: the full smoke registry passed on the
  branch head before the merge: shard 1 had 25 scenarios and 602 checks,
  shard 2 had 28 and 1,149, and shard 3 had 31 steps and 1,019, for 2,770
  in all. It caught two regressions, each fixed with a test and an eval
  case. The tab status letter and unsaved dot had lost their hover titles,
  and the Dialog close button sat 2px off the title line.

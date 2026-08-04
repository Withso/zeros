# Design Workspaces — the v1 implementation plan (v3)

_2026-07-31, third revision. v1 planned the in-place mode toggle (now Appendix
A). v2 pivoted to dedicated design workspaces (agreed). v3 — this document —
is the **first-version implementation plan**, incorporating Arun's decisions
(reference layout, pen-tool icon, no split panes, pure HTML+CSS, the design
tool layer) and a second research pass: Nordcraft's open-source engine,
paper.design's MCP, Figma/Framer constraint delivery, and a full map of Zeros'
MCP infrastructure. The `design-mode` branch is cut at `7fdb66b`; this
workspace targets it. Visual companion: `docs/design-mode-plan-2026-07-31.html`._

---

## 0. Locked decisions (from Arun, 2026-07-31)

1. **Separate workspaces, not a mode.** Design workspaces live at
   `~/zeros/design workspaces/<repo>/<name>` — git worktrees on their own
   branches, sparse-checked-out (cone) to only `Zeros Design/`. Confirmed.
2. **Top bar**: design workspace tabs show a **pen-tool icon** where code
   workspaces show the git-branch icon.
3. **The shell follows the reference mock**: left column = design-agent chat
   (multiple tabs, **no split panes**) with **Layers | Assets** below the
   composer; center = dot-grid canvas, floating toolbar (select, frame,
   shape, pen, text, comment, code view), zoom control; right = inspector
   (Design/Prototype tabs; align row; Position & size incl. radius; Auto
   layout gap/pad; Fill; Stroke; Export). Agent replies render structured
   "change cards". Layers/Assets may become a separate panel later — v1
   implements the reference as-is.
4. **Pure HTML + CSS.** Agents produce only `.html` and `.css`. No JavaScript
   in design files — like paper.design / Framer canvas semantics / Nordcraft.
   The style editor speaks HTML+CSS only.
5. **A native design tool layer for agents is foundational** ("very, very
   important") — must work identically for Claude, Codex, Cursor, and future
   agents; the agent must understand frames, selection, and the constraints.
6. **Components later, but the foundations must anticipate them** — Figma-like
   mockup components that are still just markup.
7. **Themes/variables table later** — but tokens are foundational now.
8. Code-mode write protection of `Zeros Design/`: cooperative for now
   (explicitly deferred by Arun — "for now, let it be").

---

## 1. The basement, in one view

Five foundations, each chosen so every later feature (components, themes
table, prototype tab, style editor growth) lands on top without rework:

| Foundation | The v1 form | What it future-proofs |
| --- | --- | --- |
| **Document = plain files** | `Zeros Design/*.html` (one frame per file) + `*.css` (shared stylesheets) + `tokens.css` + `assets/` + app-owned `.zeros-canvas.json` | Git, diffs, agents' native editing fluency, portability. The anti-Nordcraft decision: their single-JSON model forced a bespoke engine, versioning, and ~90 consistency lint rules |
| **Style vocabulary = real CSS, nothing invented** | Inspector groups are *views over declarations* (Nordcraft's model); tooltips name the real property; tokens are `var(--…)` | The style editor, the themes table, and agent edits all speak one language; no proprietary ontology to migrate off |
| **`tokens.css` = typed tokens + the layout reset** | `@property`-declared custom properties (syntax/inherits/initial/per-theme values) + an `@layer reset` giving Figma-auto-layout defaults (everything `flex column`, `box-sizing:border-box`) | Themes = attribute-selector token sets over the same file; auto-layout inspector = plain flex; the future variables table is a UI over this file |
| **Element identity = stable `data-oid` + parse5 offsets** | Agents stamp `data-oid` on elements (self-healing pass fills gaps); parse5 `sourceCodeLocationInfo` maps oid → exact byte ranges | Selection→source, layers panel, surgical style writeback, MCP node addressing, component instances — all hang off one ID scheme |
| **One mutation + validation layer in the engine** | Every write path (agent file edit, future inspector edit, future MCP write tool) converges on: validate → splice file → lint → broadcast | Constraints enforced uniformly regardless of who edited; change cards derivable; MCP write tools become thin wrappers later |

---

## 2. The document model (D-DOC)

```
Zeros Design/
  tokens.css            ← @layer reset + @property tokens (+ theme blocks later)
  home.html             ← one frame = one file
  pricing.html
  shared.css            ← agents may add shared stylesheets (linked from frames)
  assets/               ← images (served-frames phase)
  components/           ← RESERVED for the component model (empty in v1)
  .zeros-canvas.json    ← frame geometry/z-order — app-owned, agents never write it
```

**The frame contract** (the agent-facing rules; enforced per §4):

- One `.html` file = one frame. Skeleton: `<!doctype html>`, `<html>`, `<head>`
  with `<link rel="stylesheet" href="./tokens.css">` (+ optional other local
  css links), `<meta name="zeros-frame" content="width=1440,height=900,
  title=…">` size/title hint (honored on first discovery), `<body>` = the
  design.
- **HTML + CSS only. No JavaScript**: no `<script>`, no `on*` attributes, no
  `javascript:` URLs, no storage/network APIs (nothing to call them from).
  Consequence: frames are inert documents — safe, portable, and exactly the
  semantics of a Figma frame.
- References only inside `Zeros Design/` (physically self-enforcing in the
  sparse worktree — nothing else exists). No external network (CDN fonts etc.)
  in v1; system font stacks + tokens.
- Styling discipline: use `var(--token)` from `tokens.css` for color, spacing,
  radius, type where a token exists; per-frame `<style>` or shared `.css` for
  the rest; classes with **readable names** (Nordcraft's hashed atomic classes
  are explicitly avoided — files must stay human/agent-legible and diffable).
- Every element the agent writes carries `data-oid` (short, stable, unique per
  file). The app's self-healing pass adds missing ones and repairs duplicates
  on save (Onlook's `handleMissingOid` shape).
- Layout: flex containers, not absolute x/y (the reset layer makes flex-column
  the default — the same rule Figma's skill enforces as "wrap structural
  children in auto-layout, not absolute coordinates").
- Edit style: targeted `str_replace`-shaped edits; full rewrite past ~30% of
  the file (Anthropic's own artifact heuristic). Multiple files per turn
  explicitly licensed.

**`tokens.css` seed** (written at workspace creation when absent, then
agent-stewarded):

```css
@layer reset { /* Figma-auto-layout defaults, Nordcraft-style */
  [data-oid] { display:flex; flex-direction:column; flex-shrink:0;
               position:relative; box-sizing:border-box; margin:0; }
  /* text tags inline; lists unstyled; images block — full reset in seed */
}
@property --bg1 { syntax:"<color>"; inherits:true; initial-value:#0c0c0d; }
/* …a starter ramp: bg/fg/accent/border + spacing + radius + type scale … */
```

Typed `@property` tokens are the load-bearing choice: the future
themes/variables **table** is a straight UI over this file (name, syntax,
per-theme values), and themes ship later as `[data-zd-theme="…"]` blocks in
the same file — no new storage, no migration. (Nordcraft compiles its token
system to exactly this target; we simply author the target directly.)

**`.zeros-canvas.json`**: `{ frames: { "home.html": {x,y,w,h,z} }, view? }` —
single-writer (the app). Frames are discovered by globbing `*.html`
(top-level only; `components/` excluded); an agent writing a file *is* frame
creation; auto-placement assigns the next free grid slot.

**Component-ready conventions (built now, used later):** the `components/`
directory and the `zd-` custom-element-style tag prefix are reserved. The
future model — per the "Figma-like mockup component, still markup" direction:
a component is an `.html` file in `components/` (its markup + a `<style>`
scope); an *instance* is a `<zd-button label="Get started">` element in a
frame; the **renderer expands** instances at render time (files keep the
compact instance tag), props flow as attributes + CSS custom properties
(Nordcraft's instance-styling pattern), and the v0 grounding rule applies:
an instance is valid only if its definition file exists (lint-enforced).
Nothing in v1 implements this; everything in v1 is compatible with it.

---

## 3. The design workspace (D-WS) — mechanics locked in v2, unchanged

- Creation: branch → worktree under the sibling root (layout rules generalize
  `managedRepositoryDirectory` + `worktreesRoot()`, `worktree.ts:606-622`) →
  seed `Zeros Design/` + `tokens.css` + `.zeros-canvas.json` with an
  "Initialize Zeros Design" commit when the folder isn't tracked (sparse
  validation requires a tracked top-level dir; `sparse-checkout.ts:358+`
  refuses unknown dirs) → `setWorkingDirectories(cwd, ["Zeros Design"])` →
  skip code rituals (no setup scripts, files-to-copy, dev instances).
- Schema: `workspaces.kind` (migration v27) threaded like `setup_state`;
  `chats.mode` (v26) stamped from workspace kind at `bornChatThread()`.
- Enforcement: codebase physically absent; root files cooperative v1 (tiny-ACL
  hardening later via the dormant `design-lock.ts`); code-side protection of
  `Zeros Design/` cooperative + Claude deny rules + git visibility (Arun-
  approved deferral; option matrix preserved in v2 text/history).
- Lifecycle (archive/delete/rename) unchanged; Working-folders popover hidden
  in design workspaces (their sparse config is system-owned).

---

## 4. The design tool layer (D-MCP) — the foundational answer

### 4.1 The decision

**An engine-hosted, first-party MCP server** ("zeros-design"), injected into
every agent session of a design workspace. Grounds for confidence, from the
codebase map:

- **All three adapters already deliver MCP servers per session** — Claude via
  SDK `mcpServers` (`claude-sdk/adapter.ts:2108-2128`, `:2243`), Codex via
  `-c` TOML CLI overrides (`codex/app-server.ts:974-1001`, spliced at `:346`),
  Cursor via SDK option (`cursor-sdk/adapter.ts:1337-1354`). Both transports
  (stdio + Streamable HTTP) everywhere. Future agents inherit it the same way.
- **The engine already runs a real MCP server** — the gateway
  (`src/engine/agents/gateway/server.ts`, `@modelcontextprotocol/sdk`,
  Streamable HTTP on loopback). The design server reuses that stack as a
  second, first-party endpoint (registering local tools instead of proxying).
- **The injection chokepoint exists**: `resolveSessionMcp`
  (`gateway.ts:433-471`) already unconditionally prepends a synthetic
  `zeros-gateway` entry with a reserved-name guard. `zeros-design` becomes a
  second conditional push, keyed on the workspace kind — which requires
  threading `workspaceId` into the resolver (available at both call sites,
  `gateway.ts:793`/`:854`). That is exactly the "workspace-aware server" work
  the repo's own MCP audit flagged as the one real design task
  (`docs/mcp-consolidated-architecture-audit-and-test-plan-2026-06-30.md:286`).
- Constraint to respect: **Cursor caps ~40 tools across all servers**
  (`mcp-registry.ts:6-8`) — the design toolset stays small and consolidated
  (Anthropic's own tool-design guidance: fewer, higher-signal tools).
- Excluded surface: terminal agents (cosmetic PTY launches, no injection
  point) — design workspaces don't offer them anyway.

**Native MCP, not an API or CLI**, because: it's the only per-session,
per-workspace channel all three adapters share; MCP results carry images
natively (screenshots); the `instructions` field at initialize is a uniform
per-session rules channel; and the field has converged on it (paper.design's
entire agent story is a local Streamable-HTTP MCP at `127.0.0.1:29979/mcp`;
Figma, Subframe, Webstudio, Pencil likewise). Framer's CLI+skills route exists
for *external* harnesses — Zeros IS the harness, so we get skills for free via
our own system-prompt template.

### 4.2 Editing model: files first, tools around them

The agent's **write path stays file editing** (Edit/Write on `.html`/`.css`).
Rationale: it's what coding agents are trained on (claude.ai artifacts are
literally files edited via `str_replace`); Framer measured tool-call-per-edit
as too slow for canvas work; and tool-exclusivity is unenforceable anyway —
only Claude supports per-tool denies (`claude-sdk/adapter.ts:2048-2061`);
Codex and Cursor have no mechanism (map in the MCP audit). The MCP layer
therefore provides what files cannot: **context, perception, validation, and
guidance** — and in a later phase, optional structured write tools that share
the inspector's mutation layer (§6).

"The agent uses only design-native tools" is achieved the honest way:
in a sparse design worktree **there is nothing else to edit**, the contract
and lint make the good path the only passing path, and Claude additionally
gets hard path rules. That is stronger in practice than a tool ban two of
three agents would ignore.

### 4.3 The v1 toolset (7 tools — small by design)

All tools are workspace-scoped (the server resolves the calling session →
workspaceId → design dir). Names indicative; final naming in implementation.

| Tool | Input | Returns | Why |
| --- | --- | --- | --- |
| `get_selection` | — | `{frame, filePath, nodeIds[], breadcrumb, rects, keyComputedStyles}` or "nothing selected" | The anchor of every canvas conversation (paper.design/Figma both center on live selection). Backed by engine-held canvas selection state |
| `list_frames` | — | frames: file, title, w×h, node count, last-modified | Orientation; cheap |
| `get_frame` | `{frame, depth?}` | source path + meta + a compact tree summary (tag/oid/text≤80, depth-limited) | The sparse-tree tier (Figma `get_metadata`, Paper `get_tree_summary`) — token-cheap structure without re-reading the file |
| `screenshot_frame` | `{frame, nodeId?, scale?}` | base64 image content block | Perception — the Framer lesson (blind agents fail). Phase-2 wiring (offscreen capture); tool ships when real |
| `lint_design` | `{frame?}` | violations with **stable rule IDs**, spans (oid + line), and fix hints | The constraint engine's mouth (§4.4) |
| `get_tokens` | — | parsed `tokens.css`: names, syntax, values (per theme), usage counts | The design-system vocabulary (Figma `get_variable_defs` equivalent); powered by the salvaged `EngineCache` token indexer |
| `get_guide` | `{topic}` | frame contract / layout rules / tokens guide / component rules (later) | Progressive disclosure of the rulebook (paper.design's mechanism; keeps the system prompt short) |

Deferred to the structured-write phase (v2 of the server, alongside the
inspector): `write_html {target, html, mode}`, `update_styles {edits[]}`
(batch, token-strict validation), `set_text {edits[]}`, `create_frame` — all
returning `{affectedOids[], lintResults[]}`, all atomic (validate-then-apply,
no partial writes — the Figma/Webstudio rule), all thin wrappers over the same
engine mutation layer the inspector uses.

### 4.4 The constraint architecture (how agents "understand all the constraints")

Four layers, ordered by reliability — the synthesis of Figma skills, Framer's
linter, Vercel's split rule, Nordcraft's schema-with-descriptions:

1. **Contract up front.** One design-workspace block in
   `packages/core/src/system-instructions/templates.ts` (reaches all three
   agents through existing delivery — in-band Claude/Cursor, native
   `developerInstructions` Codex) + the MCP `instructions` field at
   initialize + `get_guide` for depth. Contents: the frame contract (§2),
   the Vercel-style rule of thumb (concrete, checkable rules only — "use
   var(--token) for colors when a token exists", not "make it consistent"),
   and the workflow (inspect → edit → lint → screenshot).
2. **Deterministic validation on every change, regardless of writer.** The
   **design-lint engine** (engine-side) runs on file save (watcher-triggered),
   on `lint_design` calls, and before any future structured write applies.
   v1 rules (stable IDs): `no-script` (script/on*/javascript:), `local-refs-
   only`, `frames-are-valid-html` (parse5), `oid-missing`/`oid-duplicate`
   (auto-fixed by the self-healing pass, reported), `unknown-token`
   (`var(--x)` not in tokens.css — the Nordcraft `unknownCSSVariable` rule),
   `no-external-url`, `component-undefined` (reserved). Warnings tier later:
   contrast, overflow, spacing-scale (the Framer hard-rules suite).
3. **Feedback that closes the loop for every agent.** MCP writes return
   violations in-result (`isError` + named rule + fix — the model self-
   corrects). File edits get the loop via **turn-end lint**: when an agent
   turn completes with violations present, Zeros surfaces them as a change
   card and auto-sends a correction message (the shipped auto-sent-message
   pattern from the PR island). This is the only enforcement that works
   uniformly — Codex/Cursor included.
4. **Hard rules where supported.** Claude: `permissions.deny` path rules +
   (optionally) tool denies. The sparse worktree remains the physical layer
   under everything.

### 4.5 Selection → agent context (both directions)

- **Push (on send):** selecting a frame/element and sending a prompt attaches
  the selection as context — the exact shipped pattern of the browser picker
  (`submitElementsToChat`, `browser-tab.tsx:1511-1573`: text block with
  tag/selector/styles + screenshot content blocks + display chips) and the
  `@selection` mention family (`mentions.ts:33-53`, literally built for "the
  live Design-mode browser selection") — retargeted at canvas selection.
- **Pull (mid-turn):** `get_selection` reads live engine-held selection state,
  so the agent can re-query while working ("the user just clicked something
  else"). No mid-session push channel exists in the engine (confirmed) — the
  pull tool is the clean fit.
- **Change cards** (the reference mock's structured replies): v1 derives
  "Updated frames: Pricing, Dashboard" cards from the existing per-turn
  authored-file attribution (turn `files`), plus lint results; the agent is
  prompted to summarize edits as short operation lines. No new protocol.

---

## 5. The design shell (D-UI) — implementing the reference

Mount: workspace `kind === "design"` swaps the surface at the single column-3
mount point (`app-shell.tsx:1036`; whole-column-swap precedent
`column3.tsx:437-445`). Column 2 (chat) stays but gains design behaviors.

**Top bar.** Pen-tool icon replaces `GitBranch` in workspace-tab rail entries
for design workspaces (`top-bar.tsx` — GitBranch sites `:481/:574/:663/:951`;
the rail entries take the conditional). Diff-count badge: hidden for design
workspaces in v1 (open UI detail).

**Left column (chat + panels).**
- Multiple chat tabs, **no splits**: gate the three `splitPane(` call sites
  (`column2-panes.tsx:450/:461/:509`) and their affordances (drop-zone
  splits, menu items) on workspace kind. Pane tree stays trivially
  single-leaf.
- Composer unchanged (same agents/models; "Claude · Design" chip is the
  normal agent/model selector — a design-flavored default label is a UI-phase
  choice). Chats stamped `mode: "design"`.
- Below the composer: **Layers | Assets** tab strip.
  - *Layers* (Phase 2): the selected frame's DOM tree via the injected
    runtime (tag/name, visibility eye, hover-highlight, click-select;
    Enter/Shift+Enter/Tab traversal). v1 ships the panel frame with a
    frames-list placeholder (each frame row + its file).
  - *Assets* (Phase 3): `assets/` contents + drag-to-canvas.
- Agent replies: change cards per §4.5.

**Center (canvas).** The v2 canvas plan unchanged: extracted viewport hook
from `browser-tab.tsx:318-524` + `BrowserVariantFrame` chrome; frames =
sandboxed `srcDoc` iframes (`allow-scripts` only — needed solely for OUR
injected runtime; the files themselves contain none), local CSS links inlined
at render (build-variant-srcdoc precedent) until the `zeros-design://`
protocol phase; flat stable iframe container, never reparented; overlays and
selection chrome drawn **outside** the iframes in screen space (the Nordcraft
editor protocol: geometry messages out, pointer events resolved against
scale); hot reload off the coarse git watcher + content-hash keys.
- Floating toolbar v1: **select** (pointer), **frame** (creates a new `.html`
  from the skeleton), **text** (Phase 3 inline text), **code view** (`</>` —
  opens the frame's source read-only in v1). Shape/pen/comment ship later
  (the mock shows the full set; v1 renders the bar with the later tools
  hidden or disabled — UI call).
- Zoom control (− % +) bottom-right; ⌘/Ctrl-wheel zoom, space-drag pan,
  Shift+1/2/0 fit/selection/100%.

**Right column (inspector).**
- v1: **read-only inspector** — selection header (name + element type),
  Position & size (X/Y/W/H from canvas geometry for frames, layout rects for
  elements; radius), Auto layout block (direction/gap/pad read from computed
  flex), Fill/Stroke (computed background/border), all values displayed from
  the computed-style readback. Design/Prototype tabs render with Prototype
  disabled. Export section stubbed (Phase 4: PNG export via the screenshot
  pipeline).
- Phase 3 turns it editable (§6). Building read-only first means the
  vocabulary, grouping, and css-parsing land before write-back complexity.

---

## 6. The style editor foundations (D-STYLE, Phase 3)

- **Vocabulary**: the inspector's groups are views over real CSS declarations
  (Nordcraft's model — verified down to their code): Position & size,
  Auto layout (= flex: direction/gap/padding/align), Fill (background),
  Stroke (border), radius, typography, effects; tooltips show the real
  property; an "Advanced" free-form group is the escape hatch for anything
  unmodeled. Property metadata (allowed keywords per property) generated from
  MDN/webref data, not hand-curated (their `cssPropertyKeywords.json`
  approach).
- **Round-trip**: CSS text ⇄ structured controls via a css-parser layer —
  reference Nordcraft's Apache-2.0 `packages/css-parser` (shorthands,
  gradients, shadows, transforms, `var()`; normalization via a scratch
  `CSSStyleDeclaration`).
- **Write path = the shared mutation layer** (the D-MCP write tools' future
  substrate): validate (lint rules, token-strict option later — Builder's
  "Style Strict Mode") → surgical splice at parse5 offsets for `.html`
  `<style>`/`style=""`, and the salvaged `CSSFileWriter`
  (`src/engine/css-writer.ts:27` — in-place declaration rewrite, formatting
  preserved) for `.css` files → broadcast; echo-suppression via content hash.
- **Transient preview** while dragging controls: apply to the live iframe DOM
  first, commit the file on release (Nordcraft's `preview_style` message —
  their protocol file `packages/runtime/src/editor/types.ts` is the spec to
  mirror in our penpal runtime).
- Instant tier costs no agent turn and no tokens (the v0/Figma
  point-and-edit consensus); the composer with attached selection is the
  structural tier.

---

## 7. What the field settled (research digest, additions in v3)

| Source | The v3-relevant lesson |
| --- | --- |
| **Nordcraft** (Apache-2.0, repo-verified) | Real-CSS property vocabulary as the whole style ontology; css-parser round-trip; auto-layout as a reset layer; typed `@property` tokens with per-theme values; canvas = iframe running the real renderer with geometry messaged out and overlays outside; schema descriptions as the AI contract; ~90-rule lint engine keeping a graph consistent — the tax their JSON document model pays that files avoid |
| **paper.design** | The closest shipped architecture: HTML/CSS-native canvas + local Streamable-HTTP MCP (21 tools); `get_selection` anchors agent context; `write_html` insert/replace; batch style/text tools returning IDs; `get_guide` delivers rules as a tool; "agents edit designs by generating HTML — a language they already understand" |
| **Figma MCP + skills** (skill files read verbatim) | Constraint delivery = versioned skill docs teaching the valid document model + hard gates ("cannot mutate until discovery steps complete") + per-call operation budgets + screenshot/metadata self-validation + atomic execution ("failed scripts never execute"); `create_design_system_rules` emits a codebase-aware rules file |
| **Framer** | Deterministic linter = "instant, absolute feedback"; constraint-by-bias toward defined styles/swatches; external agents = skills + CLI (no MCP) because they don't own the harness — Zeros does, so the system prompt is our skill channel |
| **Webstudio / Subframe / Builder / v0 / Vercel** | Validate-then-apply patches that reject invalid references; async design jobs + targeted node edits; token-strict mode toggles; "if a component/prop/token can't be verified from source, don't use it"; "deterministic checks go to linters, judgment goes to skill guidance — rules must be checkable, with stable IDs" |
| **MCP spec** | `instructions` at initialize = uniform per-session rules channel; image content blocks = screenshots native; `isError` results = the self-correction channel; tool-input JSON Schema = the hard validation layer |
| *(carried from v1/v2)* | claude.ai artifacts = files + `str_replace` + ~30% rewrite heuristic; Onlook's canvas/bridge/oid architecture; iframe discipline; two-tier editing consensus; nobody ships two-way code⇄canvas binding — the file stays the only source of truth |

---

## 8. Execution phases (v3)

All work lands on `design-mode` (cut at `7fdb66b`; this workspace targets
it). Neutral seam refactors go to **main** first: extract the canvas viewport
hook from `browser-tab.tsx`; rename the browser ⌘⇧D picker (frees "Design");
optionally lift `build-variant-srcdoc` into a shared module. Gates per
AGENTS.md throughout (`typecheck`, `lint`, `check:ui`, adjacent vitest,
`test:git`, `check:migrations` for v26/v27, `ui-smoke` for composer/overlay
touches, failing-test-first).

**Phase 1 — the workspace + the loop** *(agent designs render live)*
- Engine: migrations v26/v27; design root + creation flow (branch → worktree →
  seed `tokens.css`/`.zeros-canvas.json` → sparse cone → skip code rituals);
  frame discovery + geometry; design-lint engine core (`no-script`,
  `local-refs-only`, valid-HTML, oid rules, `unknown-token`) running on save;
  oid self-healing pass.
- Design MCP v1: server on the gateway stack; `workspaceId` threaded into
  `resolveSessionMcp`; tools `get_selection` (frame-level), `list_frames`,
  `get_frame`, `lint_design`, `get_tokens`, `get_guide`; `instructions` at
  initialize.
- Agents: design-workspace template block in `templates.ts` (frame contract +
  workflow); Claude deny rules; `ZEROS_CHAT_MODE=design`.
- Shell: pen-tool top-bar icon; no-split gating; design column (canvas with
  extracted viewport hook + variant-frame chrome, srcDoc + CSS inlining, hot
  reload, frame drag/resize/rename writing `.zeros-canvas.json`); left panel
  scaffold (Layers tab = frames list placeholder, Assets stub); read-only
  code view (`</>`); turn-end lint surfacing + change cards from turn file
  attribution.
- **Exit criteria:** create a design workspace on a repo with and without a
  pre-existing `Zeros Design/`; prompt each of Claude/Codex/Cursor → frames +
  tokens.css written → render live → `lint_design` catches an injected
  `<script>` and an unknown token → turn-end card surfaces violations →
  agent corrects on the auto-follow-up → commit exists on the design branch →
  a code workspace reads the files; Claude in code mode refuses to edit them.

**Phase 2 — selection, layers, perception**
- Injected runtime (inlined into srcDoc) + penpal bridge: layer tree
  (TreeWalker map, MutationObserver, ~500 ms debounce), `getElementAtLoc`,
  computed styles, geometry readback; overlay click-to-select with
  screen-space chrome; Layers panel goes live (visibility eye, hover
  highlight, keyboard traversal); element-level `get_selection`;
  selection→composer attachment (retargeted `submitElementsToChat` +
  `@selection` mention); `screenshot_frame` (offscreen capture) for both the
  agent tool and thumbnails; parse5 offset map service.
- **Exit criteria:** click any element in any frame → layers highlight +
  breadcrumb + inspector (read-only) populate; "make this heading tighter"
  with a selected element produces a correct targeted edit from all three
  agents; agent screenshots its own frame and fixes an overflow it sees.

**Phase 3 — the style editor + structured writes**
- Read-only inspector → editable: the shared mutation layer (validate →
  splice via parse5 offsets / `CSSFileWriter` → lint → broadcast; echo
  suppression); css-parser round-trip; transient drag preview
  (`preview_style` pattern); Position & size / Auto layout / Fill / Stroke /
  radius / typography groups; inline text editing on canvas; frame CRUD from
  the toolbar (frame tool, duplicate/delete); Assets panel (files +
  drag-in); MCP structured writes (`write_html`, `update_styles`,
  `set_text`) as wrappers over the mutation layer; "Save designs" commit
  affordance.
- **Exit criteria:** a fill change via the inspector lands in the file as a
  minimal diff without an agent turn and survives an agent's next edit; the
  same operation via `update_styles` produces the identical diff; git shows
  clean, readable changes for both.

**Phase 4 — scale, assets, hardening, polish**
- `zeros-design://` privileged protocol (relative assets, per-response CSP,
  serve-time runtime injection, cache-busting); lint warning tier (contrast/
  overflow/spacing via layout rects — the Framer suite); virtualization
  tiers + screenshot swap for far frames; export PNG; propose-directions
  cards via the question card; root-file tiny-ACL hardening; PR affordance;
  component-model spike (`components/` + `zd-` expansion in the renderer) —
  its own design doc before build; themes table over `tokens.css`.

---

## 9. Risks & open questions

| # | Item | Position |
| --- | --- | --- |
| 1 | Cursor's ~40-tool MCP cap shared with user-configured servers | Design set is 7; monitor composition; gateway `disabledTools` exists per backend if a user's servers crowd the cap |
| 2 | Agents ignoring the no-JS rule under pressure ("make it interactive") | Lint blocks + turn-end correction loop; prompt names the boundary explicitly ("interactivity belongs to the Prototype phase, not markup") — measure in Phase 1 exit tests |
| 3 | Codex/Cursor lack hard tool/path denies | Accepted (Arun); environment + lint loop is the uniform layer; Claude gets hard rules |
| 4 | srcDoc + inlined-CSS divergence from the eventual served pipeline | Same composition function used by both; protocol phase swaps delivery, not semantics |
| 5 | Selection state races (user re-selects mid-turn) | `get_selection` returns a timestamp + the send-time attachment is immutable per prompt (the Figma dropped-selection bug class, designed against) |
| 6 | Lint false positives blocking flow | Rules have stable IDs + severity tiers; v1 blocks only the safety class (script/refs/validity); style discipline starts as warnings |
| 7 | `.zeros-canvas.json` merge conflicts across design branches | Single-writer per worktree; geometry conflicts resolve trivially (last-write); revisit if shared design branches emerge |
| 8 | Change-card fidelity (agent narration vs reality) | Cards derive from turn file attribution + lint (ground truth), agent prose is secondary |
| 9 | Component model specifics | Deliberately deferred to a Phase-4 design doc; v1 only reserves conventions (§2) |
| 10 | Prototype tab, comments, pen/shape tools | Mock renders them; v1 disables; sequencing is a UI-phase call |

---

## 10. Confirmations wanted (small — the big decisions are made)

1. Toolbar v1 scope: ship the full bar with later tools disabled, or a
   shorter bar (select / frame / text / code view) that grows?
2. The "Claude · Design" chip: a design-default agent label, or just the
   normal agent/model selector?
3. Diff-count badge on design workspace tabs in the top bar: hide, or show
   design-file counts?
4. "Save designs" (commit) in v1 Phase 1, or Phase 3 as planned?
5. Layers/Assets as column-2-bottom panels (per mock) confirmed for v1 —
   the "maybe separate later" idea parks until after Phase 2.

---

## Appendix A — the v1 in-place mode toggle (superseded, preserved)

Design Mode as a modal state of a code workspace (ACL whole-tree lock, column
swap, mixed-mode chat tabs) — fully specified in this document's v1 revision
(git history) and `docs/design-directory-read-only-lock-2026-07-30.md`.
Superseded by separate design workspaces; the ACL module remains available as
Phase-4 root-file hardening.

## Sources

v3 additions — Nordcraft: github.com/nordcraftengine/nordcraft
(component.types.ts, style.css.ts, variantSelector.ts, theme.ts/theme.const.ts,
customProperty.ts, formula.ts, schemas/, css-parser/, runtime/src/editor/types.ts,
examples/projects/small.json) · docs.nordcraft.com (element panel, themes,
default styles, components) · changelog.com/podcast/643 ·
blog.nordcraft.com (responsive design). paper.design: paper.design/docs/mcp
(toolset) · github.com/paper-design/agent-plugins ·
designerfounders.substack.com/p/paper-stephen-haney ·
paper.design/blog/a-real-space-to-design-in-the-age-of-agents. Figma skills:
github.com/figma/mcp-server-guide (figma-use SKILL.md, figma-generate-design
SKILL.md read verbatim) · developers.figma.com/docs/figma-mcp-server/tools-and-prompts/ ·
figma.com/blog/the-figma-canvas-is-now-open-to-agents/ ·
figma.com/blog/design-systems-ai-mcp/. Patterns: docs.webstudio.is/university/cli.md ·
vercel.com/blog/teaching-agents-product-design-at-vercel ·
v0.app/docs/design-systems-2 · builder.io/c/docs/fusion-design-system-intelligence ·
docs.subframe.com/guides/mcp-server · github.com/tldraw/agent-template ·
docs.onlook.com/developers/architecture · anthropic.com/engineering/writing-tools-for-agents ·
modelcontextprotocol.io/specification/2025-06-18. In-repo (v3):
src/engine/agents/gateway.ts:433-471 · gateway/server.ts · adapters (claude-sdk
:2108/:2243, codex app-server.ts:974, cursor-sdk :1337) ·
docs/mcp-consolidated-architecture-audit-and-test-plan-2026-06-30.md:286 ·
src/engine/css-writer.ts · src/engine/cache.ts · browser-tab.tsx:1511-1573 ·
mentions.ts:33-53 · top-bar.tsx (GitBranch sites) · column2-panes.tsx
splitPane sites. Full v1/v2 source lists retained in git history of this file.

# Design workspace

**Status:** Current implementation and compatibility contract. Foundation
schema v1, Design API v1, and DOM renderer protocol v2 are frozen interfaces.

This guide describes the implemented editor, checkout-backed Design API,
shared native agent tools, and compatibility contracts. The
[shared-session v1 plan](design-v1-implementation-plan.md) describes the agreed
implemented minimal composer modes and shared-session integration. The
Design tab and shared managed Git foundation are implemented.
The [roadmap](design-mode-roadmap.md) retains the later feature phases.

The unused private authored backend and separate Design-session admission have
been removed. Current authored source remains in the checkout. Autosave stays
silent, failures use actionable feedback, and review stays compact and undimmed.
Private journals, receipts, and evidence remain engine-owned recovery/cache
state; they are not a second authored source store.

## Product and workspace model

A Zeros workspace has one managed Git worktree, one checked-out branch, and one
Git index. Code and Design are concurrent views of that checkout; they are not
separate worktrees, branches, copies, projections, or execution backends.

```text
Shared native agent + Design mode ─► HTML/CSS/assets/canvas.json in the checkout
                                               ▲
Human canvas + optional Design API ─► DesignDraftStore (checked transactions)
                                               │
                                  workspace watcher → canvas refresh
```

The active Design directory comes from the private `[design] directory_id`
selection and the `design.toml` manifests in this checkout. Legacy `[design]
directory` paths remain readable. `Zeros Design/` is the unconfigured pointer
default; the explicit Create Design directory action creates `<repo name> -
Design/` when no Design folder exists. Opening the tab alone does not create
files. A single discovered folder is reused. The Design directory menu selects
a workspace-local stable ID; Settings manages repository defaults and rename.
Source remains materialized and readable from both surfaces.

### Shared workbench navigation

The permanent Design tab sits beside Files, Changes, Review and Context in the
existing workbench. The same conversation column stays present. Its directory
header, Layers and Inspector belong inside Design; Layers/Inspector visibility
is adjustable for narrow layouts. Selecting a tab changes no agent mode.

`workspace.kind`/`viewMode` and `workspace.setMode` remain serialized legacy
contracts, including existing creation flows. On first use, a legacy Design
selection opens Design once; subsequent choices survive reload without forcing
Design again. These fields do not authorize human Design editing. The implemented
composer modes and provider tool gating use separate conversation-owned state.

Frame/node selection, camera, layer disclosure and panel visibility are keyed
by workspace. A stable directory ID survives rename; replacing it resets the
old document selection/camera and runtime foundations. Switching back to an
older directory starts a fresh document view; it does not restore a second
per-directory editor history. Existing app-wide panel width preferences remain.
At most two visited Design canvases are retained. Inactive tabs/owners and a
collapsed workbench are inert, hidden and inactive, with stable iframe DOM order.

`design.initialize` is an explicit local managed-workspace operation. It creates
or adopts metadata without changing workspace kind, HEAD or the index. Directory
selection waits for pending edits, changes only the workspace-local pointer and
invalidates exact-owner reads. Mutations carrying an old directory ID are
rejected, and queued local edits retain the directory identity they started in.
Missing, ambiguous, conflicted or unsupported manifests show recovery
feedback instead of silently creating a replacement document. Repository Settings
rename remains an explicit main-checkout rename commit: live checkouts keep their
own paths through a compatible stable ID; legacy/incompatible pointers block it.

### Source, metadata and personal state

```text
<repo>/
  Product - Design/
    design.toml         engine-managed registration and stable directory ID
    canvas.json         editable scene, frame IDs, sources and geometry
    rules.md            short native-authoring and compatibility instructions
    home.html           authored frames
    tokens.css          shared tokens
    components/         shared components
    assets/             images and other assets
  .zeros/               ignored private settings and local state
```

Code mode may inspect Design files. User-authorized Design mode uses normal
provider file tools to author HTML, CSS, assets and `canvas.json`. The Design
surface and optional API edit the same files. Generic app file-editor and
discard routes keep their existing Design guard; managed Git may stage, commit
and integrate authorized Code and Design changes. Mode instructions do not
provide a hostile-process filesystem boundary.

Commit the folder, `design.toml`, `canvas.json`, `rules.md` and referenced source
together. Uncommitted work is local to the checkout. Registration and generated
rules are managed by Zeros lifecycle operations.

Repository Settings → Design → Directory scans the main checkout, including
untracked Zeros manifests, without requiring any worktrees. Its folder list
supports inline rename (double-click or the pencil; Enter/blur saves and Escape
cancels) and choosing an existing folder. Rename preserves the selected directory
when another row is renamed.

The trash action is **Remove Design registration**, with an explicit confirmation.
It preserves the directory and all authored source/assets, removes only its
manifest, legacy registry entry/document metadata, and unmodified generated rules,
and forgets this checkout's remembered registration. Custom rules are preserved.
The preserved source becomes ordinary Code, including a folder named `Zeros
Design`; the legacy default read path alone does not establish Design ownership.
Tracked metadata removal is committed separately from staged source changes so
HEAD/index discovery cannot immediately restore the removed registration. All
open workspaces for this repository must be archived before removal; every
workspace may now be editing Design, regardless of its legacy kind. The operation is local-only
and uses the engine's Design-owner handoff and workspace mutation lane. Other
worktrees retain their own committed copies until updated through normal Git.
Choosing the folder again preserves `canvas.json`; old metadata can also be
recovered from Git. Source-only rebuilding is the explicit fallback.

The current manifest is registration-only:

```toml
format = "zeros-design"
version = 2
id = "design_example"
canvas = "canvas.json"
```

`canvas.json` v1 contains stable frame IDs, a single page, flat HTML source paths,
geometry, titles and Foundation metadata. It contains no node tree or duplicate
HTML. Unknown supported extensions survive engine writes; camera state, grants,
journals and caches remain private. See the [native authoring contract](design-native-authoring.md)
for a complete example and bounds. Legacy v1 manifests with inline document v3
and null-pointer encoding remain readable and migrate on explicit authoring.

Discovery validates `format = "zeros-design"`; a file named `design.toml` alone
does not make a folder Design territory. Working-tree discovery is bounded,
skips private storage, dependencies and nested repositories, and refreshes on
Design entry, Settings listing and watcher recognition changes. Exact Git index
and HEAD manifests also preserve ownership of old paths during moves. A moved
folder retains its ID. Duplicated IDs, overlapping folders, unsafe paths,
symlinks, hard links, malformed metadata and competing copies pause writes.

The Files tab receives validated Design roots alongside its file listing through
both the native and engine bridge paths. Root-level Design folders appear in the
separate **Design files** section, including uncommitted portable manifests and
legacy registrations. Nested folders keep their existing place in the tree.
The listing and ownership share one cached snapshot per checkout, so refreshing
metadata without changing filenames still updates the split. An unrelated
`design.toml` never establishes ownership. Older engines that omit the ownership
field retain the legacy canvas-marker fallback.

Repository Settings → Design → Directory → **Use existing folder** explicitly adopts a source folder
inside the repository. The preview first uses existing metadata, then looks for
saved metadata in the index and HEAD (including older formats). Without saved
metadata it rebuilds frame information from source, leaving authored files
untouched. Canvas positions and other metadata-only values cannot be recovered
from source alone. The preview identifies that case before confirmation and is
checked again before writing. If selecting it would invalidate a live worktree,
the folder is registered while existing selections stay active. Commit it and
update those worktrees before using the normal folder selector. Deleting
`.zeros/` loses private preferences but
leaves per-folder identity and shared metadata intact; folders are rediscovered
without a central registry.

### Migration and Git

Read-only access remains compatible with `.zeros/design-dir.toml`,
`.zeros/design/design-dir.toml`, `.zeros/design/design.toml`, each central
`<id>/document.json` or `metadata.json`, and source `.zeros-canvas.json` markers.
On explicit Design prompt entry or a Design write, every entry in a central registry migrates into its source
folder before the old storage becomes private. IDs, geometry, Foundation data
and extensions are preserved. Recoverable transactions write canvas files and registration manifests
before removing predecessor files. Legacy canvas markers and inline frame
metadata migrate through the Design API. Interrupted older transactions remain
recoverable. Reading an older branch does not rewrite it.

Design Stage, Unstage and Commit include the selected source folder and its
manifest. During migration, projection of shared legacy registry entries keeps
other folders' staged and committed states independent. Directory renaming moves
source and manifest together in one scoped commit; the private selection retains
the same ID. Shared workspace Git can include recognized Design roots and legacy
metadata; generic file-editor and discard routes retain their Design guard.
Archives finish recoverable writes before capturing source and metadata.

Design writes maintain an idempotent block in the root `.gitignore`: ignore
`/.zeros/` and keep Design manifests and rules visible. The previous
`.zeros/design/` exception is removed. Existing exclusions for other files,
including private files inside a chosen folder, are preserved.
A higher-priority ignore rule that still hides Design metadata pauses the write
and identifies the conflicting paths. This changes ordinary working files;
it does not stage, commit or push. Review and commit the `.gitignore` change as
repository configuration. Files already tracked under `.zeros` remain tracked
until their migration deletions are committed; Git ignore rules cannot untrack
existing commits.

Surfaces that can enter Design ask the engine first (`design.listDirectories`
returns the entry `target` and whether it exists). The empty Design tab offers
"Create design directory". The composer Design tag changes authoring intent;
it does not create a directory or change the selected workbench tab.

Legacy `workspaces.view_mode` selects the initial surface. `kind` remains a synchronized
compatibility mirror for older clients. Switching views does not run checkout,
stash, sparse-checkout, stage, commit, merge, rebase, pull, or process migration.
The retained legacy workspace mode endpoint publishes the row and initial
Design snapshot together; a refused transition keeps the original selection.
It is separate from the current composer tag and workbench tab selection.

The legacy workspace transition may initialize a missing foundation as ordinary
uncommitted files. Exiting leaves the working tree and index unchanged. A durable transition
marker lets startup finish an interrupted database/surface transition without
rewriting the checkout. The generic Working Directories feature may use
user-selected sparse-checkout, but it is unrelated to Design containment and is
unavailable while the Design surface is active so it cannot hide an open
document.

The existing conversation is shared by Code and Design. The composer + menu
adds a removable Design tag; the separate Design tab does not change mode.
`agentRole: "design"` session requests remain rejected before provider admission.
Provider permission/Plan modes are independent of composer authoring intent.

## Canonical Design foundation

Web frames remain portable HTML and CSS in the Git worktree. The browser DOM is
a sandboxed render, measurement, and hit-test projection; it is not a second
persisted document model. Derived trees and snapshots may be cached only as
bounded, exact-version projections.

```text
Authored HTML/CSS
      │
      ▼
source adapter ── identity, spans, diagnostics, provenance
      │
      ▼
transaction kernel ── revision, validation, inverse, history, receipt
      │
      ▼
versioned Design API
      ├── desktop workbench
      ├── headless/CI callers
      └── scoped future agent adapter
      │
      ▼
renderer adapters ── sandboxed DOM iframe first
```

The shared Foundation core is pure TypeScript. It cannot import React,
Electron, Node filesystem APIs, or browser globals. Filesystem authorization,
atomic writes, render preparation, and sandbox lifecycle stay in their engine
or renderer owners.

### Stable identity and source

- Selectable authored elements use stable `DesignNodeId` values, currently
  serialized as `data-oid`. Identity never depends on DOM `id`, CSS classes,
  source offsets, array position, iframe lifetime, or instance order.
- Missing or duplicate markers are healed with minimal source changes. A source
  offset is location metadata, never identity.
- Component internals use definition-local identity. A nested instance address
  combines its root instance with a bounded ordered path of component and
  definition-node IDs.
- The source adapter parses HTML with source locations and CSS with source
  nodes. Normal edits preserve unrelated bytes, comments, declaration order,
  quoting, and reasonable local formatting; full-document serialization is not
  the normal mutation path.
- Authored, matched, computed, inherited, preview, token-bound, component,
  responsive, and state-specific values remain distinguishable. The inspector
  must not present a computed value as authored source or invent cascade
  certainty.
- Base responsive/default interaction state is the only generally authorable
  context in Foundation v1. Breakpoint and pseudo-state writes fail closed
  until an adapter can identify their exact at-rule and selector target.

### Transactions, revisions, and history

Every durable source, style, text, geometry, component, parameter, variant, and
keyframe edit is a validated, versioned semantic transaction. Temporary
previews and frame-catalog lifecycle commands are not document transactions.

A transaction includes a schema version, stable transaction and document IDs,
an exact base revision, actor identity and kind, intent, typed operations, and
optional coalescing metadata. A batch is atomic to its caller. Reusing an
idempotency key with identical canonical content returns the prior receipt;
reusing it for different content fails.

The authored revision is a deterministic, locale-independent 96-bit SHA-256
prefix over textual document files, the Foundation manifest, and frame
geometry. It is a conflict key, not the render generation. Fully composed
output and binary assets are covered by the separate `sourceVersion` used by
iframe, screenshot, and cache protocols.

An exact-base mismatch is a conflict, never permission to overwrite a newer
draft. External edits publish a new revision, reconcile identities that still
survive, clear unsafe redo state, and retain the last valid render when the new
source is invalid.

Undo and redo send inverse/original semantic operations through the same source
adapter. Pointer gestures coalesce to one history entry; rendered documents and
screenshots are never copied into each entry. History is bounded and belongs to
the opened document session. A shared-resource edit remains undoable only from
the frame session that initiated it until a future workspace transaction can
represent multi-frame history atomically.

Frame create, rename, duplicate, and delete are atomic workspace lifecycle
commands outside document undo. Subtree duplication assigns fresh stable IDs;
subtree deletion targets one authored subtree; `keyframes.set` surgically
creates or replaces one named animation. All document operations retain CAS,
receipt, and byte-exact inverse guarantees.

Components, parameters, bindings, and variants have stable schemas even where
the complete management UI is deferred. Parameters have typed values, bounds,
options, units, bindings, and visibility metadata. An executable v1 parameter
is unbound or bound to one document; binding creation atomically synchronizes
its value into source. Variants store validated deltas instead of document
copies.

### Durable store and Design API

`DesignDraftStore` adapts the journaled document implementation for both the
trusted human surface and scoped callers. It provides:

- exact-revision compare-and-swap;
- atomic filesystem commits and crash recovery;
- idempotent receipts and bounded per-actor undo/redo;
- bounded source, projection, foundation, provenance, and diagnostic reads;
- immediate publication of the confirmed draft revision.

The active draft is durable repository content, but durability is not a Git
commit. `design.save` validates the live draft only. Stage and commit remain
separate, explicit actions.

Confirmed edits are written to `<workspace>/<selected Design folder>` by the
engine; agents may also author files directly in Design mode. HTML, CSS, assets,
`canvas.json`, `design.toml`, and `rules.md` are ordinary
versioned source. A gesture previews locally until release; typed fields publish
on their editor's commit boundary (usually Enter/blur). An unsubmitted field is
not yet a durable edit. Cmd/Ctrl+S publishes the focused field and waits behind
pending edits before validating the draft; it does **not** stage any files.
Private journals, view state, review receipts and result bundles live under
`<Zeros app data>/design-storage/<workspace-path hash>/`; quarantined recovery
records use the adjacent `design-transaction-recovery/` directory. The stable
macOS app-data default is `~/Library/Application Support/com.zeros/`, with
separate beta/dev/instance directories and a `ZEROS_DATA_DIR` override for cloud
and tests. Repository `.zeros/` holds private settings and compatibility state;
it is not the authored autosave store. Undo/redo history is bounded in memory.
For a cloud workspace, the workspace engine writes the cloud worktree and its
own configured app-data directory.

Stage Design snapshots the selected folder into Git's index, including its
manifest and rules. It does not stage Code or other Design folders. Later edits
continue autosaving to the worktree and can leave the same file both staged and
unstaged. Commit staged Design records only the staged version; push subsequently
publishes the branch's commits. A proposal awaiting acceptance has not changed
authored source; its request/evidence records are private.

Desktop, headless, CI, and future agent adapters use the same Design API
schemas. MCP is a transport adapter, not the core model. A headless caller can
open an exact revision, query bounded projections/provenance, apply or dry-run
transactions, render frames, capture artifacts, and receive diagnostics without
Electron or React.

## Renderer and editor contract

The DOM renderer runs in an opaque `allow-scripts` sandbox. Authored scripts,
active URLs, forms, nested frames, workers, and network access remain blocked.
Zeros injects the only runtime and connects through a private `MessagePort`.
Protocol messages carry an explicit version and exact source generation, use
bounded arguments/results, support cancellation and timeouts, and reject
pending work while teardown stops observers and timers.

Pointer handling uses Pointer Events and capture. High-frequency input is
sampled at animation-frame cadence; layout reads are batched before writes.
One pointer gesture publishes one semantic transaction on release. Cancel or
Escape restores the exact baseline.

### Interaction rules

- **Selection:** selection outlines follow the element's untransformed border
  box plus accumulated rotation. Handles, strokes, labels, constraint guides,
  and hit regions retain screen size at every supported zoom. Normal click
  first selects the outer frame from its body, including empty space. Once a
  child is selected, normal clicks preserve useful nesting depth. Double-click
  descends once, the platform modifier deep-selects, and Enter/Escape traverse
  the same visible child/parent hierarchy as Layers. Document wrappers and the
  explicit frame root share the outer frame's identity; unmarked authored roots
  remain real children, even when they fill the viewport. Frame bodies and labels
  use the ordinary selection cursor; label dragging and resize handles retain
  their gestures. Clicking a restored root-layer overlay also selects its frame.
  Modifier-clicks pass through padding and gap controls to deep-select beneath
  them; spacing drags retain their editing behavior. Outside-canvas clicks
  deselect. Fallback descent starts from the frame owner when the deepest hit
  is absent from a bounded tree. Text editing starts from confirmed local
  selection without waiting for engine selection persistence. Body hit tests
  share the selection generation with Layers and labels so delayed reads cannot
  replace a newer selection or apply another frame's nesting depth.
- **Multi-selection:** Shift-click and marquee publish a bounded primary-first
  group. Ancestor/descendant overlap reduces to top-level owners before
  transform or delete so no subtree is mutated twice.
- **Camera:** pinch follows Chromium's synthesized pinch scale, Cmd-wheel uses
  the flatter scroll curve, ordinary wheel pans, and every zoom preserves its
  focal point. Imperative camera state updates the world transform and inverse
  scale together, then settles one bounded store update.
- **Creation:** `F`/`A` creates frames and `T` creates text from one inverse
  pan/zoom transform. Click uses the documented default geometry; drag uses the
  exact world-space rectangle. A host-side draft paints synchronously and one
  transaction commits the result. Drawing inside a frame creates a child in
  its nearest containing frame; drawing on the canvas creates a new document.
  New children start with None and participate in their parent's Stack/Grid
  when enabled. Runtime child coordinate maps account for transformed ancestors,
  reflections, borders, and scroll. Parent positioning and insertion share one
  undoable transaction.
- **Inline text:** one uncontrolled plaintext editor owns caret, selection,
  composition, and the draft. Latest-wins runtime previews mutate the exact
  text node without broad React publication. Paste strips markup but preserves
  line breaks; blur or Cmd/Ctrl+Enter commits once; Escape restores the exact
  text. Blur during IME composition waits for `compositionend`.
- **Layers:** frames fold independently in one virtualized row list. Keyboard,
  visibility, hover, and selection are frame-keyed. Uncached hover reads
  coalesce to active plus latest instead of forming a queue.
  Only a sole direct child explicitly marked `data-zeros-frame-root` by frame
  creation shares the canvas row. Existing unmarked `main`/`div` roots remain
  real child layers, even when they fill the viewport or have no descendants.
  Their canvas frame targets `body` independently. The document-scoped API ID
  `::zeros-document-body` supports body styles and appending top-level content;
  it is never added as a `data-oid`, selectable layer, or source identity. Generic
  delete/replace/text operations do not accept that document target. Missing
  body tags are materialized only by an explicit mutation. Original trees and
  authored IDs remain intact; viewing existing sources adds no root markers.
  Automatic body style edits stay local to that frame; editing a shared body
  stylesheet declaration requires explicit rule scope.
- **Style inspector:** typed values remain local drafts until Enter/blur;
  Escape restores the focus-time value. Scrubs, sliders, and color gestures
  preview live and commit once. Authored-versus-computed state, shorthands,
  logical properties, priority, and source target remain explicit.
- **Layout:** padding, gap, grid, constraints, and distance tooling use
  browser-rendered child geometry. Guides paint synchronously, remain
  screen-sized, and perform bounded readback once per gesture rather than per
  raw pointer event.
- **Theme:** the Base/named-mode token editor is persistent, draggable, and
  non-modal. It neither traps focus nor blocks canvas, Layers, or inspector.
  Theme state belongs to the workspace, not an element.
- **Layout inspector:** the fixed Layout section presents whole-pixel parent-local
  positions and border-box dimensions, clockwise quarter turns, independent flips,
  alignment, constraint pins, and Clip content. Viewing or cancelling a rounded
  value never rewrites authored CSS. New frames start with normal block flow,
  an opaque white fill, and explicit dimensions. Opacity is displayed as a
  percentage. Text layers keep text semantics: Fill edits `color`, and the
  inspector does not offer conversion into a layout container or a background.
  The CSS editor continues to accept the full supported CSS vocabulary.
  Layout exposes None, vertical/horizontal flex, and Grid. Padding, gap, and
  the child-alignment pad appear only on automatic layouts. Free-layout
  containers retain their arrangement and constraint controls. Margins and raw
  flex factors belong in CSS, not the designer controls.
  Automatic layouts and their in-flow children expose per-axis Fixed, Hug
  contents, and optional min/max fields. Only in-flow children of flex/grid
  parents expose Fill container. Hug uses intrinsic CSS sizing; Fill uses flex
  growth on the parent's main axis and self-alignment stretch on its cross axis
  or a grid cell. Switching to Fixed releases growth and preserves the measured
  border box. Switching parent flow preserves child resizing intent. Enabling
  layout brings drawn children into flow; removing it freezes their measured
  positions and dimensions in the same undoable transaction.
  Paired horizontal/vertical padding can expand to independent sides. Grid
  track counts author equal fractional tracks only on an explicit edit; custom
  authored tracks remain untouched when viewing the inspector.
  Optional `layout.widthValue`, `heightValue`, and parent alignment/direction
  fields retain sizing intent in the exact node snapshot before computed
  geometry resolves it to pixels. Older runtimes can omit these fields.
  Layout edits that change an explicitly Hug-sized canvas root update its
  viewport bounds in the same transaction. Ordinary styles, flow, resizing,
  and history share the inspector's ordered lane; geometry preparation waits
  for runtime adoption, while immediate previews stay responsive.
  Sizing-menu drafts are scoped to workspace, frame, and selected node IDs.
  Geometry uses three columns at normal widths and reflows to two columns in
  narrow inspectors, keeping dimension values and resizing menus readable.
  Pins author standard insets (including `calc()` for center offsets); the directly
  authored `--zeros-layout-x` / `--zeros-layout-y` custom properties retain the
  start/center/end/stretch intent for the editor and canvas gestures. These names
  are serialized compatibility contracts. Optional runtime `layout` context is
  measured with node details and validated at the frame bridge, so the inspector
  does not infer parent coordinates from a transformed screen rectangle.
  Free-layout alignment and constraints appear only for containers with direct
  authored children, including top-level canvas frames. They arrange visible direct
  children; hidden layers and grandchildren are left alone. The optional,
  validated `childrenLayout` aggregate supplies presence, eligible child IDs,
  and shared or mixed pin intent in the existing exact-key runtime readback.
  Distribution equalizes gaps between at least three children. Resize to fit
  encloses visible child bounds with the container's padding; resize to fill
  stretches a nested frame inside its parent. Canvas-frame fitting commits
  viewport geometry and styles together. Preparing a containing block and
  freezing a flow container's measured dimensions happen in the same bounded
  transaction as child edits, preventing collapsed frames or partial history.
  A ready runtime can precede its Foundation projection. Layout actions,
  multi-layer styles, and keyboard nudges preview immediately and resolve the
  exact workspace/frame/source metadata inside the existing mutation lane.
  A cold read is shared with the inspector, keeps the captured edit targets,
  and cannot be overtaken by later writes or Undo. Document read failures and
  transaction conflicts retain their normal error and recovery handling.
- **Motion:** node-local keyframe tracks, preview, playback, and paths exist only
  in explicit Motion mode. Draft identity is workspace + frame + node, not
  source revision. Playback updates a small scalar owner store rather than the
  full canvas at 60 Hz.

### Continuous rendering and state

An authored value change is not a loading transition. Visual-only writes patch
the mounted runtime and advance its exact generation atomically. Structural and
text commits prepare one incoming live iframe while the displayed iframe keeps
painting, then swap after runtime handshake, fonts/layout, theme, selected-node
readback, and compositor frames are ready. Rapid A → B → C replaces only the
unpainted incoming buffer.

Native frame resources, snapshot reads, and Design mutations resolve the same
active directory in an operation-scoped lease. They do not depend on an earlier
mode switch priming the legacy directory name. Human reads and mutations are
independent of workspace presentation. The future agent mode gate is not yet
implemented. Capability, path, symlink and
source-generation checks remain in force on native resource reads.

Only a successful private runtime handshake publishes a connection for canvas
interaction. An incoming buffer keeps the outgoing ready connection until it
connects. A changed engine capability starts a new frame session using the
current semantic generation, including after an in-place style adoption. A
failed native handshake revalidates the workspace and hydrates that frame through
the bounded, exact-version, sanitized bridge cache. Persistent failures offer
an inline Retry frame action. Recovery timers stop for inactive surfaces and
retired sessions; mutations are never automatically replayed.

Runtime snapshots and hot collection references remain stable. Style writes
retain the existing tree reference where structure permits; display/visibility
or structural changes take the full-tree path. Speculative values are keyed by
workspace, frame, node, and property so settling one operation cannot erase a
newer or sibling preview.

Local authored writes serialize per workspace. A queued operation may rebase a
stale request only across a bounded descendant chain produced by that same
renderer; unrelated external edits still fail CAS. Watcher echoes wait until
the local queue has adopted its final generation.

The two most recently used Design surfaces may remain mounted. An inactive
surface is hidden, `inert`, and passed `surfaceActive=false`; it performs no
polling, capture, shortcut, focus, measurement, or hot effect. See
[UI interaction and performance](ui-interaction-performance.md) for the
repository-wide server-state and retained-surface rules.

At deep zoom, the authoritative iframe stays mounted while a bounded visible
crop is rerasterized for device fidelity. Captures are exact-camera-keyed,
decoded before publication, serialized per frame, latest-wins, and memory-only.
A prior decoded crop may stay geometrically pinned until its replacement is
ready; the editor must not flash a blank or stale-position layer.

## Performance and safety ceilings

The following Foundation limits are compatibility and denial-of-service
boundaries, not targets to relax casually:

- textual state: 1,024 files, 2 MiB per file, 16 MiB total;
- transactions: 256 operations and a 4 MiB aggregate input envelope;
- default history: 100 entries/1 MiB operations and 512 receipts/4 MiB;
- recovery journal: 32 MiB with validated paths, revisions, source limits, and
  symlink-safe write parents;
- component composition: 1,024 reachable definitions, 512 KiB each, 16 MiB
  total definition source, depth 8, and 2 MiB expanded output;
- render preparation: 128 linked stylesheets, 12 MiB inline raster assets,
  15 MiB sanitized output, and 16 MiB runtime-enabled output;
- live projection: 20,000 nodes across at most 32 emitted nesting levels and
  5,000 audited elements, with explicit truncation advisories;
- headless rendering: two concurrent pages by default (four maximum), a
  15-second default deadline (60 seconds maximum), 16,777,216 output pixels,
  and 16 MiB artifacts;
- active canvas: at most 12 live frame runtimes by default;
- retained desktop state: source-free aggregate reads, at most 16 hydrated
  documents/64 MiB, 32 MiB Foundation projection cache, and a 32 MiB
  per-workspace desktop Design API budget;
- generic Design API: 32 sessions/64 MiB by default; desktop retains at most
  eight workspace API owners.

Exact-key caches may exceed a budget only while their keys are active or
pending, then evict inactive least-recently-used entries. Screenshots bound
dimensions, pixels, bytes, and execution time. Deterministic headless evidence
pins browser, fonts, viewport, scale, locale, timezone, color settings, and
reduced motion; unpinned host pixels are never treated as a stable baseline.

## Actor and execution contract

| Actor                    | Code/repository authority                                                                                      | Design authority                                        | Execution                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------- |
| Human Code workflow      | Normal native files and Git                                                                                    | Readable; Zeros Code routes reject Design writes        | Native host                       |
| Shared Code/Design agent | Normal provider tools and permissions | Code inspects; Design authors with native file tools and optional API | Native host process lifecycle |
| Human Design surface     | Read-only Code context                                                                                         | Semantic Design API transactions                        | Trusted application process       |
| External terminal/editor | Normal same-user authority                                                                                     | Normal same-user authority                              | Outside the Zeros actor guarantee |

Native Code deliberately has no ZSR, VM, OrbStack machine, local container,
Zeros ACL, Design sparse shape, alternate checkout, or Code-to-sandbox fallback.
`HostExecutionBoundary` adds owned process-group lifecycle, bounded identity,
graceful/forced teardown, and stale-process recovery while preserving normal
provider and host behavior.

Agents receive recognized roots and mode instructions: Code may inspect;
Design may author with native file tools. Generic app file writes/discard remain
guarded, while authorized managed Git includes Design. These
workflow guards do not change the
native permissions of the Code process or external same-user tools and are not
a hostile-process filesystem security claim.

View identity never selects execution posture. Local Design directory changes
suspend and revoke document grants while preserving the provider and MCP
connection; fresh capability discovery binds the current directory. Composer
mode does not select a sandbox or make Code files read-only.

### Shared-conversation Design tools

`engine/design/code-tool-admission.ts` admits a workspace-owned `design-draft`
MCP connection for new/resumed native sessions. `conversation-tools.ts` binds a
valid active directory lazily; Create design directory therefore works without
a new conversation. Ambiguous, invalid and foreign directory identities never
receive document authority. Cloud admission remains worker-owned and requires
separate deployed-host qualification.

`chats.composer_mode` and its revision are engine-authoritative, persisted
independently of generic chat upserts. Manual changes use `chats.setComposerMode`;
agent changes use the revision-checked `design_mode_set`. Each prompt/steer and
agent-switch result supplies current instructions. MCP schemas remain stable,
but API writes require Design mode and the current generation at journal
admission. Code retains read-only inspection. Provider permissions are unchanged.

V1 exposes list/open, bounded source/foundation/projection/provenance reads,
semantic apply/dry-run, durable request status, actor-local undo/redo, frame
lifecycle, lint and sanitized render. Capture is advertised only with a host and
returns native MCP image content plus metadata. Proposal/result-bundle tools
remain internal and are not exposed by this conversation endpoint. Successful
edits update the checkout and existing canvas directly; they never auto-stage.
See [the execution contract](design-agent-execution-plan.md) for tool labels,
recovery semantics, acceptance checks and deferred UI.

The **Review Design changes** dialog lives inside the Design tab. It is a compact
640 × 480 dialog, bounded by the window, with an undimmed background. It retains
modal focus/scroll isolation, explicit close/Escape, and protection against
accidental outside dismissal; the background canvas does not become interactive
while review is open. Narrow windows hide the canvas sidebar and keep the
comparison, scrollable changes, and checkpoint controls available. Its left side
shows the current canvas until pages exist; its right side provides independent
All, Uncommitted, Staged, Unstaged and Agent proposals comparisons, source diffs,
and saved before/after images. Accept/Reject records trusted human review
separately from the originating agent receipt. Accept applies an exact-revision
proposal; it does not stage it. Stage, Unstage and Commit staged Design are
separate actions. Commit pins the reviewed index fingerprint and refuses changed
staging. Its Design-only commit scope preserves staged Code; workspace Git
commit can deliberately include the shared staged snapshot.

Results preserve source, composed HTML, hashes, revisions, viewport and renderer
identity. Retention is bounded to 16 bundles / 64 MiB per workspace, at most 32
MiB per bundle and seven days. Capture has one browser slot per engine, two
aggregate evidence-preparation/read slots, and a 20-second host deadline. Slow
browser work releases the document write lane; later source edits do not rewrite
saved evidence. The review dialog has bounded exact-key caches and no closed
polling. Evidence is displayed as PNG, never executable authored HTML.

`document.ts` retains its public exports while storage, journal transactions,
frame lifecycle, source/asset helpers and render preparation have focused owners.
The renderer shell composes separate canvas, overlay, frame-host, camera, inline
text, inspector and review modules. See [surface contracts](design-surface-contracts.md)
for the compatibility matrix and native-host limitations.

The existing `ZEROS_DESIGN_AGENT_CAPABILITY` environment-header contract carries
the private bearer. Each grant expires after 24 hours and is revoked on execution
retirement, shutdown, or authority change. Reopening/resuming the Code session
mints a new bearer. Authorization is checked again at the journal admission
boundary; a transaction already durably admitted finishes recovery. Cancellation
therefore requires status reconciliation when it races a commit.

Request/proposal records live in engine-private Design storage, bounded to 512
records and 4 MiB per directory. Resolved receipts are retained for **up to** seven
days within those limits; a persisted timestamp cutoff prevents replay of evicted
requests. Started/indeterminate records are not automatically evicted or replayed.
The store fails closed if unresolved records fill its budget. This is a bounded
local retry contract, not replicated cloud job persistence. Tool discovery
reports the clock, expiry, supported operations, and budgets. The
[implementation report](design-phase-0-1-report.md) describes the API and tests.

## Scoped API compatibility

The serialized `agentRole: "design"` value remains parseable, but the engine
rejects it before workspace resolution, provider startup, or capability minting.
The test-only activation seam, separate gateway constructor, admission renewal,
and session retirement maps have been removed. There is no alternate Design
provider lifecycle to enable.

`design-agent-capability.ts` and `design-agent-mcp.ts` retain their internal
names as tested API/transport primitives. A scoped grant binds workspace,
document, run identity, revision, action/operation allowlists, and expiry.
Loopback MCP validates Host, Origin, bearer, route, schemas, bounds, and tool
names. Credentials stay out of argv, source, logs, and persisted MCP config.
These primitives do not establish an OS boundary or a second agent session.

The shared-session tool registry remains the production integration. The v1
mode gate will reuse its revocation/write-authority checks; current native Code
sessions still have the Phase 1 Design tool authority. Opening Design view
starts neither a provider nor a sandbox.

Experimental private-store ownership markers remain recognized in metadata
recovery. They block checkout writes with a recovery message; this version
cannot activate, publish, or export that retired store. Preserve its app data
and recover through the experimental build before deliberately importing into
the checkout. Never remove the marker to bypass the error. Ordinary workspaces
continue using the checkout-backed store without migration.

## Git and concurrency

Design editing and Git publication are separate:

1. A semantic transaction updates the durable uncommitted draft.
2. `design.save` validates only; it changes neither index nor `HEAD`.
3. `design.stage` stages exactly the active Design root.
4. `design.commit` commits the already-staged, Design-only lane and accepts no
   arbitrary pathspec or implicit amend.

The managed `git.stage` and `git.unstage` routes accept literal Code and Design
paths. `git.commit` uses workspace authority, capturing the exact staged lane
(or explicit selected files) in a private index before updating HEAD with CAS.
Internal callers with Code-only authority still refuse Design content; Design
review retains its narrower lane. Boundary-crossing Design-only renames remain
rejected. No action silently stages missing metadata companions. A touched
portable Design folder must include regular `design.toml` and `rules.md` files;
v2 registrations also require valid staged `canvas.json` and its frame sources
in that captured index; full-folder deletion and recognized legacy metadata
remain supported. Validation does not read a newer unstaged draft to decide
whether an earlier staged checkpoint is valid.

Pull, merge, rebase, checkout, reset, cherry-pick, revert, and push are
branch-wide operations performed once against the shared checkout. An open
Design surface refreshes from the resulting files; there is no Design-only pull
or hidden convergence branch. A live dirty draft is protected from rewrites,
and independently committed changes to the same Design path are refused before
Git materializes conflict markers that the Design editor cannot reconcile.

Zeros-owned checkout/index/ref mutations share a re-entrant FIFO lane for the
physical worktree and a repository-global ref/stash lane across linked
worktrees. They revalidate the latest branch tip. Ordinary Code editing,
building, testing, and Design transactions stay concurrent. Raw Git launched by
an unrestricted Code process is outside this coordinator and relies on Git's
own lock files; callers must surface those conflicts instead of redirecting the
command through another backend.

Paths are normalized as repository-relative POSIX paths and validated against
traversal, case aliases, symlinks, hard links, and Git pathspec ambiguity before
Zeros publishes authority. Generic file/discard/restore/clean and destructive
reset paths still refuse Design targets. Managed integration is deliberately
separate from authored editing; it is not an unrestricted native-shell sandbox.

Files provides a Design section and read-only source. Workspace Changes and
Design Review observe the same index. Direct Create PR publishes existing branch
commits, preserving staged, unstaged and untracked Code and Design; if no branch
commits exist it asks the user to review and commit first. The agent PR brief
uses the same publication scope and no longer instructs commit-all. Push/pull
also do not implicitly commit local changes. The current Review Changes tab
compares the branch's committed HEAD with its base; it can include unpushed
commits and is not yet a comparison pinned to the published remote PR head.
Richer Design ownership badges/action handoff and remote visual evidence remain
follow-ups in the [v1 plan](design-v1-implementation-plan.md).

### Conflict status and read-only context

`design.status` reads unmerged paths and the current merge/rebase/cherry-pick/
revert without parsing authored metadata. Any unmerged path pauses the Design
canvas conservatively, including Code-only conflicts. Read/mutation admission
checks this before resolving a potentially conflicted manifest. Retry rechecks
the checkout; Cancel integration explicitly confirms and invokes managed
`git.abort`. A conflict with no abortable operation offers Retry only. Existing
managed integration may refuse overlapping Design changes before creating any
conflict at all. This is pause/recovery, not automatic conflict resolution.

`design.context.create` and `design.context.inspect` are local, read-only routes.
The version-1 reference contains workspace ID, stable directory ID, portable
HTML frame, optional node ID and exact semantic revision. Inspection returns
`ready` with source/geometry, `stale` with the current revision, `missing`, or
`wrong-directory`; it rejects a mismatched outer workspace. Reads never heal or
write metadata, and an external source race cannot return newer bytes as the
referenced revision. The renderer bridge exposes this contract; composer frame
context pills remain deferred. Conversation mode transitions and Design API
write gating are implemented independently of this context delivery.

## Cloud, packaging, and compatibility

Cloud execution is a separate qualified deployment boundary. A cloud image may
force every actor through its worker policy and may provide a root-owned,
generation-private container service. That source/cloud-image helper is not a
desktop VM path and must not be staged into desktop resources.

Desktop packages retain only active execution assets: the native host process
supervisor plus the pinned ZSR supervisor/runtime tools and process-domain
helpers still used by supported contained execution paths. Composer Design
mode does not select those assets or make them a new release dependency. They must not include the
retired local container worker, OrbStack relay/host, cloud-init asset,
controller, machine bundle, or sidecar variables that locate them.

Older builds wrote Design ACLs, Design sparse shapes, local projection state,
Cursor overlays, and local OrbStack/container recovery descriptors. Startup may
recognize, recover, or remove those exact artifacts so upgrades do not strand
user state or permissions. Persisted `ZSR` names, backend/status enum values,
session roots, and old OrbStack cleanup filenames remain compatibility
contracts where externally observable. An ambient OrbStack Docker socket may
remain on a ZSR denylist solely as an escape endpoint; it is not runtime
discovery or an active dependency.

Do not rename serialized compatibility identifiers merely to make the source
look current. Do remove unreferenced local VM/container implementation code and
package inputs; release checks enforce their absence.

## Verification and release evidence

Every Design change follows the repository checks in `AGENTS.md` and
`RULES.md`. At minimum run:

```sh
pnpm typecheck
pnpm lint
pnpm check:ui
pnpm test:git
pnpm check:secrets
```

For Design, execution-boundary, protocol, or packaged-runtime changes, also run
the applicable checks:

```sh
pnpm build:ui
pnpm test:ui-smoke
pnpm check:protocol
pnpm check:preload
pnpm check:design-containment
pnpm check:zsr:contracts
pnpm check:zsr:runtime
pnpm check:packaging-paths
pnpm check:licenses
```

`pnpm smoke:engine` is macOS-only. `check:zsr:runtime` requires a host where the
real kernel sandbox can initialize. A namespace- or Seatbelt-incompatible host
is an unqualified/fail-closed result, not substitute evidence.

A release report records the source commit and dirty state, OS/architecture,
source versus packaged build, pinned Sandbox Runtime provenance and licenses,
all commands/outcomes, platform-only checks not run, latency samples, and cloud
image/deployment identity when applicable. Source tests do not qualify a
packaged app, one architecture does not qualify another, and Design API tests
do not substitute for a live kernel-boundary test.

Acceptance must prove, independently:

- native Code always remains native and retains provider parity;
- view changes preserve branch, index, checkout, and running sessions;
- Design transactions preserve CAS, idempotency, undo, crash recovery, and
  exact bounded authority without changing Git automatically;
- Design-scoped checkpoints preserve staged Code, shared workspace Git can
  include Design, and branch-wide rewrites protect live drafts;
- scoped Design tools reject stale identity/revision/authority and are revoked
  when their owning execution or document identity is retired;
- contained cloud admission has no native fallback; native and contained
  execution teardown retain their respective process-lifecycle guarantees;
- desktop packaging includes active native/ZSR assets and excludes every
  retired local VM/OrbStack/container asset.

## Deliberate post-Foundation product boundaries

Foundation v1 does not claim mobile authoring, multiplayer transport,
breakpoint/pseudo-state authoring, deep component-internal overrides, vector
pen/boolean operations, 3D/shader renderers, multiple coordinated animations,
advanced motion paths/springs, rich variable dependency tooling, semantic
Design conflict resolution, or advanced multi-agent orchestration. Proposal
internals and existing human review are retained; the minimal composer mode is
implemented. Rich proposal presentation and semantic conflict handling follow v1.

Those features require explicit source, protocol, authority, or interaction
contracts. They must reuse stable identity, transactions, provenance,
parameters, revisions, exact-owner state, bounded speculative work,
single-commit gestures, Escape restoration, and real-browser regression
evidence rather than introducing another durable document model.

### Layout interaction and visual history

The Layout inspector offers content-aware sizing: Hug requires child layers;
Fill requires an in-flow child of flex/grid. Padding, gap and dimensions present
whole pixels, and Shift scrubbing uses ten-pixel steps. Advisory lint stays in
the diagnostics data rather than the inspector chrome.

A single layer dragged inside flex/grid changes authored sibling order with an
insertion marker. Crossing a container boundary changes its parent and resets
positional pins; a free container uses its local coordinate space. Moving out
of the document creates a canvas frame, and moving a frame into another transfers
its subtree. `node.move` preserves exact source spans and stable identities.
`design.node.transfer` performs the two-document change through the engine's
Design metadata journal, including geometry and exact structural history.
Transfers retain local stylesheet dependencies within the Design directory.
Trusted in-process API history checkpoints preserve edits before and after a
transfer. They reattach only to the exact restored document revision and count
toward the workspace history's 16 MiB bound; they are never transport inputs.
Numeric fields retain their DOM identity when reparenting changes sizing
eligibility, so an arriving layout snapshot cannot discard a focused draft.
Each numeric commit paints immediately and advances its local baseline before
saving. Escape in a new draft leaves the preceding committed preview intact;
unit-menu close and blur cannot register the same edit twice.

`previewLayout` applies a bounded batch before measuring, avoiding a reflow and
round trip for every child. Drag targets are measured once, with a bounded lean
style catalog; pointer handlers use those frozen bounds and one preview in
flight. Inspector previews and committed generations preserve newer pending
values rather than letting an older save repaint them.

Moving a layer out of an iframe retains available exact-generation captured
pixels in one canvas overlay until the destination's displayed document is ready.
The source paint is suppressed without changing authored CSS. A failed or
cancelled transfer restores it; a confirmed transfer never restores the old
position first. Destination selection waits for the new document before reading
the transferred node, and does not replace a selection made during saving.
Whole-frame gestures retain their visible geometry through overlapping save
replies, including React renders triggered by those replies.

Layout preparation and durable writes have separate queues. A second sizing
choice or undo can paint while the first write is saving; persistence remains
ordered. Style-only commits, positional moves with unchanged sibling order, and
their history inverses reuse the retained tree and element index. Clicks racing
an in-place source adoption retry the exact live frame, with a bounded retry.
The runtime port holds subsequent commands through its local version handoff,
so a concurrent layout preview carries the accepted generation. Rejected
adoptions release that lane and cancelled commands remain unsent.

For larger documents, target collection starts only after drag intent, includes
the selected ancestry, treats SVG drawings as atomic layout items, and bounds
context scanning. Sibling order and ancestor membership are indexed once per
gesture. Geometry requests bound inspected children as well as returned children,
so thousands of hidden elements cannot turn an inline-gap drag into a full scan.
The browser tests cover 4,000 SVG paths and 6,000 hidden children.

Optional audits, thumbnails, and high-resolution captures share one background
lane, with at most 32 pending owners and only the latest request for each owner.
Active layout gestures pause that lane; other direct manipulation defers it until
input is quiet. Queued work rechecks the retained surface's active state before
reading or capturing its document. Raster capture carries the generation at
capture start. Cached screenshots have a global 24 MiB budget, accounting for encoded
strings and decoded pixels, while geometry and layer trees remain retained.
The 12-frame live-runtime ceiling is a maximum: unused slots do not load distant
documents. Explicit selection and open Layers trees retain priority.

A runtime retains up to 64 reversible layout generations, capped at 4 MiB of
style history. The renderer predicts known layout undo/redo against exact
workspace snapshot identities, while the engine remains authoritative. Unknown
or externally changed history falls back to the confirmed document. The browser
regression harness deliberately delays history replies by 500 ms and verifies
that layout inverses paint first without replacing the iframe or element.
It also delays frame movement and transfer by 700 ms, and style saves by
1,500 ms, checking repeated sizing, rapid undo/redo, transfer handoff, rollback,
and consecutive whole-frame drags independently of persistence latency. These
are browser regression bounds, not a hardware-independent speedup claim.

Interaction references: [auto-layout flow and spacing](https://help.figma.com/hc/en-us/articles/31289464393751-Use-the-horizontal-and-vertical-flows-in-auto-layout),
[grid layout](https://help.figma.com/hc/en-us/articles/31289469907863-Use-the-grid-auto-layout-flow),
and [position and dimensions](https://help.figma.com/hc/en-us/articles/360039956914).
These inform interaction behavior; the implementation uses the app's own controls
and CSS layout semantics.

Performance references: [incremental frame loading](https://www.figma.com/blog/incremental-frame-loading/),
[performance regression testing](https://www.figma.com/blog/keeping-figma-fast/),
and [avoiding layout thrashing](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing).

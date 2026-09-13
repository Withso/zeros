# Design workspace

**Status:** Current implementation and compatibility contract. Foundation
schema v1, Design API v1, and DOM renderer protocol v2 are frozen interfaces.

This is the single durable guide for the Zeros Design workspace. It describes
the behavior implemented in the repository, the dormant foundation retained
for a future autonomous Design agent, and the evidence required before either
path can ship. It is not an implementation diary or roadmap.

## Product and workspace model

A Zeros workspace has one managed Git worktree, one checked-out branch, and one
Git index. Code and Design are concurrent views of that checkout; they are not
separate worktrees, branches, copies, projections, or execution backends.

```text
Code agents (native host) ───────────────► shared worktree

Human Design surface ─────────────────────────┐
                                              ├──► Design API ─► DesignDraftStore
Future Design agent (ZSR, disabled) ──────────┘
```

The active Design directory comes from the private `[design] directory_id`
selection and the `design.toml` manifests in this checkout. Legacy `[design]
directory` paths remain readable. `Zeros Design/` is the unconfigured pointer
default; first Design use creates `<repo name> - Design/` when no Design folder
exists. A single discovered folder is reused. Multiple folders can be selected
in Settings. Source remains materialized and readable in Code and Design views.

### Source, metadata and personal state

```text
<repo>/
  Product - Design/
    design.toml         tracked identity and complete document metadata
    rules.md            short Design API ownership instructions
    home.html           authored frames
    tokens.css          shared tokens
    components/         shared components
    assets/             images and other assets
  .zeros/               ignored private settings and local state
```

Every Design folder, including its manifest and rules, belongs to the Design
API. Code agents may read it, but generic file and Git operations cannot mutate
it. Zeros Settings and Design mode manage it. Commit the folder and its
`design.toml` together; uncommitted work remains on disk but is not available to
other clones or branches until committed.

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
HEAD/index discovery cannot immediately restore the removed registration. Open
Design workspaces must switch to Code before removal. The operation is local-only
and uses the engine's Design-owner handoff and workspace mutation lane. Other
worktrees retain their own committed copies until updated through normal Git.
Choosing the folder again rebuilds metadata from its preserved source; removed
canvas-only state requires restoring the prior manifest from Git.

The manifest has a format discriminator, an envelope version and a stable ID:

```toml
format = "zeros-design"
version = 1
id = "design_example"

[document]
version = 3

[document.frames]
[document.frame_info]

[document.foundation]
schemaVersion = 1
parameters = []
variants = []
components = []
```

`document.frames` stores geometry keyed by HTML filename; `frame_info` stores
frame titles and kinds; `foundation` stores parameters, variants and components.
Unknown JSON document extensions survive migration and edits. TOML has no null,
so an optional envelope `nulls` array records JSON pointers into `document`;
empty-string placeholders at those exact locations decode to null. No document
keys are reserved for this encoding. Canvas viewport state, recovery journals
and transaction history stay in private engine storage, outside Git.

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
On a Design write, every entry in a central registry migrates into its source
folder before the old storage becomes private. IDs, geometry, Foundation data
and extensions are preserved. Recoverable transactions write the manifests
before removing predecessor files. Legacy canvas markers and inline frame
metadata migrate through the Design API. Interrupted older transactions remain
recoverable. Reading an older branch does not rewrite it.

Design Stage, Unstage and Commit include the selected source folder and its
manifest. During migration, projection of shared legacy registry entries keeps
other folders' staged and committed states independent. Directory renaming moves
source and manifest together in one scoped commit; the private selection retains
the same ID. Generic Code actions exclude all recognized Design roots and legacy
metadata. Archives finish recoverable writes before capturing source and metadata.

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
returns the entry `target` and whether it exists). The workspace mode toggle
offers "Create design directory" instead of a silent switch when the folder
does not exist, and the Create page's Code/Design toggle shows which folder a
design workspace will open or create.

`workspaces.view_mode` selects the visible surface. `kind` remains a synchronized
compatibility mirror for older clients. Switching views does not run checkout,
stash, sparse-checkout, stage, commit, merge, rebase, pull, or process migration.
The mode toggle and shell both select the confirmed workspace mode. A pending
request marks the control busy but does not select the destination icon before
its surface is ready. The engine's mode receipt publishes the row and initial
Design snapshot together; a refused switch keeps the original selection.

Entering Design may initialize a missing foundation as ordinary uncommitted
files. Exiting leaves the working tree and index unchanged. A durable transition
marker lets startup finish an interrupted database/surface transition without
rewriting the checkout. The generic Working Directories feature may use
user-selected sparse-checkout, but it is unrelated to Design containment and is
unavailable while the Design surface is active so it cannot hide an open
document.

The current Design workspace has no coding-agent prompt. Production also
rejects autonomous Design-agent admission. The Design-agent API, capability,
and ZSR paths described below are intentionally dormant, testable foundation
for a future explicit delegation experience.

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
  preserves useful nesting depth, double-click descends, the platform modifier
  deep-selects, and Enter/Escape traverse child/parent hierarchy.
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
  value never rewrites authored CSS. New frames explicitly use normal block flow;
  choosing None disables auto layout without hiding the element. Other style
  sections and the CSS editor retain their existing precision and semantics.
  Ratios, flex factors, and relative CSS units in Layout also retain fractions.
  All three geometry columns grow with the inspector; the transform tools keep
  a 72px minimum so their three targets remain usable at the narrowest width.
  Pins author standard insets (including `calc()` for center offsets); the directly
  authored `--zeros-layout-x` / `--zeros-layout-y` custom properties retain the
  start/center/end/stretch intent for the editor and canvas gestures. These names
  are serialized compatibility contracts. Optional runtime `layout` context is
  measured with node details and validated at the frame bridge, so the inspector
  does not infer parent coordinates from a transformed screen rectangle.
  Alignment and constraints appear only for containers with direct authored
  children, including top-level canvas frames. They arrange visible direct
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
mode switch priming the legacy directory name. Code view retains read access;
document mutations still require Design mode. Capability, path, symlink and
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
| Code agent               | Normal native tools, hooks, plugins, MCP, credentials, network, containers, Git, and allowed extra directories | Live readable context plus an instruction not to mutate | Native host process lifecycle     |
| Human Design surface     | Read-only Code context                                                                                         | Semantic Design API transactions                        | Trusted application process       |
| Future Design agent      | Read-only Code, Design, and Git metadata; temporary scratch only                                               | Scoped semantic Design API transactions                 | ZSR; production disabled          |
| External terminal/editor | Normal same-user authority                                                                                     | Normal same-user authority                              | Outside the Zeros actor guarantee |

Native Code deliberately has no ZSR, VM, OrbStack machine, local container,
Zeros ACL, Design sparse shape, alternate checkout, or Code-to-sandbox fallback.
`HostExecutionBoundary` adds owned process-group lifecycle, bounded identity,
graceful/forced teardown, and stale-process recovery while preserving normal
provider and host behavior.

Code agents receive every recognized Design root as readable context and an
explicit cooperative instruction not to mutate it. Zeros-owned generic file and
Git handlers also reject Design paths. These workflow guards do not change the
native permissions of the Code process or external same-user tools and are not
a hostile-process filesystem security claim.

View identity never selects execution posture. Starting or stopping a future
Design agent cannot retire native Code sessions, and switching views cannot
restart, migrate, narrow, or widen any running actor.

## Future autonomous Design-agent boundary

`agentRole: "design"` is rejected at the engine dispatcher before workspace
resolution, provider initialization, process creation, or capability minting.
No production setting or environment variable enables it. A constructor seam
works only with `NODE_ENV === "test"`; this keeps the complete admission path
testable without exposing an unfinished product workflow.

One admitted run receives an expiring, process-local capability bound to exact
workspace id/path, document and expected revision, run/actor identity, action
and operation allowlists, issue time, and expiry. An ephemeral loopback MCP
endpoint validates Host, Origin, bearer, route, schemas, bounds, and tool names.
The bearer travels through the provider environment or in-memory adapter—not
argv, persisted configuration, logs, MCP literals, or tool output.

The capability exposes bounded open/read, transaction apply/dry-run, undo, and
redo. It lasts for the persistent provider session, renews without broadening
authority, and is revoked when that session stops. A later prompt uses the same
provider, sandbox generation, capability, and MCP endpoint instead of paying a
new admission.

ZSR is operating-system isolation: macOS Sandbox Runtime/Seatbelt or Linux
Bubblewrap. It is not a VM, OrbStack machine, local container image, repository
clone, or separate worktree. A Design policy permits normal provider/runtime
reads plus writes only to generation-private provider state, generation-private
scratch/artifacts, and the exact loopback capability endpoint. It write-denies
Code worktrees, every recognized Design directory, `.git`, durable engine and
draft authority, sibling workspaces, requested extra roots, ambient container
daemon sockets, and unrelated Zeros control ports.

Only the trusted Design API writes the durable draft. Admission resolves and
validates identity/revision/territory, binds the capability endpoint, installs
and attests the exact ZSR policy, then starts and owns the provider process
domain. Any failure closes the endpoint, revokes the bearer, proves the
generation empty, and reports a terminal admission error. It never retries on
the native host or in a provider sandbox.

### Readiness and latency evidence

Opening Design view never launches ZSR or a provider. Cold session readiness
may include identity/revision validation, capability/listener setup, ZSR policy
installation and attestation, provider/auth checks, process startup, protocol
initialization, and model/account discovery. ZSR has no VM boot, but provider
startup is still real and often dominant; the architecture makes no fixed
seconds-to-ready promise.

Measure capability/MCP setup, ZSR admission, provider startup, total session
readiness, warm prompt dispatch, and stop-to-proven-empty independently. Record
provider, auth state, OS, architecture, source/package build, cache state,
sample count, and percentiles. Never attribute provider latency to ZSR or cite a
single best-case sample as the release result.

The renderer may overlap cold work with typing and queue a prompt behind that
exact in-flight session. A pristine unused provider switch may defer admission
until user intent. Neither optimization may weaken revision checks, capability
scope, policy installation, attestation, or proven teardown.

## Git and concurrency

Design editing and Git publication are separate:

1. A semantic transaction updates the durable uncommitted draft.
2. `design.save` validates only; it changes neither index nor `HEAD`.
3. `design.stage` stages exactly the active Design root.
4. `design.commit` commits the already-staged, Design-only lane and accepts no
   arbitrary pathspec or implicit amend.

Code commits refuse recognized Design content; Design commits refuse Code
content. Boundary-crossing renames are rejected. Code pathspec commits may
select Code files without consuming staged Design work, but there remains one
shared index, so staged state from both lanes must be committed separately or
unstaged deliberately.

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
Zeros publishes authority. Generic Zeros file, stage, discard, restore, clean,
reset, and Code-commit routes refuse Design targets and direct the user to the
Design surface or dedicated actions.

## Cloud, packaging, and compatibility

Cloud execution is a separate qualified deployment boundary. A cloud image may
force every actor through its worker policy and may provide a root-owned,
generation-private container service. That source/cloud-image helper is not a
desktop VM path and must not be staged into desktop resources.

Desktop packages retain only active execution assets: the native host process
supervisor plus the pinned ZSR supervisor/runtime tools and process-domain
helpers required by a future local Design agent. They must not include the
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
- Code and Design Git actions remain territory-pure and branch-wide rewrites
  protect live drafts;
- a future Design agent can mutate only through its exact API capability while
  direct worktree, Design, Git, engine, sibling, extra-root, socket, and control
  paths remain non-writable;
- admission failure has no native fallback, and teardown removes every
  descendant and revokes the endpoint;
- desktop packaging includes active native/ZSR assets and excludes every
  retired local VM/OrbStack/container asset.

## Deliberate post-Foundation product boundaries

Foundation v1 does not claim mobile authoring, multiplayer transport,
breakpoint/pseudo-state authoring, deep component-internal overrides, vector
pen/boolean operations, 3D/shader renderers, multiple coordinated animations,
advanced motion paths/springs, rich variable dependency tooling, semantic
Design conflict resolution, or an agent proposal/delegation UI.

Those features require explicit source, protocol, authority, or interaction
contracts. They must reuse stable identity, transactions, provenance,
parameters, revisions, exact-owner state, bounded speculative work,
single-commit gestures, Escape restoration, and real-browser regression
evidence rather than introducing another durable document model.

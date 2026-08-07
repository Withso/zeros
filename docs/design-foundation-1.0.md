# Design Foundation 1.0

**Status:** Frozen compatibility contract: Foundation schema v1, Design API
v1, and DOM renderer protocol v2.

This document defines the stable engineering contracts for the Zeros Design
workspace. Foundation 1.0 is the platform beneath the product editor. It is
complete only when desktop UI, a headless caller, and a constrained agent can
perform the same semantic edit and receive the same source result.

## Product boundary

The Design workspace authors portable visual documents. A web frame remains
HTML and CSS in the Git worktree. The browser DOM is a sandboxed render,
measurement, and hit-test projection; it is not an independently persisted
document model.

Other media may add adapters later. They share workspace identity,
transactions, parameters, variants, provenance, and geometry contracts, but do
not need to masquerade as HTML nodes.

The Design workspace does not attach a coding-agent chat or grant a coding
process access to a Design worktree. Future design agents use the versioned
Design API and its scoped operations.

## Architecture

```text
Authored HTML/CSS in Git
          |
          v
Web source adapter -- stable ids, source spans, diagnostics, provenance
          |
          v
Transaction kernel -- revision, validation, inverse, history, receipt
          |
          +---- components / instances
          +---- parameters / bindings / variants
          |
          v
Versioned Design API
          |
          +---- desktop workbench
          +---- headless worker / CI
          +---- future mobile and embedded clients
          +---- scoped agent adapters
          |
          v
Renderer adapters -- DOM iframe first; vector/GPU adapters may follow
```

The shared core is pure TypeScript. It cannot import React, Electron, Node
filesystem APIs, or browser globals. Filesystem authorization, atomic writes,
render preparation, and sandbox lifecycle remain engine or renderer concerns.

## Normative invariants

1. HTML and CSS are canonical for web frames. A derived tree may be cached but
   cannot become a second durable copy of the same UI.
2. Stable design identity is independent of DOM `id`, CSS class, source
   offset, array position, iframe lifetime, and component instance order.
3. Every committed in-document source, style, text, geometry, component,
   parameter, and variant write is represented by a validated, versioned
   transaction. Temporary previews and workspace frame-catalog lifecycle
   commands are not document transactions.
4. A transaction carries an exact base revision. A mismatch fails with a
   conflict; it never silently applies to a newer document.
5. A transaction batch is atomic from the caller's perspective and produces a
   bounded receipt plus inverse operations. Drag streams coalesce into one
   history entry.
6. Undo and redo apply semantic inverse/original operations through the same
   adapter as normal edits. They do not restore an unbounded full-workspace
   snapshot.
7. External source edits publish a new exact revision. The source adapter
   reconciles surviving stable identities, clears unsafe redo state, and keeps
   the last valid render available when new source is invalid.
8. Authored, matched, computed, inherited, preview, token-bound, component,
   responsive, and state-specific values remain distinguishable. The inspector
   must not label a computed value as authored source.
9. The style mutation planner reports its target and reason. Ambiguous cascade
   intent may fall back to a local override, but cannot pretend it edited the
   original declaration.
10. Desktop, headless, mobile, CI, and agent adapters use the same Design API
    operation schemas. MCP or another external protocol is an adapter, not the
    core document model.
11. Git is the durable checkpoint and review boundary. The bounded transaction
    log is the live editing boundary.
12. All persisted schemas and wire protocols have explicit versions and
    forward-only migrations. Persisted names are compatibility contracts.

## Identity

An authored web element uses a `DesignNodeId`, currently serialized as
`data-oid` on selectable HTML elements. Missing or duplicate markers are healed
with minimal source edits and then remain stable. Production exporters may
strip editor markers only from exported output, never from the canonical
authoring source without an identity-preserving sidecar migration.

Component definition internals use definition-local identity. An address inside
an instance contains a root instance ID plus an ordered, bounded definition
path of `(component ID, definition node ID)` segments. The path remains unique
through nested component instances without duplicating global identifiers.

Foundation 1.0 reserves and validates that address model, while its initial
desktop component slice selects and edits the authored instance wrapper. Deep
selection and override authoring inside expanded definitions is a later editor
feature, not an implied DOM-inspection contract.

All IDs are bounded and validated at every transport boundary. A source offset
is location metadata, not identity.

## Transactions and history

A transaction contains:

- schema version;
- stable transaction and document IDs;
- exact base revision;
- actor identity and actor kind;
- human-readable intent;
- one or more typed operations; and
- optional explicit coalescing metadata.

Operation and receipt arrays are bounded. Idempotency is keyed by transaction
ID plus canonical transaction content: replaying the same transaction returns
the prior receipt, while reusing an ID for different content fails.

The history budget is bounded by both entry count and serialized operation
bytes. Oldest entries are evicted first. Selection and viewport restoration may
be attached as small history metadata, but rendered documents and screenshots
must not be copied into every entry.

History belongs to one opened document session. Shared CSS, tokens, component
definitions, and the workspace manifest still commit with filesystem CAS and
force other document sessions to reconcile, but Foundation 1.0 retains undo for
a shared-resource edit only in the frame session that initiated it. A future
workspace transaction may provide one undo entry spanning several frames.

The authored revision is a deterministic, locale-independent 96-bit prefix of
SHA-256 over all textual files in the opened web document, the Foundation
manifest, and that frame's geometry. It is a conflict key, not the renderer
generation: binary assets and fully composed output are covered by the
separate `sourceVersion` used by iframe, screenshot, and cache protocols.

Collaboration transports may later carry these operations. A CRDT does not
replace the semantic transaction contract.

## Web source adapter

The adapter parses HTML with source locations and CSS with source nodes. Source
mutations preserve unaffected bytes, comments, declaration order, quoting, and
reasonable local formatting. Full-document serialization is not the normal
edit path.

The projection exposes bounded, paginated data:

- stable node identity and hierarchy;
- source file and span;
- tag, attributes, and direct text;
- authored inline declarations;
- matched authored rules and conditional context when available;
- computed values supplied by the browser renderer;
- component/instance scope; and
- diagnostics plus the last valid revision.

The CSS Object Model exposes rules and computed declarations, but does not
standardize complete winning-cascade provenance. Therefore the adapter combines
source AST information with renderer-reported matched rules and records
ambiguity explicitly.

The initial mutation adapter authors only the base responsive context and
default interaction state. It can report conditional and stateful provenance,
but a request to edit a breakpoint or pseudo-state fails closed until an
explicit context adapter can identify the exact at-rule and selector target.

## Components, parameters, and variants

Component definitions, instances, slots, props, and overrides have stable
schemas before a production component-management UI is built.

A parameter has a stable ID, type, default value, optional numeric bounds,
options, unit, bindings, and visibility/constraint metadata. Bindings are typed
and extensible; the initial shipped vertical slice targets CSS custom
properties and declarations. Future binding kinds may target component props,
SVG attributes, animation tracks, shader uniforms, material inputs, and 3D
transforms without changing parameter identity.

The manifest is workspace-owned, but an executable Foundation 1.0 parameter is
unbound or bound to exactly one document. Creating or attaching a binding
atomically synchronizes the current parameter value into source. Cross-document
parameters require a future workspace transaction so a partial multi-file
write cannot occur.

Variants store validated deltas from a base component or document. They do not
duplicate complete source documents.

The shipped vertical slices cover component definition creation, instance
insertion, typed parameter creation/binding/value changes, variant deltas, and
undo/redo through the shared adapter. They do not claim a complete component or
variant-management UI.

## Renderer protocol

The DOM renderer runs in an opaque `allow-scripts` sandbox. Authored scripts,
active URLs, forms, nested frames, workers, and network access remain blocked.
The app injects the only executable runtime and connects it through a private
`MessagePort`.

The protocol has:

- an explicit version;
- source-generation pinning;
- capability discovery;
- bounded request arguments and results;
- request timeouts and cancellation;
- typed error codes;
- ready, mutation, and diagnostic lifecycle events; and
- teardown that rejects pending work and stops observers/timers.

Input handling uses Pointer Events and pointer capture. High-frequency pointer
input is sampled at animation-frame cadence for transform previews. Layout
reads are batched before writes to avoid forced synchronous layout.

## Performance budgets

Foundation code follows these budgets and treats regressions as release
failures:

- at most 12 live DOM frame runtimes per active canvas by default;
- no live runtime, polling, hotkey, measurement, or capture work on retained
  inactive surfaces;
- a single pointer gesture commits one transaction;
- no source parse, filesystem read, bridge request, or React state publication
  on every raw pointer move;
- frame snapshots and node detail caches are exact-keyed and bounded;
- design tree and API reads support explicit depth/limit/cursor bounds;
- screenshot dimensions, pixel count, serialized bytes, and execution time are
  bounded;
- headless screenshots pin browser version, fonts, viewport, scale, locale,
  timezone, color settings, and reduced-motion policy; and
- performance tests cover large/deep documents, many frames, stale races,
  cancellation, hidden surfaces, and A -> B -> A restoration.

Concrete Foundation 1.0 ceilings are part of the contract:

- textual state: 1,024 files, 2 MiB per file, and 16 MiB total;
- transactions: 256 operations and a 4 MiB aggregate input envelope;
- default history: 100 entries/1 MiB of operations plus 512 receipts/4 MiB;
- filesystem recovery journal: 32 MiB, with validated paths, revisions, source
  limits, and symlink-safe write parents;
- component composition: 1,024 reachable definitions, 512 KiB per loaded
  definition, 16 MiB of definition source, depth 8, and 2 MiB expanded output;
- desktop render preparation: 128 linked stylesheets, 12 MiB of inline raster
  assets, 15 MiB sanitized output, and 16 MiB runtime-enabled output;
- headless rendering: two concurrent pages by default (four maximum), one
  15-second overall deadline by default (60 seconds maximum), 16,777,216 output
  pixels, and 16 MiB artifacts; and
- retained desktop state: source/srcDoc-free aggregate canvas reads with bounded
  asset previews, at most 16 hydrated full-frame documents/64 MiB, 32 MiB of
  Foundation projection cache, and a 32 MiB per-workspace Design API session
  budget.

The generic API additionally defaults to 32 sessions/64 MiB; the desktop keeps
at most eight workspace API owners. Weighted caches may temporarily exceed a
budget only while their exact keys are active or pending, then evict inactive
least-recently-used entries.

Offscreen content may use browser containment only when focus, accessibility,
selection, measurement, and screenshot behavior remain correct. Distant frames
prefer exact-generation thumbnails over hidden live iframes.

## Headless and mobile contract

The headless API opens a workspace through an injected storage adapter,
returns exact-revision document summaries, applies/dry-runs transactions,
queries bounded projections and provenance, renders frames, captures artifacts,
and reports diagnostics. It does not require Electron or a mounted React tree.

Mobile foundation validation means the same frame manifest and source revision
can be rendered at a mobile viewport with bounded progressive loading and
Pointer Events. It does not promise a complete mobile authoring interface.

The release smoke renders real Chromium pixels at desktop and 390 x 844 at 2x
device scale. CI pixel baselines must report both authored revision and composed
`sourceVersion`, pin Chromium and fonts, and never compare unpinned host pixels
as if they were deterministic.

Remote exposure remains deny-by-default until account/workspace-bound grants,
tenant authorization, quotas, audit, and deletion/retention requirements in
the cloud-workspace contracts are satisfied.

## Agent contract

Agent reads are bounded and paginated. Agent writes support dry-run, explicit
base revisions, scoped capabilities, receipts, provenance, and reviewable
diffs. Long-running render or comparison jobs support cancellation and durable
task identity at the adapter boundary.

The product must preserve human awareness and control: an agent proposal can
branch, compare, annotate, and request approval without overwriting the active
design. Accepted and rejected alternatives remain attributable.

## Foundation/editor boundary

Foundation 1.0 includes the headless model and API, source/provenance adapters,
sandbox renderer protocol, bounded caches, a selectable layer/canvas workbench,
element and frame resize transactions, a provenance-aware base-state inspector,
component insertion, Tweaks controls, and document undo/redo.

Frame creation, rename, duplication, deletion, and **Save Designs** remain
atomic workspace lifecycle/checkpoint commands outside per-document undo.
Mobile authoring, multiplayer transport, breakpoint and pseudo-state authoring,
deep component-internal overrides, vector path editing, 3D/shader renderers,
and an agent proposal UI are explicitly post-Foundation product layers. Their
future adapters reuse stable identity, transaction, provenance, parameter,
geometry, capability, and revision contracts; their absence does not require a
second durable web document model.

## Foundation 1.0 release gate

Foundation 1.0 is frozen only when automated tests prove all of the following:

1. Stable identities survive formatting, movement, reload, and supported
   external edits.
2. A batched semantic style/text edit produces minimal readable source,
   rejects a stale revision, and round-trips through undo and redo.
3. Source provenance distinguishes inline, stylesheet, token, component,
   computed, and ambiguous values without inventing certainty.
4. Desktop and headless callers applying the same transaction receive the same
   resulting revision and source change.
5. The renderer rejects version/source mismatches, cancels abandoned requests,
   tears down cleanly, and keeps authored content sandboxed.
6. Canvas selection and element/frame resize remain correct under zoom, stale
   responses, pointer cancellation, and inactive-surface transitions.
7. One component instance and one typed parameter/variant execute end to end.
8. Desktop and mobile viewport headless renders pass structural and screenshot
   smoke tests in the pinned environment.
9. Large-canvas and deep-tree tests remain within documented memory, request,
   and live-runtime bounds.
10. Repository type, lint, UI, security, protocol, preload, license, build, and
    applicable smoke gates pass.

## Research and standards basis

The implementation follows the source-location and formatting-preservation
contracts exposed by [parse5](https://parse5.js.org/interfaces/parse5.ParserOptions.html)
and [PostCSS](https://postcss.org/api/), the browser
[CSS Object Model](https://www.w3.org/TR/cssom-1/), and the unified input model
in [Pointer Events](https://www.w3.org/TR/pointerevents3/).

Bounded records, schema migrations, and indexed derived state follow the same
general principles documented by the [tldraw Store](https://tldraw.dev/sdk-features/store).
Future collaborative transport should retain explicit transaction origins and
bounded undo semantics such as those documented by
[Yjs](https://docs.yjs.dev/api/undo-manager).

Headless visual comparisons must use a pinned environment because browser
pixels vary across operating systems, settings, and hardware, as documented by
[Playwright](https://playwright.dev/docs/test-snapshots). Renderer
virtualization and scheduling follow browser guidance on
[rendering work](https://web.dev/articles/rendering-performance),
[layout thrashing](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing),
and [content visibility](https://web.dev/articles/content-visibility).

External agent adapters follow capability discovery, pagination, cancellation,
human control, and authorization guidance from the
[Model Context Protocol](https://modelcontextprotocol.io/specification/2025-11-25).
The internal Design API remains independent of any one adapter revision.

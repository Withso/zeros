# Native Design authoring v1

The shared agent writes HTML/CSS with its ordinary provider tools in Design
mode. Saved source is already the Design document: no import, publish or API
apply is required. The existing Design tag and tab are the entire mode UI.
This enhancement implements HTML/CSS v1 only; Phase 2, Phase 3 and subsequent
roadmap features remain deferred.

## Files and ownership

`design.toml` v2 registers a directory and points at `canvas.json`. Zeros manages
registration and generated `rules.md` through lifecycle operations. Agents edit
HTML, CSS, assets and the canvas index using their usual Read/Write/Edit/patch
and shell tools. Code mode permits inspection; user-authorized Design mode
permits authoring. This is an instruction policy and managed-tool gate, not an
OS filesystem sandbox. Provider permissions and Plan settings still apply.
Design mode does not make Code read-only.

Cloud workers retain their sandbox policy, which prevents native Design file
writes. Their prompts and mode-switch replies use the Design API authoring
instructions: discover capabilities, create frames and apply semantic edits at
an exact revision. If the API connection is unavailable or at capacity, Design
prompts stop until it is restored; they cannot fall back to native writes.

The engine supplies the active directory, its workspace and mode revision with
each prompt/steer. Agent switches use that revision, return fresh instructions,
and preserve the conversation/provider. Missing or ambiguous directories require
Create design directory or an explicit selection; the agent must not guess.
Optional MCP helper capacity does not gate native file authoring in a valid
local workspace. Design discovery failures, including unresolved manifest index
conflicts, leave Code prompts available to help repair the workspace. Malformed
registration and legacy recovery blockers still stop dependent Design work;
ownership changes and cancellation always stop the affected execution.

A minimal canvas index is:

```json
{
  "version": 1,
  "id": "main",
  "title": "Product",
  "pages": [{ "id": "main", "title": "Screens", "frames": ["home"] }],
  "frames": {
    "home": {
      "kind": "html",
      "source": "home.html",
      "title": "Home",
      "x": 0,
      "y": 0,
      "width": 1440,
      "height": 900
    }
  }
}
```

Frame IDs identify canvas entries independently of source filenames. Rename the
source and change its `source` reference while preserving the ID. Add/remove
the corresponding page membership when adding/removing a frame. IDs start with
a letter, contain letters/digits/underscores/hyphens, and are at most 128
characters. The supported kinds are `html` and the existing canvas `text`
frame. Source references are flat relative `.html` filenames, unique under
portable case folding. Unregistered HTML remains source, not an implicit frame.
The format admits one page, at most 256 frames, dimensions 1–16384 and positions
within ±1,000,000. Unsupported versions/kinds, duplicate references, unsafe
paths and missing referenced sources produce errors instead of being rewritten.

Canvas/page titles and existing Foundation metadata are portable authored
content. Page membership normally determines stacking order; optional `z`
preserves historical absolute ordering. Unknown supported extension fields
survive engine writes. Legacy geometry extensions use `geometryMetadata` to
avoid colliding with frame extensions. Camera, credentials, grants, recovery
journals, captures and caches do not belong in this file. No DOM/node tree or
copy of the HTML is stored here.

## Edit and refresh loop

Read rules and canvas metadata once, then relevant source. For a new frame,
write a complete HTML document and its canvas entry; for a revision, patch the
existing files. Ordinary worktree events invalidate the exact workspace cache.
The renderer retains its last confirmed canvas while revalidating, including
through temporary invalid JSON or missing files during a multi-file save. The
next valid save recovers through the same event path. Native multi-file saves
are not atomic Design API transactions.

Preview and inspection derive selection IDs for plain HTML without rewriting
it. A visual or semantic edit persists the needed IDs as part of that explicit
edit. Source offsets still reference original bytes. Render generations include
raw source, rendered dependencies and viewport size; outdated visual requests
must refresh. Engine visual writes compare original source and metadata before
their journaled commit. Native tools follow their normal concurrency behavior:
re-read changes and avoid blind whole-file replacement. There is no cross-process
locking promise for arbitrary shells or external editors.

Optional API List/Inspect/Inspect Styles/Validate/Capture calls and existing
semantic edits remain available. Native edits invalidate incompatible semantic
undo history; they do not gain API receipts merely because a watcher saw them.
Semantic undo remains exact-revision, session-local and tip-only. Native undo
uses normal provider history or explicitly authorized Git operations.

New `tokens.css` defaults preserve normal inline and flex behavior and never
select every `data-oid` to change its layout. Existing authored stylesheets are
not replaced. A legacy folder can therefore retain its old broad layout reset
after metadata migration. Read shared styles before importing them into a new
frame; use scoped overrides or independent styles instead of rewriting shared
CSS that existing frames rely on. Manually adding `data-oid` to every new element
is unnecessary; the preview derives selection identities for ordinary HTML.
Rendering retains its sandbox, sanitization, local-asset policy
and byte/runtime limits. JavaScript/TSX execution, framework builds and new
surface kinds are not implemented here.

## Compatibility and Git

Legacy inline `design.toml` documents, central `.zeros/design/` registries and
`.zeros-canvas.json` remain readable. Explicit Design authoring migrates them
with stable directory identity, frame identity, geometry, Foundation data and
extensions preserved. Recovery journals publish the canvas and registration
before deleting predecessor metadata; competing copies fail closed. Code
inspection and normal canvas reads do not migrate a branch. Old clients reject
the new registration version rather than silently downgrading it. Existing
`frame:<filename>` IPC/document identifiers remain compatible internal addresses.

Removing registration preserves HTML/CSS/assets and `canvas.json`. Re-adoption
uses the preserved scene and can recover registration identity from Git.
Private recovery state is retained; there is no new private authored store.

Both modes can use authorized managed stage/commit/push/pull/merge/PR operations.
Saving never stages or commits. V2 Design commits validate the captured index's
registration, rules, canvas and referenced frame files, independently of later
unstaged changes. A pull is still an explicit branch integration; PRs publish
committed history. Existing conflict pause/recovery behavior remains, without a
new Design conflict UI or Git-as-editor bypass.

## Qualification

Regression coverage includes native authoring, plain-HTML visual selection and
editing, semantic inspection/edit/undo, missing sources, source renames,
metadata compatibility, mode-entry migration, staged-versus-unstaged validation,
and retained renderer snapshots. A real Chromium test verifies normal flex and
inline layout, native source refresh and preservation of authored stylesheets.
Repository gate results are recorded at implementation handoff. Live provider
latency and macOS packaged-app behavior require their own host qualification;
passing local fixtures is not a promise that every design takes 30 seconds.

Linux source qualification on 2026-09-17:

- `pnpm test:git`: 965 files / 10,553 tests passed; one file / 29 tests skipped.
  Regressions include no-op native source preservation, complete edit receipts,
  exact undo, implicitly discovered legacy frames and optional MCP startup failure.
- `pnpm test:ui-smoke`: 946 checks passed, with no uncaught page errors.
- `pnpm check:design-containment`: 27 files / 720 tests passed. Its historical
  command name does not imply a filesystem sandbox for composer modes.
- Typecheck, lint, UI consistency, UI build and engine build passed. The existing
  canvas hook warning and bundle chunk-size warning remain.
- Secrets, preload, migrations, protocol compatibility, runtime pins, packaging
  paths, Electron hardening, deep-link schemes, Vite environment, dependencies
  and third-party license checks passed.
- `pnpm agents:smoke:offline` passed for Claude/Codex startup and Cursor
  Node/Electron hosts. Live model-authored Design requests were not exercised.
- `pnpm smoke:engine` reported its Linux skip; macOS packaged-engine behavior
  remains unqualified here. No provider generation-time benchmark is claimed.

Phase 2–8 feature sections remain unchanged in the roadmap.

Additional host verification on 2026-09-18 confirmed Design prompt entry upgraded
a legacy registration to v2 and created its canvas index. A live provider run
then authored HTML and canvas metadata through normal shell tools, without API
apply/publish. An observational read through the preview preparation pipeline
rendered that saved frame in Chromium at its declared size without page errors
or source changes. The rebuilt macOS packaged engine also passed sustained
health and workspace create/archive/restore smoke checks. These checks do not
measure provider generation latency or qualify every provider/model.

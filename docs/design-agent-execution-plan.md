# Shared Code and Design agent: minimal v1

**Decision and implementation: 2026-09-17.** This is the reduced integration
scope accepted after the earlier UI proposals. It replaces the larger proposed
pre-Phase-2 integration gate. The existing workbench/backend foundation and
Phase 2–8 feature packages remain in place. Verification is recorded at the
end of this document; implementation is not a claim of release or live-provider
qualification on every host.

## User experience

One workspace, branch, conversation, and provider binding handle Code and
Design. The existing Design tab stays beside the other workbench tabs. Without
a directory, its primary action is **Create design directory**.

In the composer's **+** menu, **Design — Create and edit designs** selects
Design mode. A removable Design tag appears beside +, before the other composer
controls. Removing it selects Code. Authorized agent switches update the same
conversation state and tag. Selecting a tab, inspecting Design, or reading
repository instructions never grants permission to edit it.

There are no frame/node context pills, mode-switch progress indicators, special
streaming cards, new proposal review, new mixed Git workflow, or new conflict
resolver. Existing errors, editor controls, Git operations and conflict guards
remain. Mode selection does not change provider Plan/permission settings or
make Code files read-only.

## Runtime ownership

- `chats.composer_mode` and `composer_mode_revision` are engine-owned SQLite
  fields (migration 39). Legacy chats default to Code. Ordinary sidebar upserts
  cannot overwrite them. Trusted cloud restore/fork preserves them explicitly.
- `chats.setComposerMode` owns manual selection. It validates conversation/folder
  identity and remote visibility. A never-persisted chat can be seeded from its
  current sidebar metadata; a deleted chat cannot be resurrected by this route.
- `design_mode_set` owns agent selection. Its required `expectedRevision` comes
  from the current prompt or `design_capabilities`; a late switch cannot overwrite a newer manual
  selection, including an away-and-back transition.
- User intent is instruction policy. Only switch for user-authorized Design or
  Code work. A mixed request can authorize both; repeated approval is not needed.
  Neither a tool schema nor a model assertion proves natural-language consent.
- User selections are serialized per conversation. Prompt and steer submission
  wait for pending selections. Engine mode instructions precede each submitted
  prompt/steer; an agent switch returns the new instructions in its tool result
  before the next model continuation. No second provider session is created.
- The native MCP registration retains the compatible `design-draft` name and
  `ZEROS_DESIGN_AGENT_CAPABILITY` credential channel. Its schema catalog stays
  stable across mode changes, including within a native turn. Tool-name
  discovery is not write authority: Code can discover signatures and inspect,
  but every API Design write requires the current Design mode and generation.
  Native file tools follow the mode instructions and provider permissions; they
  are not intercepted or protected by an OS sandbox.
  This avoids refreshing a shared Cursor executor or relying on provider-specific
  mid-turn tool-catalog reloads.
- `ConversationDesignTools` lazily binds the active registered directory. A
  missing directory can be created and then used through the same MCP connection.
  Local directory transitions suspend and revoke document grants, then permit
  a fresh capability read; they preserve the provider and MCP endpoint. Existing
  cloud execution-boundary transitions retain their separate lifecycle policy.
- API writes retain the existing owner/directory checks, document CAS,
  durable request receipts, journal recovery, and actor-local undo. Code mode
  cannot apply a cached or queued write. Already-admitted journals finish or
  recover consistently even if Stop or a mode change arrives during commit.
- Stop cancels pending Design work. A subsequent prompt starts a new tool turn;
  late prompt preparation and steering cannot clear Stop. Session disposal
  revokes the endpoint, including an admission still in flight.
- A first Code prompt may precede sidebar persistence; it remains read-only for
  Design until its conversation exists. Deleted/archived owners are rejected.
  Invalid workspace ownership blocks Design prompts. At the 16-execution MCP
  capacity limit, ordinary file authoring remains usable with validated directory
  context; optional helpers require a free connection. No credential or provider
  permission is broadened.

## Tools and direct editing

The provider uses its normal Read/Write/Edit/patch/shell tools to author files
in the selected Design directory. Saves are ordinary branch changes and refresh
the existing canvas through the workspace watcher. No API save/publish step or
per-node creation sequence is needed. Native tool rows keep their provider's
normal presentation. No permanent private authored store is involved.

Optional MCP helpers use the checkout-backed Design API. `DesignDraftStore`
remains the journaled transaction repository for those helpers and visual edits.
These calls retain the existing compact Design icon and labels:

| API operation | Ordinary transcript label |
| --- | --- |
| `design_capabilities` | Inspect |
| `design_document_list`, `design_request_list` | List |
| `design_document_open`, `design_source_read`, `design_projection_read`, `design_render`, `design_request_status` | Inspect |
| `design_foundation_read`, `design_provenance_read` | Inspect Styles |
| `design_transaction_apply` | Edit |
| `design_frame_create`, `design_frame_rename`, `design_frame_duplicate`, `design_frame_delete` | Create, Rename, Duplicate, Delete |
| `design_lint` | Validate |
| `design_capture` | Capture |
| `design_history_undo`, `design_history_redo` | Undo, Redo |
| `design_mode_set` | Switch mode |

These use the existing compact expandable tool row with the Design pen icon.
Expanded details use the normal source/text/JSON surface. Native MCP identity,
not a Design-looking unqualified name, selects this presentation. Ordinary Code
and third-party MCP tools keep their existing rendering. Capture uses native
MCP image content plus metadata, rather than dumping base64 into code details;
only hosts with a configured capture renderer advertise it.

Proposal and result-bundle tools are not advertised or callable through this v1
conversation endpoint. Existing internal proposal/evidence data and human
review compatibility remain; direct edits need no proposal.

A useful task runs as follows:

1. Select Design, or make a request authorizing the agent to switch. A switch
   uses the revision supplied in the current prompt. Provider permissions apply.
2. Prompt preparation resolves the selected directory and migrates legacy
   metadata if necessary. If absent, use Create design directory in Design.
3. Read `rules.md` and `canvas.json`, then only the relevant source files.
4. Write a complete HTML frame and add its stable ID/source/bounds to the canvas
   index, or patch an existing file. No required capabilities/apply/save call.
5. Saved files appear in the existing canvas. Inspect/validate/capture only as
   needed. Visual changes edit those same files; stale edits must re-read.
6. Continue authorized Code work in the same conversation. Git operations retain
   their existing requested scope; saving does not stage or commit.

Native changes are not semantic API transactions or durable API receipts.
External edits invalidate semantic undo; native undo uses provider edit history
or authorized Git workflows. API lost replies still require checking the
original receipt before replay. On a stale revision, re-read and prepare a new
edit. `design.toml` and generated `rules.md` stay under engine lifecycle ownership.
The [native authoring contract](design-native-authoring.md) defines the schema,
legacy migration, source identities and renderer behavior.

## After v1

These are deferred enhancements, not prerequisites for Phase 2:

1. Frame/node context delivery through composer references, including stale,
   missing and wrong-directory handling.
2. Rich semantic tool results, property diffs, before/after previews, source-bound
   evidence navigation and richer capture presentation.
3. Optional proposal review with Apply/Reject; preserve direct editing.
4. Additional agent-accessible managed Git integration, Code/Design ownership
   handoff in Changes, and PR comparisons pinned to published remote base/head.
5. Semantic Design conflict resolution in a temporary integration context with
   exact branch/index/source preconditions and a dedicated review/apply surface.
6. Richer recovery, readiness and availability interfaces where needed.
7. Additional provider/host qualification, deployed-cloud continuity and
   background-job guarantees beyond the tested v1 paths.
8. Existing roadmap phases: controls/media (2), Code components/pages/scenarios
   (3), browser frames/capture/import (4), prompt-built tools/export (5), lightweight
   Design components (6), advanced orchestration (7), and canvas/extensions (8).

Code Restriction and designer-only workspaces remain separate deferred product
work. A permanent private authored store and separate specialist sessions are
not reintroduced by these follow-ups.

## Verification

Targeted regressions cover mode persistence and stale upserts; Code-mode API write denial;
away-and-back queued writes; actual HTTP MCP switching, directory creation,
direct frame creation/edit/validate/undo, native image Capture, duplicate receipts
and Stop; cloud restore; per-chat renderer races and immediate-send fencing;
ordinary Design tool rendering, including Cursor child transcripts. Failed mode
selection keeps unsent messages editable; Stop while selecting never steers a
message into a retired turn.
The browser fixture uses the production + menu, Design tag, composer editor and
tool rows, with synthetic transport. Live provider canaries and macOS-only
engine smoke must be reported separately from these repository tests.

Historical minimal-mode validation on Linux, before the native authoring enhancement:

- `pnpm test:git`: 960 files / 10,520 tests passed; one file / 29 tests skipped.
- `pnpm test:ui-smoke`: 946 checks passed, with no uncaught page errors. The
  browser exercised selection/removal, agent-driven updates, conversation
  isolation, Escape/focus, concealed menus and all seven primary Design rows.
- `pnpm check:design-containment`: 27 files / 717 tests passed.
- Typecheck, lint, UI consistency, UI build and engine build passed. Lint retains
  the existing canvas hook warning; the UI build retains its chunk-size warning.
- Secrets, forward-only migrations, protocol compatibility, preload, runtime
  pins, packaging paths and third-party license checks passed.
- `pnpm agents:smoke:offline` passed for the pinned Claude/Codex binaries and
  Cursor Node/Electron hosts. This verifies startup/protocol behavior, not live
  model-authored Design edits or deployed-cloud continuity.
- `pnpm smoke:engine` reported its Linux skip. The macOS packaged-engine smoke
  and live provider Design canaries were not run in this implementation pass.
- Later feature phases were retained. See the native authoring contract for the
  enhancement verification; these historical counts are not its qualification.

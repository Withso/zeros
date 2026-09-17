# Shared Code and Design session: v1 plan

**Decision: 2026-09-17. Status: shared workbench and backend foundations
implemented; composer mode and provider integration pending.** This replaces the private authored-store/publication plan and the
separate Design-agent session architecture. It does not replace the later
feature phases in [the roadmap](design-mode-roadmap.md). The
[workspace guide](design-workspace.md) describes current runtime behavior.

## One workspace, session, and source

Use the existing agent conversation, provider execution, context, tools, and
resume lifecycle for both Code and Design. Composer mode is per conversation,
bound to its workspace; selecting a tab does not change mode. Add a Design tab
alongside Files, Changes, PR, and Review in the existing workbench column.
The workbench now keeps the existing conversation present and removes the top
Code/Design surface switch. A one-time migration preserves old view selections;
`workspace.kind`/`viewMode` must not become agent authorization by accident.

Authored HTML, CSS, assets, `design.toml`, and `rules.md` stay in the checkout,
on the same branch and index as Code. Keep `DesignDraftStore`: it is the
transaction repository over those files, not a second authored database.
Keep validation, exact-revision CAS, atomic writes, journals, bounded history,
proposals, and evidence. Private engine state still holds recovery records and
receipts; it is not another editable copy of the Design document.

Autosave remains silent. Cmd/Ctrl+S flushes pending changes and validates; it
never stages. Review stays compact and undimmed, with independent comparisons,
Stage, Unstage, and Commit actions. Design review filters the shared Git state.
There is no export checkpoint, private D2, or separate Update Design step.

## Composer mode and tools

| Capability | Code mode | Design mode |
| --- | --- | --- |
| Read Code and Design context | Yes | Yes |
| Authored Design mutation through Design API | No | Yes |
| Ordinary Code tools | Available | Available; instructions direct Code edits back to Code mode |
| Managed stage, commit, push, pull, merge, PR | Available for authorized scope | Same |
| Direct authored Design writes through shell/editor/patch/ad hoc Git | Prohibited by workflow rules | Prohibited by workflow rules |

There is **no Code-write sandbox or restriction toggle** in v1. Design mode is
a tool/prompt state in the same session. It does not make Code files read-only,
start ZSR, spawn another provider, or provide an OS security boundary. Existing
cloud worker policy, browser isolation, and untrusted-renderer sandboxing keep
their independent purposes.

The user may select a mode. The agent may switch when the user's request
explicitly authorizes Design work or the corresponding return to Code work;
inspecting a frame or deciding a design could be improved is not authorization.
A mixed request can authorize both modes for that task without another prompt
for each transition. Mode switching never broadens workspace or Git scope.

Persist the current mode and a monotonic generation with the conversation.
After the engine confirms a switch, inject the new mode's instructions before
the next model continuation, including a continuation within the same turn.
Restore that state on resume, reconnect, and compaction. Provider-native
permission modes are a different concept; do not overload their identifiers.

Hide Design editing tools in Code mode **and** check mode/generation at server
admission and immediately before mutation. A stale tool name, bearer, queued
call, or resumed provider must not bypass the gate. Allow an admitted atomic
write to finish or recover consistently before confirming a conflicting mode
transition; do not abandon a half-written journal. Reuse the existing session
tool registry and write-authority checks. Read-only Design context remains
available through inspection routes without issuing a write grant.

Clicking/attaching a frame can add a context pill in either mode. Its identity
includes workspace, Design directory ID, document/frame, optional selected
nodes, and source revision. The pill is context, not an instruction or a mode
switch. Re-read stale revisions and report deleted/replaced identities; never
redirect a stale pill into a different document with the same display name.

## Git and metadata

Both modes may use the existing managed Git service to stage/commit authorized
Code and Design changes, push branch history, pull, merge, rebase, and prepare
PRs. The managed workspace stage/unstage/commit routes now admit Code and
Design, preserving explicit paths and the captured index. Design review retains
its Design-only commit lane; internal Code-only callers keep their narrow
authority. Generic authored file/discard/restore/clean guards remain in place.

Pull fetches and integrates; it does not inherently commit anything. Offer or
perform a checkpoint/stash only within the requested scope and with existing
dirty-work rules. Stage D1, edit D2, commit D1 must preserve unstaged D2 and
unrelated staged Code. A mixed commit includes only its approved paths. A push
publishes branch commits; a PR diff must identify the actual base/head commits,
not present unstaged or staged changes as already published. Creating a PR
must not silently commit every local change.

Managed integration can update tracked Design files in either mode. Ad hoc
`checkout`, `restore`, `reset --hard`, `clean`, low-level index/tree commands,
or shell writes must not serve as a substitute Design editor. Legitimate
unstaging changes the index, not authored bytes. Distinguish the actual effect
and approved operation instead of banning every command with the word reset.
These are application/workflow checks, not a claim to contain a native shell.

`design.toml` is readable metadata, written by Design API/lifecycle operations.
Frame edits update geometry, identity references, and source atomically where
required. It is not globally immutable, and it is not a file agents should
hand-edit. Track it with `rules.md` and the Design source. Validate incoming
schema/identity before healing or rendering; unknown formats need an explicit
upgrade/unsupported outcome, never silent conversion.

Conflicts belong to the same task and conversation. The trusted Git service
prepares base/local/incoming versions without corrupting the live canvas.
With Design work authorized, the agent switches to Design mode and resolves
Design through the API against a temporary integration context; Code conflicts
use the normal Code workflow. Validate the merged document and recheck branch,
HEAD, index, paths, and source revisions before applying. Preserve unrelated
staged and unstaged work on complete, cancel, failure, and restart. Raw conflict
markers must never become an editable Design document. Temporary integration
state is recovery data, not a permanent private authored store. Existing
conflict guards stay in place until this workflow is implemented and tested.

## Pre-agent foundation delivered

These nine tasks prepare the shared experience before the agent integration
branch merges. They do not implement the composer mode or grant its authority.

| Task | Implemented behavior and boundary |
| --- | --- |
| 1. Decouple availability | Local managed workspaces initialize/read/edit Design independently of legacy `kind`. No provider or conversation is created by opening Design. |
| 2. Shared layout | Permanent Design tab beside Files, Changes, Review and Context, with the existing agent column and internal Layers/canvas/Inspector. Tab navigation never calls `workspace.setMode`. |
| 3. Navigation and state | One-time legacy selection migration; workspace-owned frame/node/camera/disclosure and panel visibility; existing panel width preferences; at most two inert retained canvases in stable DOM order. |
| 4. Directory lifecycle | Explicit checkout initialization, workspace-local stable-ID selection, missing/invalid metadata recovery, and Settings rename with compatible live checkouts. Main-checkout rename is an explicit commit. Removal requires archiving all open workspaces in the repository. |
| 5. Save and review | Reuse checkout autosave, pending-edit flush, compact Design review, and independent index comparisons. Save never stages. Commit validates the captured staged metadata, allowing a later invalid unstaged draft to remain on disk. |
| 6. Shared Git | Managed mixed staging/commit with explicit scope, metadata companions and index CAS. Existing pull/merge protection remains; no commit-all on pull or PR creation. PR creation publishes existing branch commits. |
| 7. Read-only context | Versioned workspace/directory/frame/node/revision reference with ready, stale, missing and wrong-directory outcomes. No composer pill delivery or write capability is added. |
| 8. Conflict recovery | Raw Git status is read before metadata parsing. Unmerged paths pause the canvas; Retry and explicit Cancel integration reuse managed Git. Automatic Design conflict authoring is deferred. |
| 9. Qualification and guidance | Engine, protocol, state and browser regressions cover the new contracts; repository and macOS qualification results are recorded below. Future roadmap phases remain intact. |

The read-only context and human Design surface are usable without agent-mode
integration. Existing native-session semantic tools retain Phase 1 authority
until the separate mode gate lands. Do not describe the present UI as enforcing
Code/Design agent permissions.

## After the agent integration merges

1. Persist composer mode and generation in the existing conversation. Add
   authorized switches, continuation instructions and server-side Design API
   admission/revocation. Test stale calls, queued writes, restart/resume,
   compaction, multiple conversations and supported providers.
2. Connect frame/node context pills to the versioned inspection contract in
   either mode. Context attachment alone must not switch mode or authorize edits.
3. Add temporary Design conflict resolution under the shared Git coordinator.
   Keep the pause/retry/cancel path for unsupported cases; validate source,
   manifest, identities, revisions and captured branch/index before applying.
4. Qualify the complete agent loop, headless/resumed execution and advertised
   deployed-cloud hosts. Local/native foundation checks do not qualify those
   pending paths. PR review pinned to the published remote base/head, remote
   visual evidence, and richer Changes ownership handoff remain follow-ups.

| Case | Required outcome |
| --- | --- |
| Code-only task with an attached frame | Reads context; no implicit Design write grant |
| Mixed Code/Design task | One conversation; confirmed mode visible; instructions precede each continuation |
| Human edits while agent work is queued | Exact-revision conflict; bounded re-read/re-plan, no forced overwrite |
| Switching mode during a tool call | Revoke stale authority; complete/recover already-admitted atomic work |
| Duplicate request or lost acknowledgement | Existing durable receipt resolves outcome; changed-body replay fails |
| Undo after another actor edits | Tip-only or checked compensating change; never erase later edits |
| Switching workspace/directory/branch | Revoke stale grants and pills; refresh exact-key context |
| Multiple Design folders or deleted/renamed frame | Resolve stable identity and scope; no name-based fallback |
| Dirty Code, dirty Design, and partial staging | Preserve each state; no automatic commit-all or destructive stash |
| Pull/merge with Code and Design conflicts | Same task, appropriate modes; validated temporary resolution before apply |
| External Git races or unsupported merge strategy | Fail/re-read or pause; never force refs/index over newer work |
| Archive/delete while edits or Git are running | Existing lifecycle barrier drains ownership; recovery is retained |
| Old/invalid manifest or conflict markers | Readable diagnostic; no healing mutation or live editable canvas |
| Headless session or missing capture host | Source/API work remains usable; capture reports unavailable |

## Cleanup and compatibility

Removed the gated private authored backend, activation/source resolver,
migration/publication/reconciliation/integration stack, duplicate review and
recovery UI, their IPC/export/cache registrations, and feature-only tests and
qualification scripts. Removed separate Design-session construction, admission
renewal, and provider lifecycle bookkeeping. The old A0–A5 documents described
that removed stack and have been replaced by this plan.

Retained checkout-backed transactions, source guards, review, semantic tools,
capture, durable requests/results, Git index fingerprints, and shared cloud
execution policy. The low-level `design-agent-capability`/`design-agent-mcp`
names remain: they provide tested scoped API and transport primitives, not a
second provider session. Wire `agentRole: "design"` remains parseable for
compatibility but is rejected before provider or workspace admission; there is
no test-only switch to re-enable that retired session path.

Experimental private-draft ownership markers remain recognized and block
checkout writes. No user data or marker is deleted or auto-migrated. If an
experimental workspace has such a marker, preserve its app-data directory and
use its recovery-capable build to export the draft before a deliberate recovery
into the checkout. This build no longer advertises private-draft export or
activation. A direct fallback could hide the only copy of unpublished work.

**Deferred:** Code Restriction, designer-only workspaces, Design-only pull/PR,
mandatory specialist delegation, permanent private authored storage, and
distributed/multiplayer mutation. Phase 2 controls/media, Phase 3 code previews,
and later browser, tool, component, and orchestration features remain planned.

## Shared workbench verification (2026-09-17)

- Full Linux `pnpm test:git`: 865 files passed, one skipped; 9,195 tests
  passed, 29 skipped. The added queued-directory regression verifies that an
  edit cannot retarget a replacement document with identical frame source.
- Typecheck, lint, UI consistency, preload, protocol, secrets, packaging paths,
  Electron hardening and licenses passed. Lint retains one existing canvas hook
  warning; the renderer build retains its existing large-chunk warning.
- Design containment: 27 files / 568 tests passed. Existing ZSR contracts:
  52 files / 566 tests passed, one file / 29 tests skipped. These checks do not
  introduce or claim a mode-specific sandbox.
- macOS arm64: 314 of 317 targeted engine/Git/Design tests passed in the first
  parallel run; three existing transfer cases exceeded their 20-second timeout.
  All three passed in isolation under that same timeout (13.9–16.5 seconds).
  The native sidecar build and packaged `/health`, create/archive/restore smoke
  passed. Qualification used a temporary copy, which was removed afterward.
- Full `pnpm test:ui-smoke`: 810 checks passed with no uncaught page errors,
  including shared conversation/Design navigation, bounded inert retention,
  reload persistence, narrow layouts, conflict recovery and canvas interactions.
  The workbench fixture restores its persistent state before standalone canvas
  checks. `pnpm build:ui` passed with the existing large-chunk warning.
- Phases 2–8 were compared against the starting roadmap and are unchanged.

## Cleanup verification (2026-09-17)

- Full Linux `pnpm test:git`: 862 test files passed, one skipped; 9,179 tests
  passed, 29 skipped. The final focused run passed 50 files / 483 tests.
- Full `pnpm test:ui-smoke`: 806 checks passed with no uncaught page errors.
  Regression coverage retains snapshot-error Retry feedback. The staging
  assertion measures Git actions after review finishes any pending autosave.
- Native macOS: 43 targeted files / 408 tests passed; the arm64 sidecar build
  and packaged-engine health, create, archive, and restore smoke check passed.
- Typecheck, lint, UI consistency, UI build, preload, protocol, secrets,
  packaging paths, Electron hardening, licenses, Design containment, and ZSR
  contract checks passed. Lint retains the pre-existing canvas hook warning.
- Phase 2–6 and 8 text is unchanged from the pre-cleanup roadmap. Phase 7
  retains its advanced orchestration scope with the shared-session dependency.

Earlier smoke attempts exposed a staging-test timing assumption and intermittent
unrelated navigation failures; the complete final run passed. Native fixtures
now use canonical temporary paths and isolated app data. This evidence qualifies
the cleanup, not the pending composer mode, expanded Git workflow, deployed-cloud
experience, or future performance budgets.

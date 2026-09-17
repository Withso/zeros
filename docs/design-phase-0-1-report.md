# Design Phase 0/1: implementation and qualification

Updated: 2026-09-16. This report describes the uncommitted implementation built on
top of the supplied layout work. The [roadmap](design-mode-roadmap.md) retains
the broader phase requirements.

**Architecture correction, 2026-09-17:** qualification counts below are historical
Phase 0/1 evidence, not verification of the cleanup or the new mode workflow.
The private authored backend and separate provider-session path were removed.
The [v1 plan](design-v1-implementation-plan.md) supersedes the earlier delegation
proposal. Native-session tools, review, and checkout-backed transactions remain;
the shared Design workbench, mixed managed Git, read-only context and conflict
pause/recovery are now implemented. Composer modes, context-pill delivery and
automatic conflict resolution remain pending. The v1 plan records their boundary.

## Outcome and scope

Native Code agents can discover and edit an existing authored Design document
through the engine, without an attached canvas or a view switch. The flow
supports exact-revision inspection, dry-run, proposals, semantic edits, lint,
and source-bound HTML evidence. It preserves the native Code execution role and
the existing Design filesystem/Git guards.

The **Review Design changes dialog is now inside the Design tab**. Its left
column shows **Current canvas**; the right column contains changed files and
agent proposals. It supports source diffs, saved before/after previews,
Accept/Reject, Stage Design, Unstage Design, and Commit staged Design. Accepting
a proposal applies source; staging and committing are separate explicit actions.
There is no invented page model ahead of the later multi-page feature.

The follow-up presentation is a compact **640 × 480 dialog with no dimmed
backdrop**, responsive to smaller windows. Keyboard/focus and scroll isolation
remain modal. The shared dialog's normal dimmed default is unchanged. The
[workflow audit](#save-agent-ownership-and-pr-workflow-audit) below distinguishes
current saving and Code-agent permissions from the agreed shared-session mode policy.

The requested implementation is in the working tree, including the remaining
ownership extractions and production capture/result paths. Native Mac engine
and host checks now pass; the earlier Mac access timeout was resolved. **A real
deployed cloud workspace remains an open qualification gate.** The sandbox has
no configured Daytona test credentials, and the Linux worker fixture does not
substitute for authenticated deployed admission, reconnect, and persistence.
Nothing has been staged, committed, merged, or released.

## Review behavior

- All, Uncommitted, Staged, and Unstaged use independent Git comparisons. A
  staged addition deleted from the worktree contributes `0/0/1/1`, respectively.
- Review is pinned to the active manifest directory. Commit checks the entire
  staged index fingerprint and HEAD before committing the reviewed Design lane;
  a concurrent staging change requires refresh. Unstage also works before the
  repository's first commit. Other Code changes keep their separate Git lane.
- Human approval records a trusted reviewer independently of the agent actor.
  A proposal body must match its recorded signature; accept revalidates source.
  Stale proposals remain inspectable and rejectable. An agent applying its own
  proposal is not represented as human approval.
- Saved previews are immutable evidence for a particular proposal, source
  revision, composed HTML hash, renderer, and viewport. They can be marked
  historical when source moves. Screenshots are evidence of rendered pixels,
  not behavioral, accessibility, or visual-correctness tests.
- Exact-key caches retain confirmed data while refreshing. Pointer/focus intent
  warms review/detail reads; detail prefetch admits at most two requests. Hidden
  review adds no polling, shortcuts, measurements, or capture loop. Failed
  commits preserve the user's message; successful commits clear it.

## Implementation boundaries

| Change                                                               | Reason and compatibility                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/design/routes.ts`, `route-params.ts`, `workspace-history.ts` | Move the 35 existing Design route cases out of `workspace/service.ts`. The service still owns remote policy, workspace lifecycle, directory leases, and Git serialization. Existing IPC names and human Design-mode gates remain. |
| `engine/workspace/params.ts`                                         | Share the original request parsing helpers with the extracted dispatcher.                                                                                                                                                         |
| `engine/design/assets.ts`, `source.ts`                               | Separate bounded asset discovery and parser-backed render-source helpers. Existing `document.ts` exports remain compatible.                                                                                                       |
| `design-canvas-camera.ts`, `design-inline-text-editor.tsx`           | Extract concrete renderer ownership seams without changing the public component surface or introducing new effects.                                                                                                               |
| `engine/agents/session-tools.ts`                                     | Own product MCP resources alongside each native execution, including admission still in flight. Merge with user MCP configuration and release late-arriving resources after cancellation.                                         |
| `engine/design/code-tool-admission.ts`                               | Resolve exact workspace/directory identity independently of the visible tab; admit local and worker-owned cloud targets separately.                                                                                               |
| `engine/design/code-tools.ts`                                        | Strict schemas, scoped authority, shared mutation lane, exact revisions, useful authored operations, and honest capability discovery.                                                                                             |
| `engine/design/request-store.ts`                                     | Persist bounded proposal/request receipts across Code-session and engine restarts; prevent unsafe replay after eviction.                                                                                                          |
| `engine/design/write-authority.ts`                                   | Recheck cancellation and grant authority immediately before durable journal admission, including frame lifecycle writes.                                                                                                          |

The remaining concrete ownership seams are now extracted:

- Renderer: `design-workspace.tsx` composes the feature; canvas interaction,
  overlays, frame hosting, inspector, camera, inline text, and review each have
  a named owner. Existing layout gesture modules and DOM hooks remain intact.
- Engine: storage/discovery, document types/seeds, semantic transactions, frame
  lifecycle, assets, node identity, render preparation/budgets, and review are
  separate modules. `document.ts` preserves the existing public exports.
- The runtime still supports the existing authored frame/text kinds. There is
  no new persisted surface format or generic adapter framework. Compatibility
  and future host decisions are in [surface contracts](design-surface-contracts.md).

An AST-normalized comparison against the saved pre-split files found all 128
engine bodies/initializers and 56 of 57 renderer bodies/initializers unchanged,
with none missing. The one intentional renderer difference is the inspector's
new guard against canvas undo/save shortcuts while Review is open. Its failing
browser regression and successful close/re-enable check are retained. Of the
61 initially dirty files, 51 are byte-for-byte unchanged; the other ten are the
documented integration, extraction, smoke, and documentation edit points.

## Native Code tool contract

The gateway attaches the existing `design-draft` HTTP MCP registration during
new and resumed Code sessions. Its header references the execution's private
`ZEROS_DESIGN_AGENT_CAPABILITY` environment value. It does not generate repository
MCP configuration or create another provider session.

Authority names a registered workspace, stable manifest directory ID, and
engine-owned conversation identity. The bearer is new for every execution. A
missing conversation ID uses the execution identity, so cross-execution receipt
lookup is available only when the caller supplies a durable conversation.

Discovery reports the server clock, 24-hour grant expiry, actor, directory,
operation allowlist, and implemented tools:

| Tools                                                                                              | Behavior                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design_capabilities`, `design_document_list`, `design_document_open`                              | Discover the exact target and open a named authored frame. No mutable shared “selected frame.”                                                                                              |
| `design_source_read`, `design_foundation_read`, `design_projection_read`, `design_provenance_read` | Exact-revision reads. Source/projection support bounded pages; provenance describes authored source, not browser-computed values.                                                           |
| `design_transaction_apply`                                                                         | Actor-bound semantic transaction with optional dry-run. Arbitrary source splices and unimplemented operations are rejected.                                                                 |
| `design_proposal_create`, `design_proposal_resolve`                                                | Persist a validated proposal without editing source; explicitly apply or reject it. Apply revalidates the original revision. Tool use is not proof of human approval.                       |
| `design_request_status`, `design_request_list`                                                     | Inspect this actor's retained proposals and retry outcomes.                                                                                                                                 |
| `design_history_undo`, `design_history_redo`                                                       | Existing session-local, actor-checked history. Intervening edits, session eviction, and restart can invalidate it. No selective undo claim.                                                 |
| `design_frame_create`, `design_frame_rename`, `design_frame_duplicate`, `design_frame_delete`      | Engine-owned lifecycle operations with durable request identity. Existing-frame operations require an exact revision. These changes are outside semantic undo.                              |
| `design_lint`                                                                                      | Authored lint without OID healing or stale attached-client audit data.                                                                                                                      |
| `design_render`                                                                                    | Sanitized composed HTML, exact revision, source generation, content hash, and fidelity label. This is not a PNG screenshot or a behavioral test.                                            |
| `design_capture`                                                                                   | Advertised when the private desktop/cloud capture host is available. Returns exact-revision PNG evidence with bounded dimensions and bytes.                                                 |
| `design_result_create`, `design_result_list`, `design_result_read`                                 | Persist, enumerate, and page source-bound bundles. Proposal bundles include semantic dry-run before/after source and HTML, with optional PNGs. Reads are actor-bound and integrity checked. |

The headless MCP regression runs list → open → propose → apply → render against
real engine documents and the SDK HTTP transport. Successful writes emit normal
workspace invalidations and semantic receipts retain actor attribution. No tool
changes the selected tab, moves focus, or performs Git commit/push.

### Retry and recovery

Every mutation has a bounded request ID and timestamp. Transactions carry these
as `transactionId`/`createdAt`; frame/history requests use
`requestId`/`createdAt`. Use the clock returned by discovery for new requests.
IDs are scoped to the admitted actor and directory; reusing a retained ID with a
different body is rejected. Clients must preserve both the ID and timestamp on
retry and must never recycle retired IDs with a new timestamp.

Before source mutation, the engine persists `started`. After success, it stores
the receipt. A lost reply can return that receipt after restart, even if a human
has subsequently edited the document. A crash or failed receipt write between
those steps yields **indeterminate**, which must be inspected and reconciled.
The engine never guesses success from matching current content or repeats that
mutation automatically. A known pre-application revision conflict is rejected;
other uncertain errors remain indeterminate.

Resolved receipts have a rolling count/byte budget and maximum age. Eviction
persists a timestamp cutoff; requests at or before that cutoff cannot become
fresh mutations after restart or an A → B → A content change. This also means an
old, delayed request may need a new ID and a freshly read revision. It is not a
guaranteed seven-day deduplication window.

Started/indeterminate entries never automatically expire. Proposals expire after
seven days and can be explicitly rejected before then. When unresolved records
consume the full budget, new mutations fail closed. An operator reconciliation
workflow for accumulated indeterminate entries is still a product follow-up;
deleting the private ledger is not a safe retry strategy.

### Cancellation and revocation

Pending admission belongs to the execution before any await. Stop/dispose revokes
authority immediately and cleans up a listener that becomes ready late. Grants
also fail after directory replacement, registered-owner changes, archival,
settings changes, or expiry. Expiry/failed authority checks latch revocation.

MCP upload slots and active tool slots are separate. A long-lived connection or
saturated tool lane cannot consume every slot needed to receive cancellation.
An abort is checked again at the synchronous journal admission boundary. Once a
journal is durably admitted, recovery finishes the transaction; cancellation is
not rollback. Engine shutdown revokes product tools before slow cloud/provider
cleanup. No cancellation polling loop was added.

This follows the protocol's cooperative cancellation model, including races
with completion. [MCP cancellation specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)

## Resource envelope

| Resource               | Bound and behavior                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product tool sessions  | 16 admitted or starting executions per engine. Further Code sessions remain usable without a Design grant.                                                                    |
| Per endpoint           | 8 MCP sessions, 32 connections, 4 concurrent request-body reads, 4 active tools.                                                                                              |
| Requests               | 4 MiB HTTP body, 16 KiB headers, 512 KiB semantic tool input; excess work is rejected.                                                                                        |
| Replies                | 2 MiB serialized tool result; source/projection callers use pages.                                                                                                            |
| Retained API documents | 2 documents / 16 MiB estimated retained state per execution. This is not a process-RSS limit.                                                                                 |
| Request/proposal store | 512 entries / 4 MiB per directory, resolved receipt age up to seven days. Atomic private writes; no background sweeper.                                                       |
| Source pages           | Default 16,384 / maximum 32,768 UTF-16 units; never split a surrogate pair.                                                                                                   |
| Capture                | One active capture per host; 20-second deadline, 2048 × 2048 maximum, DPR 1, 16 MiB HTML, 1 MiB PNG. No waiting browser queue; each browser/window is disposed after capture. |
| Evidence work          | Two admitted composition/read jobs per engine, including direct capture. Reject saturation before claiming a new mutation receipt or allocating another result.               |
| Result store           | 16 results / 64 MiB per workspace, 32 MiB maximum bundle, seven-day retention. Atomic private files, bounded index and orphan scan; no idle sweeper.                          |
| Review reads           | At most 128 rows per page; 512 KiB detail patch; each of the eight Git metadata streams is limited to 1 MiB.                                                                  |
| Renderer review caches | Snapshots: 32 entries / 4 MiB; details: 8 entries / 4 MiB; image evidence: 2 entries / 6 MiB.                                                                                 |
| Asset discovery        | 4,096 examined entries, depth 4, 128 images; unsupported entries count toward work. Existing per-file and preview byte budgets remain.                                        |

Large directories are truncated during iteration before sorting the collected
entries. Ordering below the scan limit remains the existing sorted order; an
oversized directory does not promise a globally alphabetical first page.

No new watcher, idle polling, animation loop, or always-on browser was added to
the product. Cloud startup performs one sandboxed render canary before
advertising capture; ordinary captures launch only on request. Source edits now join chunks once instead of repeatedly copying the
whole document. Tool schemas are prepared once rather than rebuilt per discovery.

These are admission and retained-data bounds, not a hard CPU/RSS/GPU quota. HTML
parsing and existing metadata fsync still run in the engine. The private receipt
file is rewritten atomically per state transition; it is not a high-throughput
replicated job database. Large-document latency and native aggregate memory need
their own qualification before increasing these limits.

## Capture and durable evidence

Desktop capture runs in a dedicated hidden Electron window with a private,
nonpersistent session, sandbox/context isolation, no Node integration, denied
network/permissions/downloads, sanitization, and a leading script-blocking CSP.
Host readiness waits for fonts, images, and two animation frames. Native Mac
qualification found that disabling JavaScript also disabled the host readiness
evaluation; the final host allows its own evaluation while CSP/sanitization
continue to block authored scripts. Pixel and network regressions verify this.
Theme and reduced-motion media emulation is scoped to that disposable page,
using Electron's private host debugger transport; it does not expose a debugging
port or change the application theme. [Electron debugger API](https://www.electronjs.org/docs/latest/api/debugger),
[Chromium media emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setEmulatedMedia).

Cloud capture runs a pinned Playwright/Chromium install from immutable image
paths as dedicated UID 10002 with an allowlisted environment containing no
provider/capture credentials. Chromium sandboxing is explicitly enabled. The
coordinator owns admission until the process closes, terminates the process
group on cancellation, and escalates to a kill after one second. There is no
unsandboxed fallback. Failed preflight omits capture while source tools remain
usable. [Playwright launch options](https://playwright.dev/docs/api/class-browsertype#browser-type-launch).

A result snapshots source, tokens and component inputs inside a short mutation
lane, then renders the frozen composition outside that lane. Human editing can
continue during capture. Finalization reloads the current request ledger rather
than overwriting intervening proposals. Artifact inventory, lengths, hashes,
and canonical base64 are checked on write and read. Directory authority is
rechecked before private persistence; raw captured HTML never executes in the
review dialog.

These are local durable artifacts. They do not create a replicated job database,
a process-wide disk quota across all workspaces, or a guarantee that a deleted
cloud workspace can be recovered. Source parsing remains engine work; the
admission limits are not OS CPU/RSS/GPU quotas.

## Bugs found and iteration

Each correction retained a regression that first reproduced its failure:

1. Pending admission could survive stop and publish a late live endpoint.
2. Revocation during an awaited operation needed another check at durable write
   admission, including the older Design-agent capability path.
3. HTTP initialization could pass its session limit before awaiting the body.
4. Concurrent partial bodies were insufficiently bounded; the first bound then
   exposed starvation from counting long-lived connections against tool work.
5. Receipt capacity initially stopped all future work; rolling resolved receipt
   eviction now persists a cutoff to preserve replay safety.
6. Asset discovery capped returned images while scanning arbitrarily many
   unsupported files and empty directories.
7. Removing nested active HTML ranges could erase valid following content.
8. Recursive traversal exhausted the JS stack on deeply nested generated HTML.
9. Known revision conflicts were unnecessarily retained as indeterminate.
10. Directory ownership had to be rechecked after admission, and engine stop had
    to revoke grants before awaited shutdown work.
11. Cloud transport presence was too broad an admission signal. Design tools now
    use the engine's immutable cloud-worker configuration instead.
12. Render evidence now hashes the actual UTF-8 HTML bytes and names the hash
    algorithm, so independent clients can verify the artifact directly.

The follow-up implementation also found and fixed:

13. Review changes were missing invalidation events after unstage, proposal
    resolution and evidence capture. Regression fixtures now cover all three.
14. Capture held the Design source write queue while waiting on a browser. A
    regression now edits the source during capture and verifies that the saved
    evidence still describes its original source.
15. Finalizing a result could replace concurrent request-ledger entries. The
    implementation claims and finalizes under separate short locks and reloads
    the latest ledger at finalization.
16. Artifact tampering and unsafe evidence indexes needed explicit integrity
    checks. Both fail closed; corrupt bytes are not displayed as trusted evidence.
17. Proposal review needed to recompute its semantic signature before accepting
    persisted contents. Stale/tampered proposals have explicit regressions.
18. Git unstage failed on an unborn HEAD. Path-scoped reset preserves the draft
    and works both before and after the first commit.
19. Committing after a concurrent index change could checkpoint different staged
    content. Commit now requires the index/HEAD fingerprint the user reviewed.
20. Cancellation needed to retain cloud capture admission until worker cleanup.
    Tests exercise cleanup, saturation, cancellation and subsequent recovery.
21. A renamed file's detail diff omitted the old path and appeared as a new
    file. Review now carries both paths through its exact cache key and validates
    both against the Design boundary before requesting the comparison.
22. Native captures did not honor theme/reduced-motion media queries. A real
    Mac pixel test failed first; capture now sets these preferences on its own
    disposable page, preserving the user's app/OS theme. Light and dark checks
    pass alongside the existing isolation and cancellation checks.
23. The inspector's window-level keyboard listener could run undo/redo/save
    behind Review. A failing real-browser regression demonstrated all three
    writes. The listener now defers to the open modal, including its portaled
    controls, and a close/re-enable check verifies normal canvas shortcuts resume.

Additional tests cover actor spoofing, forbidden paths/operations, unsupported
capture discovery, stale proposals, lost acknowledgements, receipt-write failure,
restart, interleaved human edits, frame lifecycle, expiry, and late cleanup.

## Host and compatibility decisions

- Keep manifest envelope v1, canvas v3, Foundation v1, existing transport names,
  and existing runtime protocol. Legacy registry/canvas reads remain; Code tools
  require the engine-migrated stable manifest ID. Unknown versions/kinds remain
  rejected, with no automatic destructive downgrade.
- Current authored identity remains directory ID + `frame:<portable HTML file>`;
  source revision and runtime generation remain separate. A future rename/move
  format must migrate identity explicitly instead of silently reusing paths.
- Keep the current authored frame/text adapters and bounded iframe lifecycle.
  Add a generic surface adapter only with a concrete third-kind caller and
  versioned recovery fixtures.
- A DOM iframe cannot own an independent Electron session partition. The browser
  candidate is a separately owned native host with an explicit focus/overlay
  composition contract; macOS qualification is required before acceptance.
  [Electron WebContentsView documentation](https://www.electronjs.org/docs/latest/api/web-contents-view)
- General executable tool documents remain disabled. A separate JS worker can
  be interrupted, but that does not qualify browser DOM/WebGL execution or OS CPU
  limits. Start later tools with restricted host-driven work and explicit budgets.

Development probes are `node scripts/design-baseline.mjs` and
`node scripts/design-host-prototype.mjs`. Their reports are written under
`.context/`. The first runs all focused Design browser smokes and samples an idle
renderer. The second tests real browser-context storage separation, iframe
limitations, context focus/capture/teardown, and a non-yielding Node worker.
Use `--measure-only` for a fresh idle sample without claiming a smoke run.

## Qualification and remaining gates

### Renderer and native measurements

Linux reference: x64, Chromium 147.0.7727.15, seven available Xeon 2.90 GHz
vCPUs, approximately 16.25 GiB host RAM, viewport 1440 × 900. The default fixture
has two frames and 48 generated layers; browser interaction smokes also use a
10,000-layer fixture.

The baseline uses a fresh context, two-second settle, forced GC, then three
three-second idle windows. Heap is JavaScript heap, not process RSS.

| Default fixture with review closed        | Before ownership extraction | Final review implementation |
| ----------------------------------------- | --------------------------: | --------------------------: |
| Median task time per three seconds        |                    0.327 ms |                    0.267 ms |
| Script time / layouts in each idle window |                       0 / 0 |                       0 / 0 |
| Post-GC JavaScript heap                   |            37,194,072 bytes |            37,470,576 bytes |
| Growth within each idle window            |                     0 bytes |                     0 bytes |
| Documents / DOM nodes                     |                   7 / 1,879 |                   7 / 1,881 |

The additional retained heap is approximately 270 KiB. These few measurements
show no recurring idle script/layout work in this fixture; they do not establish
a speedup, worst-case latency, native memory cost, or large-document scalability.

Native reference: Mac16,13 arm64, 16 GiB, Electron 43.2.0 / Chromium 150. An
isolated checkout of this working tree passed the native engine lifecycle
smoke. The native host probe passed **16 checks** covering exact Retina PNG
size, blocked scripts/network, global admission, cancellation/recovery, separate
storage partitions, rectangle updates, visibility, DOM focus, hung guest
retirement, and zero owned windows after 60 seconds closed.

Main-process CPU consumed 0.090971 seconds over 60.003 seconds closed, about
0.152% of one core. Final process snapshots were approximately 118 MiB Browser,
61.5 MiB GPU, and 40.8 MiB Utility, with no owned guest renderer. These are
runtime-process snapshots, not the incremental memory cost of capture. The
probe does not certify product OS-keyboard integration, energy impact, GPU
allocation, arbitrary transforms, or web-client parity.

**Native restriction:** a fully hidden `WebContentsView` could not reliably
capture on this Mac. Current authored evidence uses the separately qualified
hidden capture window. Future live browser surfaces need the restrictions and
fallback described in [surface contracts](design-surface-contracts.md).

The browser-context/tool-worker experiment passed five checks; its 100 ms host
timer completed in 100.25 ms and a non-yielding worker terminated in 1.57 ms.
The inert adapter experiment passed seven lifecycle/admission checks. Neither
experiment enables arbitrary executable surface kinds or proves an OS quota.

### Cloud capture fixture

The production worker ran on this Linux VM under its dedicated nonroot UID,
with sandboxing enabled and the pinned browser. Eight checks passed: exact PNG
dimensions, denied network, no surviving worker/browser, single admission,
cancellation cleanup, recovery, and headless proposal/result evidence with
verified source hashes. The complete fixture took approximately 2.34 seconds.
The fixture's missing dependencies and temporary cloud marker were corrected
and removed before running the ordinary engine test suites.

This is **not a deployed Daytona qualification**. Hosted authentication,
worker-owned admission, disconnect/reconnect, and retention through the real
cloud lifecycle still need an existing configured workspace or test credentials.
That external gate remains open; no deployment was performed.

### Verification record

| Gate                                                                  | Result                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                      | App, Electron and all packages pass.                                                                                                                                                                                                                                                                                                                        |
| `pnpm lint`                                                           | No errors; one pre-existing `view.selectedNodeId` dependency warning, now in `design-canvas.tsx`.                                                                                                                                                                                                                                                           |
| `pnpm test:git`                                                       | 863 files / 9,182 tests pass, 29 tests skipped. The final modal shortcut guard also passes all 40 adjacent renderer files / 409 tests.                                                                                                                                                                                                                      |
| `pnpm check:design-containment`                                       | 28 files / 572 tests pass.                                                                                                                                                                                                                                                                                                                                  |
| `pnpm check:zsr:contracts`                                            | 52 files / 568 tests pass, 29 platform skips.                                                                                                                                                                                                                                                                                                               |
| Focused review browser smoke                                          | Seven final checks pass, including source/proposal review, stage/unstage/commit, capture/acceptance, failed-commit draft retention, modal keyboard isolation, and focus/shortcut restoration.                                                                                                                                                               |
| Full `pnpm test:ui-smoke`                                             | Pass: 801 checks, no uncaught page errors. The final modal guard is additionally covered by the seven-check focused run. Earlier attempts had intermittent composer, tooltip and transform failures; assertions were retained, transform failure diagnostics added, and the width test now waits for the preceding Show action's current selected geometry. |
| `pnpm build:ui`, `pnpm build:engine`                                  | Pass.                                                                                                                                                                                                                                                                                                                                                       |
| UI, preload, protocol, packaging, Electron hardening and runtime pins | Pass; existing bundle-size/runtime-pin warnings remain.                                                                                                                                                                                                                                                                                                     |
| Licenses and secrets                                                  | Pass, including the secret rules run across untracked implementation files.                                                                                                                                                                                                                                                                                 |
| `pnpm check:audit`                                                    | Pass under the repository's existing advisory exceptions (including three high advisories); no audit exceptions were added.                                                                                                                                                                                                                                 |
| Mac `pnpm build:sidecar && pnpm smoke:engine`                         | Pass on the named Mac in an isolated checkout.                                                                                                                                                                                                                                                                                                              |
| Native capture / Linux capture worker / inert adapters                | 16 / 8 / 7 checks pass, with the qualifications above.                                                                                                                                                                                                                                                                                                      |

Reproduction scripts: `scripts/design-baseline.mjs`,
`scripts/design-host-prototype.mjs`, `scripts/design-adapter-prototype.mjs`,
`scripts/design-native-qualification.ts`, and
`scripts/design-cloud-capture-qualification.ts`. Probe JSON, smoke logs, and a
review screenshot are retained in this workspace's gitignored `.context/`.
Third-party notices record the pinned Playwright runtime and the requirement to
retain the installed Chromium distribution's notices.

## Save, agent ownership, and PR workflow audit

### Saving and staging today

| Action | Durable result | Git effect |
| --- | --- | --- |
| Finish a Design edit | The engine updates source in the configured Design folder; pending field/gesture previews are local until submitted | Worktree changes only |
| Cmd/Ctrl+S | Publishes a focused field, waits for queued edits, validates the current draft | No staging or commit |
| Accept proposal | Applies the reviewed operations against their exact source revision | Worktree changes only |
| Stage Design | Snapshots the active Design folder, including manifest, rules, and applicable assets | Updates the index for that folder only |
| Commit staged Design | Creates a local commit from the reviewed staged Design snapshot | Leaves unrelated staged Code and newer unstaged Design edits alone |
| Push / Create PR after checkpointing | Publishes committed branch history | Includes committed Code and Design; excludes local drafts |

Authored source is under `<workspace>/<configured Design folder>`, not a hidden
temporary canvas database. The folder name is configurable. Private journals,
view state and bounded proposal/evidence records are under
`<Zeros app data>/design-storage/<workspace-path hash>/`; quarantined recovery
records use the adjacent `design-transaction-recovery/` directory. Stable macOS
defaults to `~/Library/Application Support/com.zeros/`; beta/dev/instance builds
have separate directories, and cloud/tests may override `ZEROS_DATA_DIR`.
Repository `.zeros/` contains private settings/compatibility state. Undo/redo
stacks are bounded in-memory state, not a promised restart-persistent history.
On cloud workspaces the engine owns the cloud worktree and app data. Autosave
acknowledgement, Git staging, local commits, and remote publication are four
different states.

Keep Cmd/Ctrl+S as save. Making it Stage All would silently replace a deliberately
staged snapshot whenever the user saves a newer draft. The explicit Stage Design
action is the correct place to checkpoint; its scope is the active Design folder,
not the entire repository or a future selected page.

### Agent policy: current implementation versus agreed v1

**Current:** admitted native sessions can read and mutate Design through scoped
semantic tools, independently of the visible view. Generic Code file/stage/
commit routes still reject Design paths. Separate Design-session creation is
retired; the wire role remains explicitly rejected for compatibility.

**Agreed next implementation:** the same conversation/provider switches between
Code and Design composer modes under user selection or explicit task authority.
Only Design mode receives Design API writes; Code can still inspect/attach
frames. Mode generation is checked at tool admission and commit, with prompt
instructions injected before the next continuation. There is no Code-write
sandbox, restricted role, or mandatory Design delegation.

Both modes will use managed Git for approved Code and Design staging, commits,
pulls, merges, pushes, and PRs. Authored Design writes remain API-only, including
metadata. Keep checkout-backed `DesignDraftStore`; no private publication copy
or separate Update Design. The [v1 plan](design-v1-implementation-plan.md)
defines mode transitions, stale calls, concurrency, conflict recovery, and
provider/host acceptance gates. These are pending changes, not current behavior.

### Files, Changes, and PR presentation

**Implemented:** Files has a Design section and read-only source notice;
Design Review has its own comparisons and explicit checkpoint controls. Both
refer to the same files. Design files must remain visible in repository-wide
counts and diffs.

**Follow-up audit, 2026-09-17:**

1. Code Changes should show a Design group/ownership badge, real staged and
   unstaged states, readable diffs, and **Review in Design**. Generic edit,
   discard and authored conflict edits should use Design API workflows; approved
   managed stage/commit actions must work in either composer mode.
   Classification must come from validated manifests/index/HEAD,
   cover old and new rename paths and deleted folders, and share the existing
   exact-key snapshot. Do not hard-code a directory name or fetch once per row.
2. Managed workspace stage/unstage/commit now deliberately supports mixed Code
   and Design snapshots. Create PR publishes existing branch commits and leaves
   dirty and staged work untouched. Its agent brief also preserves that scope.
   Design Review retains its narrower commit lane and captured-index checks.
3. Review Changes requests `gitDiff(mode: "base")`, comparing committed branch
   HEAD to the fork point. It excludes uncommitted work but may include unpushed
   commits. Pinning published PR repository/base/remote-head identity and resetting
   viewed/approval state when content changes remain follow-ups.
4. A Design PR card should offer the source diff plus optional immutable visual
   evidence for those exact revisions. A local proposal screenshot is not
   automatically evidence for the PR's remote head. Render requested revisions
   without switching the working checkout; keep captures lazy, cached by source
   and renderer identity, and within existing job/byte budgets. Private result
   bundles currently remain local; remote sharing needs an explicit artifact
   publication, access and retention contract, not a PNG commit on every edit.

### Git responsibility and conflict handling

| Operation | Intended owner and current boundary |
| --- | --- |
| Read status/history/diffs | Code and Design actors can inspect scoped context |
| Stage/commit mixed work | Managed workspace Git uses explicit scope/captured index; no implicit staging |
| Stage/commit Design | Explicit Design surface/engine checkpoint; semantic agent tools do not implicitly publish |
| Push or open a PR | One branch-wide Code/workspace workflow; publishes both kinds of committed work |
| Fetch | Ref-only operation; no Design source rewrite |
| Pull/merge/rebase/checkout | Coordinated workspace operation with Design draft and revision preflight |
| Resolve Code conflicts | Code workflow/agent |
| Resolve Design conflicts | Future Design-aware resolver or explicit human reconciliation; no generic source-marker edits |

The current integration guard rejects overlapping independently changed Design
paths before Git writes conflict markers, even when a textual merge might have
worked. It also protects live Design drafts from rewriting/autostash. This is
deliberate conservative blocking, **not implemented Design conflict resolution**.
Raw Git in a native agent shell does not participate in the engine coordinator.

A resolver needs base/ours/theirs revisions, stable identities, source and
manifest/asset validation, preview and explicit resolution. Folder renames,
delete-versus-edit, duplicate IDs, asset deletion and divergent schemas need
defined outcomes. Finish the integration through the workspace Git coordinator
after all owned files validate; a branch merge commit can contain both Code and
Design. Managed Git admission does not authorize arbitrary authored Design
edits. The same agent resolves Design through the API in Design mode; a generic
Code conflict editor must not insert markers into engine-owned Design source.

### Verification of the compact-dialog follow-up

The retained browser regression first failed on the former 960 × 720 size, then
passed for 640 × 480 and a transparent background. Focused coverage also checks
360 × 480 bounds, reachable checkpoint controls, the portaled comparison menu,
keyboard isolation, outside-click protection, focus restoration, source and
proposal review, capture, acceptance, staging and failed-commit message retention.
The adjacent Design and shared primitive suites pass: 48 files / 423 tests.
Final follow-up checks also pass: `pnpm typecheck`, `pnpm lint`, `pnpm check:ui`,
`pnpm test:git` (9,182 passed / 29 skipped), `pnpm test:ui-smoke` (805 checks),
`pnpm build:ui`, `pnpm check:secrets`, and `git diff --check`. The supplementary
secret scan includes all 4,034 tracked and non-ignored untracked files. Lint
retains the pre-existing `design-canvas.tsx` dependency warning; the UI build
retains the existing large-chunk warning. These are Linux renderer checks; the
earlier native Mac evidence and open deployed-cloud gate remain as recorded.

### Completion boundary

The implementation, local/native evidence, and report are reviewable in this
working tree. Before declaring both roadmap phases fully qualified and shipped:

1. Qualify the same implementation in a real deployed cloud workspace. Preserve
   the distinction between local durable retry and replicated cross-machine jobs.
2. Review and land the combined layout/foundation work through the normal
   repository workflow. This task does not stage or commit unrelated user work.

The workflow audit above identifies additional Code Changes/PR integration and
automatic Design conflict-resolution gaps; do not describe those as complete.
The Design tab, mixed managed Git and pause/recovery foundation are implemented;
the shared composer mode gate and provider integration still require separate
implementation and qualification beyond the Phase 1 API.

Pages, media kinds, live web/code/tool adapters, distributed scheduling, general
script execution, and scenario behavioral/a11y assertions belong to later
roadmap phases. They are not implied by this implementation.

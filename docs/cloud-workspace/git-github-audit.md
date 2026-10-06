# Cloud Computer Git and GitHub audit

Audit date: 2026-10-06. Scope: an internal Alpha v4 workspace forked from a
Cloud Computer template. Managed Fetch and Pull are fixed in PR #339; PR panel
reads (F1) are implemented in PR #342. This follow-up fixes F2–F4. Evidence is source
inspection and local tests. No live workspace, provider, credential, or
deployment was changed, and no Mac verification was performed.

## First fix: managed Fetch and Pull

Computer setup deliberately removes the GitHub credential projection and
revokes its bootstrap read token. Previously, only Push and PR mutations
requested the desktop courier. Managed Fetch and Pull reached Git without a
credential. Pull also returned through the commit-author wrapper before it
could acquire a GitHub grant.

Fetch and Pull now request the same connected-account courier as Push. The
control plane binds the exact operation and parameters, and redeems either
operation to an upload-pack-only `git.fetch` capability. Pull's strategy,
remote, and autostash choice remain covered by the request digest. The existing
database operation vocabulary is sufficient; no migration is required. The
engine composes the grant and actor-author scopes and releases the grant even
when author lookup fails. Neither scope becomes shared engine state.

Deploy the control plane before the updated desktop and worker runtime. Older
control planes reject these newly admitted managed requests. Existing native
fetch/push grants, managed push/PR grants, and Local Git retain their contracts.

## F1: repository reads without a VM credential

Fixed: `github-read-routes.ts` and `github-read-proxy.ts` in the control plane
admit only the current engine plus a live actor session with workspace **read**
capability. The repository is resolved from the accepted computer source and
its immutable repository ID and installation. No owner token, human GitHub
connection, read grant row, or schema migration is involved. The installation
credential is minted for one repository and cached only in backend memory,
keyed by installation ID and immutable repository ID. Up to 64 credentials are
retained until five minutes before expiry; concurrent mints share one request.
Eviction, expiry sweep and shutdown retire/revoke credentials after active
readers drain. Shutdown aborts pending upstream reads. Reads cannot fall
through to the mutation proxy.

`github-read-policy.ts` pins two GraphQL queries (review threads and commit
statistics) and explicitly admits repository metadata/branches, PRs/commits/
reviews/comments, PR issue comments/timeline, checks/annotations/statuses and
comparisons. No arbitrary GraphQL, contents endpoint, caller origin, write,
unknown query parameter, or pagination size is admitted. Responses are bounded
to 8 MiB; upstream error text and headers never reach the worker. Repository
identity is independently checked on first use and cached for 60 seconds
per installation/repository ID and exact repository name; concurrent identity
checks share one request. Identity cache size is bounded to 256 entries.

The backend caches successful responses for 5 seconds, revalidates ETags for up
to 5 minutes, coalesces identical reads, and rechecks authority even on cache
hits and after upstream I/O. Limits per process: 240 requests/workspace/minute,
1,000 active workspace budgets, 64 concurrent upstream operations, 256 cache
entries/32 MiB. Review diff revision guards force revalidation. Budgets and
cache are in memory and reset on control-plane restart; they are not a global
multi-replica quota.

The v4 engine injects an actor-scoped Octokit fetch transport, without touching
its token store. Local/v3 behavior and per-user courier writes are unchanged.
Prompters/viewers can discover and read PRs. Resolve/reopen UI hints come from
the actor's workspace role rather than the installation's read-only viewer;
the existing exact-user write grant remains authoritative for each action.

GitHub accepts PR-read permission for [issue comments](https://docs.github.com/en/rest/issues/comments)
and [timeline events](https://docs.github.com/en/rest/issues/timeline), so the
new mint requests the existing contents/pull_requests/checks/statuses **read**
permissions and does not require an additional Issues permission.

Deploy the control plane before the new worker. Older backends fail closed;
no credential fallback is introduced. Real Alpha installation and Mac checks
below remain pending.

## F2: accepted source and durable target metadata

Fixed: the control plane resolves the requested commit plus its named source,
repository default target, or exact PR head/base/number. PR responses must match
the bound repository and the already accepted head SHA; a moving head is refused
so a retry obtains one coherent source. A named branch uses its single matching
open PR's base when known; ambiguous multiple PRs retain the repository default.
Default-branch creates use the same `allocateWorkspaceBranch` as Local. Named
branches retain their names; PR creates check out the PR head branch and link
its number, URL, draft/ready/closed/merged state, and named base. Commit/tag
sources use a generated branch with the repository default target. Targets are
never commit IDs.

Local references: `apps/desktop/src/engine/git/worktree.ts:394` resolves the
named default base, `worktree.ts:1119` allocates the workspace branch (including
configured prefix/collision rules), and `worktree.ts:1547` uses that allocator.
`git/cross-tool.ts:580,632` adopts a named branch and retains supplied PR
identity. Local adoption can fall back to a configured base or `main`; the
approved Cloud policy explicitly uses GitHub's verified default/PR base.

Migration `0132_cloud_workspace_checkout_source.sql` adds a nullable JSON column
to the immutable accepted source. Generation copies retain it. The upgraded
setup helper requests `checkoutSourceVersion: 1`; old helpers keep their exact
existing material shape. New helpers validate it and write only secret-free
metadata to `zeros.cloud-source` in Git config. Engine registration validates
that metadata and persists the workspace row. A matching existing row with a
named target wins on restart, preserving edits, index, user-selected target
and PR state. A legacy SHA/empty target is repaired from accepted/named Git
metadata without moving HEAD, touching edits, or replacing the saved row.

Roll out the additive migration/control plane before the new qualified worker.
Existing template/runtime pins need an explicit upgrade or rebuilt template to
receive the new helper; updating the backend alone cannot change old worker
code. Legacy source rows remain null (no backfill or history rewrite). Their
first registration uses a named Git default/fetched branch, and fails clearly
if no named target can be recovered instead of storing a SHA.

## F3: exact-actor device fallback

Fixed: `git/github-native-desktop.ts` tries at most four distinct eligible,
ready devices of the exact actor, sequentially, only after a null grant reply.
All attempts share the original 15-second deadline. Duplicate connections do
not consume additional device slots. Replies stay bound to the selected
connection/session; late replies, another actor, cancel, reconfiguration and
expired authority cannot supply a grant. Only one selected grant is returned;
GitHub writes are never replayed automatically. No eligible desktop retains the
existing clear open-the-app error.

## F4: full source/target history with bounded fallback

Fixed: `cloud-computer-checkout.mjs` fetches the accepted commit and named target
ref without a depth limit, unshallowing a cached template when needed. The
source branch's tracking ref is refreshed from the accepted SHA. A full fetch
has a 60-second budget and a 256 MiB object-growth budget checked every 250 ms;
Git receives TERM, then KILL after two seconds if needed. Only a budget limit
permits a depth-128 retry, subject to the same budget. Authentication and other
fetch errors fail directly. Exhausting the fallback reports the closed
`setup_repository_history_limit` diagnostic. Polling can overshoot the byte budget by one sample;
the two attempts can together add up to twice the per-attempt budget. This is
an internal Alpha guard, not an exact network-byte or total-disk quota.

The actual Git shallow flag is returned in cloud `git.status`. Changes and
Review publish “Shallow Git history — older commits and comparisons may be
incomplete.” into their single `WorkbenchTabFrame` banner slot. This neutral
notice has lower priority than availability or load failures and never blocks
content. It retains the exact-workspace snapshot during refresh/failure;
hidden/local surfaces make no new notice reads.

The explicit **Fetch full history** action runs managed `git.fetch` with
`unshallow: true` included in the courier grant's request digest. It preserves
the source/target refs, unpublished HEAD and worktree, and uses the same
60-second / 256 MiB object-growth guard and TERM/KILL cleanup. The renderer
allows 90 seconds for the guard, cleanup and request overhead; ordinary Local
fetch retains its existing 60-second request/command budget. Changes and Review
share a bounded flight per workspace. A guard limit keeps the notice and adds
“Fetch stopped at the 60-second or 256 MiB limit.”; other action failures use a
closed toast. No automatic retry/depth fallback is initiated by this action.
Only a confirmed non-shallow `git.status` clears the notice. Target selection
still performs no automatic fetch.

Local verification includes a real depth-1 template with divergent source and
target branches: setup restores all eight commits and the correct merge-base.
Time/size limits, bounded fallback, process cancellation, non-limit failures,
status refresh, and UI workspace-switch races have regression coverage.

Measurement (2026-10-06): anonymous read-only fetches of
[Express](https://github.com/expressjs/express), default `master`, 6,173 commits.
Three alternating pairs started from copies of one cached depth-1 template on
this Amazon Linux VM. Fetch-only medians: **0.139 s** at depth 1, **1.499 s** for
full history (**+1.360 s**, **10,779,219 bytes / 10.28 MiB** additional objects).
Full-fetch samples were 1.499/1.726/1.478 s. Template cloning, provider startup,
and hooks were excluded; this is not a Boat end-to-end latency measurement.
No provider resource was created; all local measurement clones were deleted.

## Use-case audit

“Covered” means the implementation has local automated coverage; it does not
mean the exact Alpha runtime, GitHub installation, or Mac has been qualified.
Line numbers refer to the audited source and may move in later fixes.

| Use case | Status | Evidence | Fix or remaining action |
| --- | --- | --- | --- |
| Org Cloud Computer installation and repository grants | Covered | `apps/control-plane/src/cloud-workspaces/computer-workspace-source.ts`; `computer-template-worker.ts:532`; `github-user-access.ts:193` | Repository identity, installation, and current member access are checked. Owner must qualify the real installation. |
| Cloud Computer clone askpass | Covered | `scripts/cloud-workspace-validation/runtime-base-v4/computer-build.py:358,509`; `computer-git-askpass.py:12` | Root-owned socket and peer checks; token is passed through the socket, outside Git argv/config. |
| No persisted GitHub token in the v4 VM | Covered | `scripts/cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs:2639,2719,2732`; `cloud-computer-checkout.mjs:243` | Computer setup revokes its read token and omits/removes the credential projection. Native and managed operations use memory-only proxy capabilities. |
| Member's connected GitHub account on the Mac | Covered, live pending | `apps/desktop/electron/cloud-github-client.ts:36`; `apps/control-plane/src/github.ts:1372` | Courier verifies account/session ownership and user repository permission; GitHub bearer stays outside the VM. Each member needs their own connection to the selected installation. |
| Create from main or a named remote branch | F2 fixed; Alpha pending | `github-repositories.test.ts`; `routes.integration.test.ts`; `cloud-primary-workspace.test.ts` | Main/default creates a generated workspace branch and named default target. Named sources keep their branch and use the default or verified PR base. |
| Create from PR or pinned commit | F2 fixed; Alpha pending | `github-repositories.ts`; `cloud-computer-checkout.test.ts`; `cloud-primary-workspace.test.ts` | PR head is checked out; number/head/base/state are linked. Pinned commits use a generated branch and the named default target. |
| Checkout and branch naming | F2 fixed | `cloud-primary-workspace.ts`; `worktree.ts:1119`; `cloud-primary-workspace.test.ts` | Use the Local branch allocator for default/commit sources; preserve adopted head names and durable selections on restart. |
| Target picker | Covered | `apps/desktop/src/engine/git/ops.ts:1134`; `git/__tests__/ops.test.ts:1127` | Default changes metadata only. Rebase/autostash require explicit options; preserved by this fix. |
| Managed Fetch and explicit full-history recovery | Fixed in #339; guarded history action fixed in F4 | `github-write-grants.integration.test.ts`; `cloud-managed-git.test.ts`; `cloud-history-fetch.integration.test.ts`; `cloud-history-notice.test.ts` | Obtain a desktop grant, bind `unshallow` in the digest, redeem upload-pack authority, release after the operation. One neutral tab banner offers the bounded, single-flight action; non-shallow status clears it. |
| Managed Pull, merge/rebase strategies, autostash | Authentication fixed in #339; integration covered | Same grant tests; `apps/desktop/src/engine/zeros-engine.ts` (`handleWithAuthor`); `git/ops.ts:829`; `git/__tests__/ops.test.ts:733` | Compose commit identity with fetch authority. Existing explicit strategy, stale-HEAD checks, Design guards and conflict results remain in force. |
| Explicit local rebase/merge; Continue/Abort | Covered; F4 full ancestry fixed | `git/ops.ts:904,1188`; `git/__tests__/advanced-git-operations.test.ts`; `scripts/__tests__/cloud-computer-checkout.test.ts` | Explicit history operations keep their existing conflict/Design guards. Full source/target history supplies the merge-base; guarded fallback is visibly shallow. |
| Conflicts and Design canvas | Covered at engine boundary; Mac pending | `apps/desktop/src/engine/design/checkout-status.ts:6`; `workspace/service.ts:2070,2660`; `workspace/__tests__/design-workbench.test.ts:302` | Conflicted checkout is refused before manifest parsing. Verify pause, shared file resolution, Continue/Abort, and recovery in the cloud canvas. |
| Changes: status/diff/log and four comparisons | Covered; F2/F4 baseline fixes in place | `git/diff.ts`; `git/__tests__/diff.test.ts`; `cloud-computer-checkout.test.ts` | All four comparisons remain independent; AD is 0/0/1/1. Named targets and full ancestry restore the intended All comparison; shallow fallback has a notice. |
| Review hunks, stage/unstage, discard | Covered | `apps/desktop/src/engine/git/review-actions.ts`; `git/__tests__/review-actions.test.ts`; `git/__tests__/advanced-git-operations.test.ts:351,665` | Existing live-hunk/stale-content checks and explicit discard semantics. Cloud role and file boundaries still apply. |
| Human and agent commit attribution | Covered | `apps/desktop/src/engine/git/cloud-git-author.ts:13`; `git/__tests__/cloud-git-author.test.ts`; `git/__tests__/cloud-git-identity.test.ts` | Actor-specific process/scoped environment; no shared Git identity configuration. Pull now preserves this scope alongside network authority. |
| Push, first upstream, force push | Covered, live pending | `apps/desktop/src/engine/git/ops.ts:764`; `git/__tests__/github-write-transport.test.ts`; `apps/control-plane/src/cloud-workspaces/github-write-git.test.ts` | Managed push uses `-u` by default and `--force-with-lease` only when requested. Proxy admits one current branch, rejects deletion/tags/multiple refs, and preserves GitHub branch protection. |
| Create PR | F2 default target fixed; grant path covered | `cloud-primary-workspace.test.ts`; `git/github-write-publication.ts`; `github-write-proxy.test.ts` | Default creates now have a distinct generated head and a named target. Per-user push/Create PR attribution and policy are preserved. |
| PR status, checks, commits, comments/timeline, inline review, sync | F1 fixed; Alpha verification pending | `apps/control-plane/src/cloud-workspaces/github-read.integration.test.ts`; `github-read-policy.test.ts`; `apps/desktop/src/engine/git/__tests__/github-cloud-read.test.ts` | Backend-only installation reads with exact actor/repository scope, bounded cache/rate limits, and explicit REST/GraphQL policy. |
| Comment, mark ready, merge PR | Mutation paths covered; F1 panel fix in place | `apps/desktop/src/engine/workspace/service.ts:4816,4828,4849`; `apps/control-plane/src/cloud-workspaces/github-review-policy.ts`; `github-write-proxy.test.ts` | Exact PR/body and GraphQL node policy is unchanged; the panel can now load through the separate read transport. |
| Agent-native commit/push/fetch | Covered, real agent turn pending | `apps/desktop/src/engine/git/github-native-broker.ts:68`; `github-native-client.ts:51`; `git/__tests__/github-native-http.test.ts` | Native source/lease and branch are checked. Agents use Git, not cloud `gh` API credentials. |
| Prompter/developer/manager/owner; org member vs owner | Covered at authorization boundary | `apps/desktop/src/engine/cloud-actor-policy.ts:48`; `apps/control-plane/src/cloud-workspaces/github-native-grants.integration.test.ts:260`; `github-write-grants.ts:102` | Prompters/viewers cannot provide native Git authority or mutate checkout. Developers/managers/owners still require their own admitted actor and GitHub access. |
| Expiry/revocation mid-operation | Covered, no automatic write replay | `apps/desktop/src/engine/git/github-write-context.ts:37`; `github-native-broker.ts:75,85`; `apps/control-plane/src/cloud-workspaces/github-write-grants.ts:204`; `github-native-grants.integration.test.ts:235` | Expiry, connection revision, actor and engine are rechecked. Retry explicitly obtains new authority. |
| Mac closed | Clear failure contract covered | `apps/desktop/src/engine/git/github-native-desktop.ts:31`; `git/__tests__/github-native-desktop.test.ts:22` | Native network Git fails with “Open Zeros to authorize GitHub push for this cloud workspace”; local agent work does not require this courier. Autonomous GitHub writes while every desktop is closed are not implemented. |
| Second device, same actor | F3 fixed | `git/github-native-desktop.ts`; `git/__tests__/github-native-desktop.test.ts` | Null grants try the next exact-actor device within one four-device/15-second budget. Connection/session binding, cancel/expiry and one selected grant are preserved. |
| Another member using a terminal | Covered | `apps/desktop/src/engine/git/github-native-terminal.ts:38` | Another member's input permanently disables the creator's Git authority in that shell; open a new shell to acquire the new actor's authority. |
| Archived/stopped history | Transcript history covered; Git/PR reads require a running engine | `apps/desktop/src/renderer/platform/bridge/workspace-runtime-client.ts:692` | Only chats/message windows/search use the control-plane history path. Git status/log/diff are not durable offline history endpoints. Offline Git/PR snapshots are explicitly out of scope; show the standard tab banner from #334. |

## GH workstream status and remaining verification

F1–F4 are fixed with local regression coverage. Remaining work is the exact
Alpha/Mac qualification below, including real owner-run Codex/Claude turns,
installation permissions, conflicts and attribution. Offline Git/PR snapshots
remain out of scope; stopped/archived workspaces use #334's standard banner.
Native writes still require an admitted desktop of the exact actor. No changes
extend write authority beyond the workspace's bound repository (including when
reading/checking out a PR whose head originated in a fork).

## Local workspace impact (F2–F4)

No intentional Local behavior change. Cloud setup scripts and control-plane
admission only execute for cloud allocations. Shared production paths are gated
as follows; their regression tests remain in the repository.

| Shared file | Cloud gate and Local regression |
| --- | --- |
| `apps/desktop/src/engine/git/cloud-primary-workspace.ts` | Startup calls this only under `cloudWorker && cloudRuntimeConfig` (`zeros-engine.ts`). A Local row is rejected unchanged; `cloud-primary-workspace.test.ts` checks row and HEAD preservation. The existing Local branch allocator is reused without editing it. |
| `apps/desktop/src/engine/git/github-native-desktop.ts` | Eligibility requires `client.kind === "cloud"`; `github-native-desktop.test.ts` retains the Local-client refusal/cancel case. Local credentials never enter device fallback. |
| `apps/desktop/src/engine/git/diff.ts` | The shallow probe/field require `ws.placement === "cloud"`; `diff.test.ts` checks the complete unchanged Local status shape and retains Local comparison tests. |
| `apps/desktop/src/engine/git/fetch.ts` | Full-history path requires explicit `unshallow` and cloud placement; `fetch.test.ts` refuses it on Local and checks unchanged ordinary Local Git args/result/timeout. |
| `apps/desktop/src/engine/git/cloud-history-fetch.ts` | New helper is called only by the cloud-only path above. `fetch.test.ts` proves ordinary Local fetch does not enter it; guard and real ancestry tests cover cloud recovery. |
| `apps/desktop/src/engine/git/git-exec.ts` | Group cancellation/detachment is opt-in, used only by cloud history recovery. `git-exec.test.ts` retains default Local Node/Bun arguments, timeout and abort behavior and tests cloud TERM/KILL. |
| `apps/desktop/src/engine/workspace/service.ts` | Forwards the optional flag; the Git handler refuses it on Local. `service.test.ts` checks ordinary Local fetch options/result and the explicit option. |
| `apps/desktop/src/renderer/platform/git.ts` | Optional shallow status and additive fetch facade; only the cloud banner requests unshallow. `engine-read-availability.test.ts` checks exact unchanged Local status/fetch requests and responses. |
| `apps/desktop/src/renderer/platform/bridge/workspace-bridge.ts` | Includes `unshallow` only when specified, with a longer budget only for that request. Platform and bridge tests retain ordinary Local payloads and 60-second timeouts. |
| `apps/desktop/src/renderer/shell/pr/cloud-history-notice.tsx` | Only cloud workspace IDs receive a cache/read/action key; `cloud-history-notice.test.ts` verifies no Local/hidden reads or actions plus exact-key/race/single-flight behavior. |
| `apps/desktop/src/renderer/shell/workbench/tab-content.tsx` | Mounts the publisher only for cloud Changes/Review. `tab-status-contract.test.ts` checks no Local publisher mount and one banner for every tab. |
| `apps/desktop/src/renderer/shell/workbench/tab-status-model.ts` | Optional notice has only the cloud publisher. `tab-status.test.ts` keeps existing failure/retry semantics for sources without notices; failure always wins. |
| `apps/desktop/src/renderer/shell/workbench/tab-status.tsx` | Uses the existing slot for the optional cloud notice; tabs without one retain original availability/failure/recovery behavior. `tab-notice.test.ts` and existing tab contract tests verify this Local path, priorities and one banner. |
| `packages/protocol/src/cloud-computer-v2.ts` | Adds a separate cloud-only metadata schema, without changing existing messages; `cloud-computer-v2.test.ts` checks unchanged Local create/status message round trips without checkout metadata and existing cloud schema parity. |

The changed tests under these engine/renderer/protocol paths add or maintain
the above assertions; they do not run in the product. The PR header's original
implementation is preserved; its Local target/Create PR and exclusive PR island
tests remain. No Design implementation or Local creation, Git credential,
target-picker mutation, or courier path was changed. The setup runtime tests
retain the exact v1–v3 request contract.

## Cloud workspace impact (F2–F4)

Only cloud primary checkouts acquire the accepted source/target metadata and
guarded history behavior. The notice action uses existing actor-bound courier
authority; tokens are not persisted in the VM, and the new option cannot be
added, removed or altered under an already prepared digest. Existing read and
write role boundaries remain in effect. A disconnected/stopped/archived tab or
a failed load displays its existing higher-priority banner, never a second
strip. The button is disabled while its fetch is running or its tab is hidden.

## Exact owner verification checklist

Use a disposable Alpha test repository and workspace provisioned by the
orchestrator's approved runbook. Name new test resources `zeros-v2-test-*` where
supported. Record workspace/generation/runtime, repository and branch, PR, and
any provider resource IDs in the private verification record. Do not use an
existing owner's workspace or credentials as the test fixture. No real values
belong in public logs or PR text.

1. Roll out the backend, worker runtime, and desktop containing the fix. Sign
   into Zeros and connect the test member's GitHub account and selected org
   installation on the Mac. Open the fixture workspace and confirm Files and
   terminal show the VM checkout.
2. Create separate test workspaces from the repository default branch, a named
   branch with no PR, a named branch with one open PR, and a PR. Verify the
   default creates a new generated branch with the default target; the named
   source retains its branch and uses the default/known PR base; the PR keeps
   its head branch, number, URL and base. No target may be a SHA. Record only
   `git branch --show-current`, `git rev-parse --is-shallow-repository`, and the
   named refs/merge-base needed for the comparison. A normal checkout must be
   non-shallow and show older commits. Restart/stop-resume and verify branch,
   target, PR linkage and staged/unstaged edits survive. In the scripted local
   guard fixture, confirm the depth-128 fallback shows exactly one neutral
   shallow-history banner in Changes and Review. Click **Fetch full history**;
   confirm **Fetching…**/disabled state, no duplicate fetch when switching tabs,
   unchanged HEAD/index/edits, and clearing only after status is non-shallow.
   Exercise the scripted limit fixture: the notice must remain and say the
   60-second or 256 MiB limit was reached. A connection/load failure must replace
   this notice in the same slot; recovery may reveal it again. Local Changes
   and Review must retain their original controls and never show this notice.
   Never dump environments, process arguments or credential files.
3. Select a test branch and a real named target. Before changing the target,
   record HEAD, index contents and a worktree edit; change the target alone and
   verify all three stay unchanged.
4. Make one tracked edit, one staged edit, one untracked file, and an `AD` file
   (stage a new file, then remove it from disk). Verify All/Uncommitted/Staged/
   Unstaged lists and badge; the `AD` contribution must be `0/0/1/1`.
5. Use managed Fetch after the approved test fixture has advanced the remote.
   Expect remote refs to refresh without changing HEAD, index, or worktree.
   Use managed Pull with explicit rebase, then a separate fixture with merge.
   Verify expected commits and the actor's GitHub noreply author on any new
   merge/stash commit. Repeat with autostash and a dirty Code file; verify the
   edit returns.
6. Use a prepared conflict fixture. Confirm conflict files are listed, the
   Design canvas pauses, and unrelated draft data remains intact. Resolve in
   shared Files, stage explicitly, Continue, then retry Design. Repeat using
   Abort and confirm the original checkout/draft.
7. Commit from Changes, perform a first Push, and verify the upstream on GitHub
   under the member's identity. Exercise an explicitly requested force push
   only on the disposable branch; arrange a competing remote update and verify
   force-with-lease refuses it until the expected tip is refreshed.
8. Attempt Create PR with a distinct head and named target, then PR reads,
   checks/timeline, a comment, Mark ready and Merge on disposable PRs. Confirm PR summary, checks/statuses, commit stats, reviews, comments, inline
   threads, annotations and Review diff load with no VM token. Resolve/reopen
   a thread through the human courier. Record each result separately.
9. Ask Codex and Claude separately to commit a harmless test file and push the
   disposable branch using Git. Verify author and remote commit independently.
   Ask for a fetch/push after closing all desktops: expect the documented clear
   authorization failure. Reopen and retry explicitly; verify there is no
   automatic duplicate push.
10. Repeat from a second signed-in device and with both attached. Test a first
    attached device without usable GitHub and a second with it; the second must
    authorize after the first declines. Close/cancel during fallback and ensure
    late replies cannot authorize another operation; the 15-second budget must
    not restart for the next device.
    Confirm prompter/viewer PR reads succeed without a GitHub connection, while
    writes are refused; developer/manager/owner writes require each person's
    own connection. Change/revoke the actor while a read is pending and again
    within the cache TTL; access must fail. Verify another repository and an
    unlisted API/query shape are refused by the backend. Another member typing in an existing shell must
    require a new terminal for Git authority.
11. Disconnect GitHub or retire the actor admission while a grant is pending;
    verify the operation fails and an explicit retry requires fresh authority.
    Stop/archive the disposable workspace and verify transcript history stays
    readable; record the separate running-engine requirement for Git/PR reads.
12. The orchestrator cleans up every test workspace/provider allocation and
    remote test branch/PR through the approved runbook. Native branch deletion
    is intentionally denied. Confirm cleanup by resource ID before signing off.

The existing optional native-Git qualification in
`agent-authentication-and-language-tools.md` is additional coverage, not a
replacement for the managed Fetch/Pull and PR-panel checks above. Its temporary
remote refs require administrator cleanup. Do not run it implicitly.

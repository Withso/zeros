# Cloud Computer Git and GitHub audit

Audit date: 2026-10-06. Scope: an internal Alpha v4 workspace forked from a
Cloud Computer template. This first fix restores managed Fetch and Pull;
end-to-end parity remains blocked by the follow-ups below. Evidence is source
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
| Create from main or a named remote branch | Checkout covered; metadata gap | `scripts/cloud-workspace-validation/sandbox/cloud-computer-checkout.mjs:272`; `apps/desktop/src/engine/git/cloud-primary-workspace.ts:40` | Setup fetches the accepted SHA and checks out the requested branch, but registration derives the target from a branch-shaped `FETCH_HEAD`. A SHA fetch produces a commit-valued target instead. F2. |
| Create from PR or pinned commit | Checkout covered; PR context gap | `cloud-computer-checkout.mjs:273`; `cloud-primary-workspace.ts:49,53,85` in the directories above | Detached input gets a `zeros/cloud-<workspaceId>` branch and a SHA baseline. Source PR number/head/base are not restored into the workspace row. F2. |
| Checkout and branch naming | Existing behavior confirmed | `cloud-computer-checkout.mjs:273`; `cloud-primary-workspace.ts:53`; `apps/desktop/src/engine/git/ops.ts:747` | Named sources retain their branch; detached sources get a generated branch. Push reads current HEAD instead of stale row metadata. Whether main should always fork a fresh branch needs an explicit product decision. |
| Target picker | Covered | `apps/desktop/src/engine/git/ops.ts:1134`; `git/__tests__/ops.test.ts:1127` | Default changes metadata only. Rebase/autostash require explicit options; preserved by this fix. |
| Managed Fetch | Fixed here | `packages/protocol/src/github-auth.ts:298`; `apps/control-plane/src/cloud-workspaces/github-write-grants.ts`; `apps/desktop/src/engine/__tests__/cloud-managed-git.test.ts` | Obtain a desktop grant, redeem upload-pack authority, release it after the operation. |
| Managed Pull, merge/rebase strategies, autostash | Authentication fixed here; integration covered | Same grant tests; `apps/desktop/src/engine/zeros-engine.ts` (`handleWithAuthor`); `git/ops.ts:829`; `git/__tests__/ops.test.ts:733` | Compose commit identity with fetch authority. Existing explicit strategy, stale-HEAD checks, Design guards and conflict results remain in force. |
| Explicit local rebase/merge; Continue/Abort | Covered | `apps/desktop/src/engine/git/ops.ts:904,1188`; `git/__tests__/advanced-git-operations.test.ts` | Operate on available refs; fetching remote refs is a separate operation. Qualify shallow-history behavior on the actual template. |
| Conflicts and Design canvas | Covered at engine boundary; Mac pending | `apps/desktop/src/engine/design/checkout-status.ts:6`; `workspace/service.ts:2070,2660`; `workspace/__tests__/design-workbench.test.ts:302` | Conflicted checkout is refused before manifest parsing. Verify pause, shared file resolution, Continue/Abort, and recovery in the cloud canvas. |
| Changes: status/diff/log and four comparisons | Covered, baseline caveat F2 | `apps/desktop/src/engine/workspace/service.ts:4372`; `git/diff.ts:290`; `git/__tests__/diff.test.ts` | Independent comparisons define All/Uncommitted/Staged/Unstaged. `AD` remains `0/0/1/1`; All drives the badge. |
| Review hunks, stage/unstage, discard | Covered | `apps/desktop/src/engine/git/review-actions.ts`; `git/__tests__/review-actions.test.ts`; `git/__tests__/advanced-git-operations.test.ts:351,665` | Existing live-hunk/stale-content checks and explicit discard semantics. Cloud role and file boundaries still apply. |
| Human and agent commit attribution | Covered | `apps/desktop/src/engine/git/cloud-git-author.ts:13`; `git/__tests__/cloud-git-author.test.ts`; `git/__tests__/cloud-git-identity.test.ts` | Actor-specific process/scoped environment; no shared Git identity configuration. Pull now preserves this scope alongside network authority. |
| Push, first upstream, force push | Covered, live pending | `apps/desktop/src/engine/git/ops.ts:764`; `git/__tests__/github-write-transport.test.ts`; `apps/control-plane/src/cloud-workspaces/github-write-git.test.ts` | Managed push uses `-u` by default and `--force-with-lease` only when requested. Proxy admits one current branch, rejects deletion/tags/multiple refs, and preserves GitHub branch protection. |
| Create PR | Grant/write path covered; default target blocked by F2 | `apps/desktop/src/engine/workspace/service.ts:4785`; `git/github-write-publication.ts:6`; `apps/control-plane/src/cloud-workspaces/github-write-proxy.ts:17` | Push then create under the exact request grant. A SHA target is unsuitable as the PR base; select a real target and a distinct publication branch until F2 is resolved. |
| PR status, checks, commits, comments/timeline, inline review, sync | Confirmed v4 gap F1 | `apps/desktop/src/engine/git/github.ts:528`; `apps/desktop/src/renderer/platform/bridge/workspace-runtime-client.ts:705`; `apps/control-plane/src/cloud-workspaces/github-write-proxy.ts:17` | Read calls still require the absent VM token; the courier/proxy only covers mutation-specific API requests. Need a separately reviewed read-authority path. |
| Comment, mark ready, merge PR | Mutation paths covered; panel blocked by F1 | `apps/desktop/src/engine/workspace/service.ts:4816,4828,4849`; `apps/control-plane/src/cloud-workspaces/github-review-policy.ts`; `github-write-proxy.test.ts` | Exact PR/body and GraphQL node policy exists, but a working write endpoint does not make the PR panel usable without authenticated reads. |
| Agent-native commit/push/fetch | Covered, real agent turn pending | `apps/desktop/src/engine/git/github-native-broker.ts:68`; `github-native-client.ts:51`; `git/__tests__/github-native-http.test.ts` | Native source/lease and branch are checked. Agents use Git, not cloud `gh` API credentials. |
| Prompter/developer/manager/owner; org member vs owner | Covered at authorization boundary | `apps/desktop/src/engine/cloud-actor-policy.ts:48`; `apps/control-plane/src/cloud-workspaces/github-native-grants.integration.test.ts:260`; `github-write-grants.ts:102` | Prompters/viewers cannot provide native Git authority or mutate checkout. Developers/managers/owners still require their own admitted actor and GitHub access. |
| Expiry/revocation mid-operation | Covered, no automatic write replay | `apps/desktop/src/engine/git/github-write-context.ts:37`; `github-native-broker.ts:75,85`; `apps/control-plane/src/cloud-workspaces/github-write-grants.ts:204`; `github-native-grants.integration.test.ts:235` | Expiry, connection revision, actor and engine are rechecked. Retry explicitly obtains new authority. |
| Mac closed | Clear failure contract covered | `apps/desktop/src/engine/git/github-native-desktop.ts:31`; `git/__tests__/github-native-desktop.test.ts:22` | Native network Git fails with “Open Zeros to authorize GitHub push for this cloud workspace”; local agent work does not require this courier. Autonomous GitHub writes while every desktop is closed are not implemented. |
| Second device, same actor | Single eligible device covered; selection gap F3 | `apps/desktop/src/engine/git/github-native-desktop.ts:32`; `github-native-terminal.ts:32` | Router chooses the first ready client. A null reply from a device without usable GitHub prevents trying another admitted device. |
| Another member using a terminal | Covered | `apps/desktop/src/engine/git/github-native-terminal.ts:38` | Another member's input permanently disables the creator's Git authority in that shell; open a new shell to acquire the new actor's authority. |
| Archived/stopped history | Transcript history covered; Git/PR reads require a running engine | `apps/desktop/src/renderer/platform/bridge/workspace-runtime-client.ts:692` | Only chats/message windows/search use the control-plane history path. Git status/log/diff are not durable offline history endpoints. Clarify whether offline Git snapshots are required. |

## Remaining GH workstream findings

- **F1 — authenticated PR reads:** add exact repository/PR read authority without
  restoring a persisted VM token, borrowing the owner's identity, granting
  arbitrary GraphQL, or giving native processes API authority. Decide how this
  should serve prompters/viewers as well as developers. The current database
  operation CHECK admits only the existing Git/PR-write names. Extending it
  needs an agreed additive design: replacing a CHECK uses `DROP CONSTRAINT`,
  which the repository's expand-migration lint currently rejects. Do not bypass
  that gate or disguise a PR read as a write grant.
- **F2 — source/target metadata:** carry the accepted named source and PR
  head/base/number into primary-workspace registration. Reconcile that with the
  requirement to preserve durable selections on restart, stale template refs,
  and the desired branch policy when starting from main. Local reproduction:
  named `main` + SHA-shaped `FETCH_HEAD` produces `branch=main` and
  `baseBranch=<commit>`. No arbitrary target or branch rename is chosen here.
- **F3 — multiple desktop couriers:** allow bounded fallback among eligible
  devices of the exact actor when preparation returns no grant. Preserve reply
  binding, cancellation, expiry, and a single selected grant. Local reproduction
  with two ready same-actor clients: first replies null, operation rejects, and
  the second receives zero requests.
- **F4 — depth-limited checkout:** setup fetches with `--depth=1`. Full historical
  log, merge-base comparisons against other targets, and nontrivial rebases need
  explicit shallow-history qualification/deepening policy. This is a source
  finding, not a claimed live failure.

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
2. In the VM terminal record only `git branch --show-current`,
   `git symbolic-ref --short refs/remotes/origin/HEAD` when available, and
   `git rev-parse --is-shallow-repository`. Check the UI target. Record F2/F4
   instead of silently repairing the fixture and calling default creation a
   pass. Never dump environment variables, process arguments, or credential files.
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
   checks/timeline, a comment, Mark ready and Merge on disposable PRs. F1 blocks
   a full panel pass on the audited version. Record each result separately.
9. Ask Codex and Claude separately to commit a harmless test file and push the
   disposable branch using Git. Verify author and remote commit independently.
   Ask for a fetch/push after closing all desktops: expect the documented clear
   authorization failure. Reopen and retry explicitly; verify there is no
   automatic duplicate push.
10. Repeat from a second signed-in device and with both attached. Test a first
    attached device without usable GitHub and a second with it; record F3.
    Exercise prompter refusal and developer/manager/owner success with each
    person's own connection. Another member typing in an existing shell must
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

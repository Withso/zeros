# GitHub inline review

Files, Changes and Review share one bounded GitHub discussion snapshot per
workspace and pull request. GitHub review threads preserve their original human
or bot author, old/new side, inclusive line range, replies and resolution state.
CI check-run annotations appear as read-only findings with their source,
severity and source link. This includes review integrations that publish GitHub
review comments and tools that publish check annotations; it does not infer
findings from a check's log output.

## Comment destinations

A new comment in Files or a working-tree diff belongs to the workspace. The
published pull-request diff additionally offers an explicit **Post to PR**
destination. Replies and Resolve/Reopen act on the discussion's original owner.
Check annotations have no reply or resolution action. A workspace comment is
never silently copied to GitHub or attributed to an integration.

Review's Changes section reads GitHub's published patch. Its base and head
commits must match the discussion snapshot before public posting is enabled.
The engine rechecks both commits before posting; the cloud proxy independently
performs the same preflight. A base/head change during patch or paginated-thread
loading rejects that inconsistent read and retains the last confirmed snapshot.
An open public draft captures an opaque revision covering its workspace, PR,
base and head. A changed base or replacement PR cannot reuse that selection,
even when the head stays the same; the draft remains available with posting
disabled until the reviewer selects the current code again.
Old-side comments on renamed paths translate to GitHub's current filename while
preserving their old-side line coordinates. The GitHub adapter performs that
translation once so chained renames cannot redirect a comment to another file.

Files and local diffs show a GitHub comment inline only when its original source
context still matches the selected lines. A confirmed published diff can also
verify its GitHub-provided coordinates. Outdated or unavailable ranges remain
readable in the viewer footer with their original code when available. A line
number alone never moves a discussion onto unrelated edited source.

## Transport and authority

The additive workspace reads are `gh.prInlineReview` and `gh.prReviewDiff`.
The established `gh.prComment` write operation accepts explicit `line`, `reply`
and `resolve` variants. Omitting `kind` preserves its existing PR conversation
comment behavior. Shared input schemas live in
`packages/protocol/src/github-review.ts`.

Inline review is available for Local Personal and organization-local workspaces.
Cloud v2 does not serve these reads or writes; the renderer uses the same
placement capability as workspace comments and exposes no cloud comment
controls. Imported authors are display metadata, never authority to act as that
author; Local writes use the authenticated viewer's GitHub identity.

## Repository transfers and renames

Local PR discovery and Review resolve the same canonical GitHub repository
before validating returned PR URLs. The selected GitHub connection supplies
the credential. GitHub App access still requires both the connected user's
access and the App's repository grant. A successful discovery must be followed
through `gh.prGet` in regression tests; finding a PR does not prove Review opens.

When the desktop regains focus or reconnects, an explicit
`project.reconcileGithubRemote` maintenance operation can repair a registered
Local repository's Origin and configured `git.remote`. SQLite retains GitHub's
numeric repository ID and node ID per exact remote URL; later observations use
the ID so reusing a former owner/name cannot redirect an existing binding to a
different repository. A manual URL change or explicit removal/re-add retires
that binding. Legacy repositories first acquire their ID through an
authenticated GitHub lookup; if an old alias was already reused before any ID
was recorded, the old identity cannot be recovered from that URL alone.

The repair preserves transport, remote names, refspecs and unrelated fork push
URLs. Multi-fetch URLs, inherited URL rewrites and unsupported URL forms remain
user-managed. GitHub failures preserve confirmed metadata. A change of the
selected connection, registration or local config during the lookup cancels
the repair. The config replacement owns Git's lock and the existing mutation
lane. Ordinary PR reads never rewrite Git config.

Only the remote destination, saved Origin and matching PR links change. Project
names, slugs, folders, workspace IDs, chats and Local/organization ownership
remain stable. Native Origin revisions prevent old renderer caches from
undoing a repair; notifications refresh live views without writing the result
back to the engine. Cloud keys are excluded from this Local maintenance path.

## Reads, limits and verification

The renderer deduplicates exact-key reads, structurally shares unchanged rows,
retains confirmed data through refresh failures and bounds retained cache
entries/weight. Active consumers share one next-due observer per workspace/PR.
It owns no timer during a read or while hidden/blurred, and backs off unchanged
or failed reads from 30 to 60 to 120 seconds. Explicit refresh, confirmed revision
changes, writes, focus/visibility return and reconnect reset observation;
changed content resets the next delay to 30 seconds. The last consumer leaving
fences held replies while retaining confirmed data. Workspace deletion retires
observation and forgets its cached PR discussions.
A successful write remains successful if its follow-up refresh fails, so a sent
draft is not presented for accidental retry.

Aggregate reads cap thread pages, per-thread comment bytes, total discussion
bytes, annotated check runs and annotation pages/bytes. Partial results carry
explicit notices and source links. A denied or failed Checks read does not hide
successfully loaded discussions. Markdown uses the existing sanitized renderer.

Adjacent engine, cloud-policy and renderer tests cover revision changes,
ownership denial, malformed anchors, pagination bounds, identity preservation,
cache isolation, stale responses and stable row reuse. The real-browser review
smoke is `scripts/ui-smoke-code-review.mjs`; guarded hunk/conflict behavior is
documented in [Git review actions](git-review-actions.md).

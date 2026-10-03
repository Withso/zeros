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

Cloud writes use the existing actor-bound, repository-bound GitHub capability.
The capability binds the exact body, path, side, line range, revision or thread
and intended action. The proxy verifies reply/thread ownership against the
admitted PR independently of worker assertions. Resolve/Reopen admit only fixed
GraphQL operations and their one bound node identifier. GitHub credentials stay
upstream of the worker. Imported authors are display metadata, never authority
to act as that author; writes use the authenticated viewer's GitHub identity.

## Reads, limits and verification

The renderer deduplicates exact-key reads, structurally shares unchanged rows,
retains confirmed data through refresh failures and bounds retained cache
entries/weight. Only active, visible surfaces poll; resume and reconnect
revalidate the same owner. Workspace deletion forgets its cached PR discussions.
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

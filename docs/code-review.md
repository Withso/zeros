# Workspace code review

The engine owns durable workspace discussions in SQLite. Migration 40 adds
threads, immutable comments and retry receipts; legacy `diff_comments` remain
unchanged. The same `WORKSPACE_REQUEST` API serves local desktop and authorized
remote clients. Renderer storage is not the discussion's source of truth.

Persistence follows the owning engine database and survives database reopen or
engine restart. Cloud review records also survive allocation replacement through
the existing `CloudWorkspaceRecordRuntime`. The `metadata` domain uses the
`code-review-v1:` entity prefix, with separate versioned documents for threads,
ordered comments and retry receipts. Each document binds the canonical workspace
and organization; restore verifies the registered checkout and remaps records
to its local routing ID. Original anchors, IDs, author snapshots, resolution
state, thread versions and receipt fingerprints survive this remapping.

Thread headers publish after their children. The header's comment count and
version identify the last complete capture when an upload spans several bounded
appends. Replacement restores that committed history and retires incomplete
upload children before new replies can reuse their sequence positions. Existing
512 KiB document, 2 MiB batch, paged response and projection cache bounds remain
in force. Filesystem checkpoints continue to exclude private SQLite files.

Capture and restore apply private/sensitive-path, alias and nested-owner policy
without reading or modifying source contents. Protected local anchors stay in
SQLite and are excluded from cloud capture. Already durable anchors that become
unreadable remain in the cloud record, with import blocked until their path is
allowed again. Ordinary deleted/historical paths can still restore.

`@zeros/protocol/code-review` defines the public schemas. An anchor contains a
normalized workspace-relative `path`, `side` (`old`, `new`, or `file`), inclusive
1-based `startLine`/`endLine`, and an opaque viewed-content `revision`, with
optional original `context`. The engine preserves this original anchor. A
revision records the caller's viewed content identity; it does not assert that
those bytes are still on disk. Deleted/historical paths remain valid. The
renderer must show uncertain or changed anchors as original/outdated locations.

| Operation | Input | Result |
| --- | --- | --- |
| `codeReview.list` | `workspaceId`, optional `path`, `includeResolved`, `threadId`, `cursor`, `limit` | Workspace, thread chunks, `partial`, optional `nextCursor` and `viewerActorId` |
| `codeReview.create` | `workspaceId`, `anchor`, `body`, optional `requestId` | Thread preview |
| `codeReview.reply` | `workspaceId`, `threadId`, `body`, optional `requestId` | Thread preview |
| `codeReview.setResolved` | `workspaceId`, `threadId`, `resolved`, `expectedVersion`, optional `requestId` | Thread preview |

The registered workspace is exact, including synthetic `local-main` and
registered repository roots without workspace rows. Neither a thread ID nor a
cursor grants access to another owner. Paths reject traversal, file/directory
aliases, dangling symlinks, private metadata, directories and nested owners.
Remote restrictions and qualified cloud file/role policies also apply. Missing
authority metadata fails the read instead of publishing an empty snapshot.
Comment operations never modify source, stage changes, accept a patch or bypass
Design authoring policy. Git review decisions/conflict saves are separate APIs
with their own source guards and content checks.

Each reply inserts an individual row and advances the thread version in one
synchronous transaction. Concurrent clients cannot replace or lose each other's
replies. Resolution/reopening requires the latest version and otherwise returns
`CODE_REVIEW_STALE`; refresh before making a new state decision. A reply to a
resolved thread does not implicitly reopen it. Request IDs are scoped by exact
workspace and trusted actor. An identical retry returns the current preview
without repeating a mutation; conflicting reuse returns
`CODE_REVIEW_RETRY_CONFLICT`. Author snapshots, original anchors and comment
order/IDs remain immutable across database reopen.
New receipt fingerprints omit the local routing ID because the receipt key
already scopes workspace and actor; cloud restore can therefore remap the owner
without repeating a write. Existing persisted fingerprints remain readable.

Reads have a 512 KiB JSON budget and bounded SQL row reads. `limit` defaults to
50 thread chunks and cannot exceed 100; a chunk fetches at most 64 comment rows
and fits within 256 KiB. A long thread can span pages. Follow `nextCursor` with
the same workspace and filters until `partial` is false. Pagination is a sequence
of current snapshots; mutations during paging are reflected by invalidation and
subsequent refresh, rather than a retained global snapshot. Never silently treat
a partial page as the entire workspace collection.

Renderer refreshes retain confirmed data while pending. A complete workspace
listing replaces thread membership, so paths hidden by a new nested owner or
source policy leave the cache. Paginated refreshes retain loaded history until
the listing finishes, then keep its confirmed members and acknowledged writes.
Each root read has a renderer-only listing identity, so identical opaque cursors
from different passes neither share pending page reads nor advance each other's
membership. Pages cannot clear a pending invalidation or publish over an active
root refresh; a failed refresh leaves a still-valid confirmed listing loadable.
Loaded history for surviving
threads remains available without restoring membership from an older pass.

Thread previews expose `commentCount`, `commentsComplete` and, when necessary,
`commentsCursor` with its `commentsCursorAfter` sequence position. Mutation
previews retain the original comment and newest
reply, with an explicit gap for larger discussions. Read remaining history with
`codeReview.list` using `workspaceId`, `threadId` and that `commentsCursor`, then
continue the returned `nextCursor`. `mergeCodeReviewThreads` merges pages and
previews by immutable comment ID/sequence and retains the latest thread version.
Preserve loaded history when applying a preview. No durable comments are pruned
to satisfy a response limit.

Public inputs reject actor/profile fields. Human identity derives from verified
transport admission or the verified local owner. Signed account profile names
are used when available; current cloud admissions supply account IDs but no
profile names, so their authors receive stable distinct Reviewer labels. The
list's `viewerActorId` lets the UI display You for matching authors. Anonymous
local work shares one persisted device identity; separate anonymous humans on
that device cannot be distinguished. Profile changes do not rewrite old author
snapshots. These APIs do not add presence or a new collaboration service.

Claude, Codex and Cursor receive `code_review_list`, `code_review_create`,
`code_review_reply` and `code_review_set_resolved` through the existing
authenticated per-execution product MCP admission. Tool arguments omit workspace
and author selection. The gateway supplies the registered provider and stable
conversation/execution identity; the handler pins its registered physical owner
and rejects cancellation, removal, relocation or a newly nested owner. This
catalog works without a selected Design directory and does not grant source
authoring permission.

Successful human and agent writes publish `DB_CHANGED` with
`kinds: ["codeReview"]` and exact `workspaceIds`, including the originator. The
renderer bridge validates response ownership and rejects a connection change
during dispatch. It uses the existing bridge resolver/cloud identity mapping;
no native/preload fallback is added. UI caches must retain the last confirmed
exact-owner snapshot on refresh or failure and expose remaining history.

Scoped agent tools commit to the same SQLite tables and publish the same change
event as human comments. Their success acknowledges the engine write; it does
not wait for a cloud HTTP capture. Cloud registration restores records before
readiness, and accepted heartbeats invoke the existing durable-record sync.
Queued agent command settlement waits for any prior capture and a fresh sync
before acknowledging the terminal command receipt. Final lifecycle checkpoints
pause admission, retire running providers and await record synchronization before
the filesystem checkpoint. This final boundary uses `flush`, which first drains
an active heartbeat capture and then captures fresh state after quiescence;
ordinary heartbeat `synchronize` calls can still share an active capture. These
existing triggers capture agent review writes
without adding a scheduler or service; an abrupt VM loss can still lose writes
made since the last completed durable sync.

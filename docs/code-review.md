# Workspace code review

The owning runtime stores durable workspace discussions in SQLite. Local uses
migration 40's threads, immutable comments and retry receipts; legacy
`diff_comments` remain unchanged. The cloud worker uses the same shared store,
routes, path policy, actor normalization and tool definitions with Node SQLite
bindings. The existing `WORKSPACE_REQUEST` API serves both placements.
Renderer storage is not the discussion's source of truth.

Local persistence follows its engine database. Cloud persistence lives in
`review.sqlite` under the worker state directory, keyed by the canonical cloud
workspace. Stop closes the database before acknowledgement; the existing
encrypted checkpoint captures it and restores anchors, comments, versions and
retry receipts after VM replacement. There is no control-plane comment mirror.

Cloud support requires exact `code-review-v1` negotiation on the worker's HTTP
and inbound WebSocket feature headers. Optional config `codeReview` carries the
creator's user ID and verified Git identity name, with the shared fallback name
when unavailable. The worker advertises `ENGINE_READY.capabilities` only after
the store and trusted attribution are ready. Older peers remain unavailable.

The shared renderer capability check requires consistent owner identities and
an already-connected capable peer. Cloud operations use `requestConnected`;
passive reads never wake a workspace. Stopped workspaces show the existing
open-to-view error, retain any confirmed same-owner snapshot, and disable private
comment writes. Account/owner changes retire cached data and held responses.
Hidden surfaces do no I/O, and capability/status events enable an active surface
without polling. Local Personal and organization-local behavior is unchanged.

The cloud database is bounded to 64 MiB, 10,000 threads, 100,000 comments and
100,000 retry receipts. Each body also has an 80,000-byte UTF-8 limit in addition
to the shared 20,000-character limit. At capacity, new writes fail with
`CODE_REVIEW_CAPACITY`; prior comments and identical retry receipts remain
readable. No comments or receipts are silently pruned. SQLite rollback journals
are transient and bounded by the database; the combined checkpoint budget still
applies.

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
Remote restrictions also apply. Missing authority metadata fails the read
instead of publishing an empty snapshot.
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
already scopes workspace and actor. Existing persisted fingerprints remain
readable.

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
Pending reads contribute to workbench tab status but render no inline loading
text or padded loading-only wrapper. Errors, notices and pagination remain
available through their existing controls.

Local GitHub PR comments have one shared foreground observer per exact workspace
and PR key. It schedules the next read only after the current read settles,
backs off unchanged or failed reads from 30 to 60 to 120 seconds, and resets on
changed content, explicit refresh, a write, focus/visibility return, reconnect
or a confirmed PR revision change. Hidden or blurred windows cancel the timer;
the last consumer's departure also releases the connection observer and fences
held replies. Confirmed threads remain visible throughout revalidation. Workspace
deletion retires observation and its cache; returning to the same key starts a
new observation without accepting the previous visit's held reply.

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
transport admission, the verified Local owner, or the cloud creator config.
Signed account profile names
are used when available; an admitted actor without a profile receives a stable
Reviewer label. The
list's `viewerActorId` lets the UI display You for matching authors. Anonymous
local work shares one persisted device identity; separate anonymous humans on
that device cannot be distinguished. Profile changes do not rewrite old author
snapshots. These APIs do not add presence or a new collaboration service.

Claude, Codex and Cursor receive `code_review_list`, `code_review_create`,
`code_review_reply` and `code_review_set_resolved` through authenticated
per-execution product MCP admission. Tool arguments omit workspace
and author selection. The gateway supplies the registered provider and stable
conversation/execution identity; the handler pins its registered physical owner
and rejects cancellation, removal, relocation or a newly nested owner. This
catalog works without a selected Design directory and does not grant source
authoring permission.

Cloud registers these tools as `zeros_workspace` on a loopback-only HTTP MCP
server. Each native execution gets an independent bearer grant, with at most
64 grants and eight MCP sessions per grant. Requests recheck ownership after
body reads. Replacement and Stop revoke grants before any persistence wait;
workspace Stop also closes admission so an in-flight open cannot mint a new
grant. Tokens stay in process memory and the admitted driver's configuration,
never logs or checkpoints. This enforces dispatch lifetime, not isolation
between processes: the VM remains the trust boundary.

Successful human and agent writes publish `DB_CHANGED` with
`kinds: ["codeReview"]` and exact `workspaceIds`, including the originator. The
renderer bridge validates response ownership and rejects a connection change
during dispatch. Local uses its existing bridge workspace resolver; cloud
routes directly to its exact connected peer. No native/preload fallback is
added. UI caches must retain the last confirmed
exact-owner snapshot on refresh or failure and expose remaining history.

Scoped agent tools commit to the same SQLite tables and publish the same change
event as human comments. Their success acknowledges the owning runtime's write.

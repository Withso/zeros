# Workspace archives, dashboard visibility, and recovery

Archive removes a managed checkout after saving its tracked changes, untracked
non-ignored files, configured files-to-copy, and context attachments. Chats and
messages remain in the database. Unarchive restores the checkout under the same
workspace identity. It retains the latest verified archive snapshot and branch
anchor for subsequent recovery. A snapshot records captured files; it does not
recover newer edits or replace a backup of the repository's Git object store.

## Immediate archive interaction

The archive click synchronously records renderer-local intent, hides the row
from tabs, Dashboard, repository lists and counts, and selects the next visible
workspace in the same React batch. There is no archive progress or success toast.
No Git or bridge response is awaited before this presentation change.

Intent stays separate from confirmed workspace rows. The engine still drains
writers, captures recoverable files, seals hooks and removes the checkout before
publishing the archived record. Only that confirmation adds it to Archived and
detaches renderer runtime state. Drafts and history remain available for restore.
A failed request reveals the newest confirmed live row and reports the error
without changing the user's current destination. Duplicate clicks share the
busy guard, and burst archives never navigate onto another hidden archive intent.

A response timeout keeps the intent hidden while exact workspace and lifecycle
reads determine the outcome. Stale live-list refreshes cannot undo that intent.
Renderer reload discards presentation intent and reads authoritative engine
state; the engine journal continues to own crash recovery. Immediate interaction
latency and complete checkpoint/removal latency are measured separately.

## Checkpoint performance

Successful turn, reset, and archive snapshots warm a disposable in-memory Git
index cache for that exact checkout. Later snapshots copy its validated file
metadata into their own scratch index and run Git's final scan again. Unchanged
files can reuse their blob IDs instead of rereading and hashing all their bytes.
The user's staging index is never modified. Concurrent captures have separate
scratch files and Git locks.

Reusing the complete previous snapshot requires the same HEAD and ignore rules.
Adding forced paths or exclusions is safe; removing either resets the scratch
index against HEAD so previously included private files cannot leak into another
capture. A prior deletion also resets against HEAD, preserving recreated tracked
files even when they match an ignore rule. Changed HEAD, Git configuration, or
attribute files invalidate normalization evidence. Changes to rules governing
cached files during capture prevent publication. Newly included scopes with
previously unseen rules are captured without caching that result. Sparse
checkouts and settings that weaken Git's stat checks use the fresh-index path.
The copied index retains a conservatively rounded timestamp so Git still checks
edits made close to the original capture time.

Only published snapshots enter the cache. It holds at most 32 entries and 32 MiB
of index bytes, with a 16 MiB per-index cap; it stores no additional file bodies.
Eviction or an engine restart loses only the optimization. Archive still drains
workspace writers and publishes its durable snapshot before removing the checkout.
Its journal, recovery refs, and post-hook sealing order are unchanged.

Warm archives with small changes can complete in milliseconds. A cold capture,
new large attachments, or a large amount of changed data still requires real I/O.
The archive log reports file enumeration, Design recovery, context preparation,
index seeding, ordinary staging, forced staging, and publication timings, plus
whether an index was reused. These fields contain durations and a boolean;
they do not add file paths, contents, or configuration values to the log.

Run `pnpm exec tsx scripts/benchmark-workspace-archive.ts` for a disposable
512-file/128-MiB fixture. It measures cold and warm snapshots and a complete
archive, then verifies that restoring recovers the draft and binary data. Run
it on the target platform when comparing user-visible latency; the filesystem
cache is warm and the figures are not a universal archive-time guarantee.

## Recovery and visibility

`refs/zeros/archive/<workspace-id>` is a persisted compatibility contract shared
by all app instances using a repository. A workspace absent from one instance's
database may belong to another instance. Startup maintenance never deletes
unknown archive refs or drops a snapshot merely because its workspace is live.
It repins surviving objects recorded in this instance's database when their ref
is missing. New captures use `refs/zeros/archive-pending/<workspace-id>` until the
database journal owns them, then replace the latest verified archive ref.

The archived card's menu offers Hide/Unhide and Delete saved snapshot. General
settings can show hidden workspaces in the same Archived column, with an eye-off
indicator beside Unarchive. Hiding changes only dashboard presentation; it does
not remove a checkout, branch, snapshot, workspace record, or conversation.

The experimental 15-day policy uses the current `archivedAt` timestamp and is
off by default. It applies after 15 consecutive days archived, including time
while the app was closed. Unarchiving returns the workspace to ordinary visible
use. A later archive starts a new period. Explicit Unhide overrides automatic
hiding for that archive period. Disabling the policy stops future automatic
hides without unhiding entries already hidden. A persisted archive-time cutoff
retains automatic hides regardless of list size. Manual visibility entries are
keyed by workspace id and archive timestamp, bounded to the latest 5,000 entries,
and removed when their workspace or repository is deleted. The aggregate checks
the next deadline only while Dashboard and the document are visible. Archived
card menus and confirmation dialogs close when Dashboard becomes inactive.

Delete saved snapshot requires a confirmation naming the loss of archived file
changes and attachments stored only in the snapshot. Its request carries the
reviewed snapshot OID and archive timestamp; a stale confirmation cannot discard
a newer archive. A `delete` lifecycle journal with `payload.snapshotOnly` rolls
this intent forward across crashes. Workspace metadata, branch, chats, and
messages remain. The `archive.snapshot-deleted.v1` workspace metadata marker
prevents a later unarchive from silently recovering an old turn snapshot instead
of honoring the deletion. Unarchive then reports that only committed files were
restored. Git may retain unreachable objects until its own garbage collection.

Missing folders retain their workspace owner and conversations. They leave active
workspace lists and counts and join the Dashboard's existing Archived column;
this does not change `archivedAt`. A repository remains registered with zero
available workspaces. The repository Workspaces page has an additive Archived
toggle, off by default, that includes both archived and missing rows, including
archives hidden on Dashboard. Its `repo-history-visible-v1` preference is keyed
by project id, bounded to 256 owners, and pruned on repository removal.

Re-adding an explicitly removed repository reconciles its surviving workspace
records before unhiding the repository. Available folders remain visible;
absent old owners require a fully readable snapshot or a verified original
linked checkout at a registered path. A branch name, stale registration or
corrupt snapshot alone is insufficient. Unrecoverable rows receive the durable
`repository.readd-hidden.v1` metadata marker and are omitted from workspace
lists without deleting their chats or recovery metadata. Another explicit
re-add rechecks eligibility, and a confirmed return of the original folder
clears the marker. This filter does not apply to ordinary folder loss while
the repository remains registered. Repository upserts invalidate workspace
collections for the originating client as well as peers.

Opening an archived or missing workspace uses the same `ConversationPane`,
`ConversationPaneLayout`, `ChatDeck`, `ChatView`/`ChatBody`, `ChatTabs`, and
`AgentChat` as an available workspace; there is no separate history page or
transcript renderer. Read-only mode hydrates saved messages while gating provider
binding, admission, configuration changes and reconnect retries. Retained history
is bounded by the normal deck and hidden views remain inert with polling paused.
Closed chats can be previewed without changing their archive flag, and empty or
terminal-only history never creates a chat. `AgentChat` owns its `data-zeros-root`
style scope, so rendered Markdown keeps the same typography and spacing.
The transcript retains its normal layout, scrolling, automatic
older-message pagination, readable tool output, copy actions, and recorded turn
metadata. There is no separate older-message button or summary card. Read-only
mode leaves parked drafts and queued submissions untouched and disables agent
preparation, chat creation, retry, edit/resubmit, Continue, reset, fork, and
workspace-file actions. Terminal, browser, Design, and workbench surfaces remain
unmounted. Recovery controls replace the composer:

| State                                             | Message                                                 | Action    |
| ------------------------------------------------- | ------------------------------------------------------- | --------- |
| Archived                                          | This workspace is archived.                             | Unarchive |
| Missing, readable saved snapshot                  | Workspace folder missing                                | Restore   |
| Missing, original Git identity can be reconnected | Workspace folder missing. Reconnect the original folder | Locate    |
| Missing, no verified recovery source              | Workspace folder missing. No recovery                   | None      |

A cold recovery read shows the neutral missing-folder message without an action
until verification finishes. Recovery reads are shared by exact workspace,
path, repository and snapshot identity; pointer/focus intent warms these reads
and the saved chat without starting workspace tools. Snapshot verification checks
the saved tree's object closure both before offering Restore and again before
creating a replacement checkout. The bar displays the snapshot time; it does
not promise recovery of later edits.

Presence requires usable Git metadata, so a returned folder with a dangling
`.git` pointer does not masquerade as healthy. An intact returned folder is
detected while its history is visible. Filesystem watcher retirement also
publishes the vanished workspace identity, even if its target disappears before
the native filesystem event arrives. Loss is never interpreted as deletion of
the database owner or repository.

Locate uses the native folder picker and verifies the original repository,
branch, linked gitdir and registration before repairing the connection. It does
not move, reset or overwrite working files. The workspace id stays stable;
workspace path and descendant chat folders rebind in one database transaction.
Returned files remain authoritative over an older snapshot. Recovery of a folder
returned to its original path can rebuild a pruned Git registration, preserving
working files; staging distinctions are unavailable when the original index is
gone. Foreign folders fail validation without changing their files or owner.

`workspace.located-path.v1` is an engine ownership receipt for the explicitly
reconnected location, allowing subsequent archive, restore and deletion to
verify it. Automatic workspace-root migration skips these locations. The
renderer keeps using the compatible `adopted-worktrees-v1` path-to-repository
registry for outside-root resolution; this does not mark the engine workspace
as adopted. The validated map is bounded to 2,048 paths, resolves descendant
chats by the most specific owner, and is pruned on explicit deletion/removal.

Explicit workspace/repository removal can retire a workspace row when both its
checkout and source repository are confirmed absent; failed Git cleanup must not
resurrect that row when the repository is added again. Merely observing missing
folders never invokes this cleanup.

Recovery uses local-only bridge operations `workspace.recoveryInfo`,
`workspace.recover`, and `workspace.locate`; snapshot disposal uses
`workspace.deleteSnapshot`. Recovery and Locate publish both workspace and chat
invalidations, including to the initiating client after long-running operations.

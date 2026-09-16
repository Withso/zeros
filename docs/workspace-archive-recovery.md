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

Missing folders retain their workspace owner and offer recovery. Presence
requires usable Git metadata, so a returned folder with a dangling `.git` pointer
does not masquerade as healthy. An intact returned folder is detected by the
visible recovery panel. Explicit recovery of a returned managed folder rebuilds
only its missing Git registration and index, after verifying its repository and
branch. It preserves working files, including deletions and ignored files;
previous staging distinctions are unavailable when the original index is gone.
A still-missing folder can be recreated from its retained archive snapshot.
Unavailable snapshot objects fail before creating another checkout. Neither
path silently deletes the workspace or its conversations.

Recovery and snapshot disposal use the local bridge operations
`workspace.recover` and `workspace.deleteSnapshot`.

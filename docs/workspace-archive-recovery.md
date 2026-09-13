# Workspace archives, dashboard visibility, and recovery

Archive removes a managed checkout after saving its tracked changes, untracked
non-ignored files, configured files-to-copy, and context attachments. Chats and
messages remain in the database. Unarchive restores the checkout under the same
workspace identity. It retains the latest verified archive snapshot and branch
anchor for subsequent recovery. A snapshot records captured files; it does not
recover newer edits or replace a backup of the repository's Git object store.

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

# Workspace context storage

Composer attachments reach every agent as confirmed file references. Staging
starts when the file is attached; Send awaits persistence before passing the
engine-returned path with an instruction to read the file or open the image.
Text bodies and image bytes are not embedded in composer prompts, regardless
of the harness's native image-input capability. Reading a referenced format
depends on the tools available to that agent.

The shared encoder also handles older drafts and edited/retried messages. It
can restore legacy text/image bytes to persist the file, but sends only the
resulting path and retains the original attachment id. Both text and image
bubble metadata keep that relative path. Failed saves retain the unsent draft;
typing during a save cannot be cleared by the earlier submission. Attachment
format and upload-size policy is separate from this delivery contract.

See [Composer attachments](composer-attachments.md) for the 500 MB file policy
and chunked transfer / path delivery contract.

Each workspace has one `.context/` folder. Composer attachments use
`.context/attachments/<attachmentId>/<filename>`; every other file is a context
document. Code agents keep task files in `.context/<task>/`. Zeros writes no
ignore rules for the folder: whether `.context/` is committed is the
repository's choice (this repository ignores it). Owner-only and dot-prefixed
top-level entries are private tool state, such as a development checkout
binding; they are neither listed nor archived.

Earlier builds wrote a private `local/` scope and a shareable `shared/` scope.
Existing records there stay in place and remain listed, readable and
archivable; new writes never create those folders. The share action
(`context.graph.setShared`) is retired and answers older clients with an error.
The workbench Context tab and its canvas are retired. The conversation summary
retains its recent context list and opens items in the Files viewer. The shared
renderer cache lives in `apps/desktop/src/renderer/shell/context-graph-data.ts`.
Listing items keep their `scope` field for wire compatibility: everything Zeros
writes now reports `local`.

Persisted `context` tabs are removed during workbench normalization. A selected
retired tab falls back to the Files home in that same workspace. Other tabs,
including open `.context` files, keep their identities and saved choices; the
workbench storage key does not change.

The pre-graph transcript layout `.context/attachments/<chat>/<file>` shares
the flat shape. A flat path names an attachment record only when its folder
equals the record's attachment id; any other flat reference is a chat-era path
that the transcript window copies into a record of its own. Existing ignore
files are preserved; legacy root and local ignore files still merge during
`.context-graph/` migration.

## Migration and compatibility

Workspace creation and context reads leave storage untouched. Attachment
staging and explicit scaffold operations prepare the directory on demand. Preparation merges `.context-graph/` into
`.context/`, including when the destination already exists. Read-only listing
never migrates; it can list both roots while migration is pending or blocked.

Migration preflights file collisions and symlinks. It uses exclusive hard
links, preserving file bytes, permissions and modification times without
replacing destinations. Source removal first atomically renames the source
into a private recovery record, then verifies that record against the destination
before deleting it. An atomic save at the original name is never unlinked.
If a replacement was captured, it is restored exclusively or retained as a
separate recovery copy when another save occupies the original name. Identical
destination files support interrupted-migration retries. Different same-path contents,
file/directory collisions, or attachment ids in opposite scopes across roots
stop migration with an error. Conflicting copies remain available. Only empty
source directories are removed; files arriving during migration are not
recursively deleted. Symlinked roots, scope directories and migration entries
are refused. Unsupported filesystem operations fail without overwriting data.

Private recovery and archive provenance live in
`.context/local/.zeros-context-migration/`, which is excluded from context
listings. Recovery records contain a versioned original relative path and any
captured file; preparation resumes interrupted removals before scanning the
legacy directory. Paths are validated and metadata reads refuse symlinks.
Conflicting versions remain on disk with an error naming their locations.
Legacy files that collide with this metadata directory remain visible and
archivable while migration reports the conflict.

Preparation calls for the same workspace share an in-flight promise. Failed
preparation retries on the next write. Attachment-stage failures
retain their error messages while context reads keep legacy/current files
visible without attempting a migration or adding generated directories.

Attachment copy buffers and their cleanup records live in private storage
outside the checkout. On an explicit context write, an obsolete
`.context/.attachment-staging/` is removed only if empty or containing its exact
generated ignore file. Other contents and links are preserved. Recovery-source
maintenance does not delete completed files in either context scope.

Saved attachment `diskPath` values remain valid in every layout. Attachment
reads try the exact saved path, then `.context/attachments/<id>/`, then the
earlier scopes under `.context/` and `.context-graph/`. Exact successful reads
win when conflicting copies exist. Chat-era paths remain exact-only until the
transcript-window migration copies the image into a record. Re-staging an id
that an earlier build stored in a scope keeps that scope's folder, so saved
paths never gain a second copy. Resending an edited message preserves its
original attachment id in every layout.

Send-time metadata resolution also honors the saved graph path first, including
its recorded filename. If that path moved, exactly one matching record must
remain across those locations; ambiguous copies require reattachment. Resolution
validates the record path and refuses symlinks without reading file bodies.
Queued sends and Send now refresh their file references and bubble metadata
before dispatch. Failed resolution preserves the editable row and pauses the
queue; Stop during resolution prevents dispatch.

Open sent-message edits mirror their whole document and attachment identities
into a chat/message-owned live draft slot. Debounced persistence, reload and
native quit flush this slot without requiring React unmount or publishing each
keystroke through workspace state. Replacing or reordering attachments counts
as an edit even when the text and attachment count stay the same.

The `context.graph.*` bridge operations, `agent_attachment_write` IPC,
attachment ids, transcript fields and workbench persistence keys retain their
names. Historical prompt text and external shell commands are not rewritten;
the path fallback belongs to attachment reads in Zeros.

## Git and archive recovery

Zeros neither writes nor edits ignore rules for `.context/`, and saving never
stages or commits. The retired share action was the only writer of sharing
exceptions; `.context-graph/` migration still preserves the Git visibility of
files an earlier build shared, appending narrowly scoped exceptions only when a
parent rule ignores all of `.context/`. Rules inside shared subfolders still
take precedence: such a migration reports an error before moving the record.
Already-ignored files within the shared scope retain their existing treatment.

Archive recovery force-adds `.context/attachments/`, the earlier scopes,
top-level task folders and files, and an existing `.context/.gitignore` when
context content exists. Private tool state is excluded because a snapshot
cannot restore its permissions. Recovery also preserves an unmigrated
`.context-graph/` and the older `.context/attachments/` transcript store.
Archive content checks and task selection do not use the UI listing's depth
or entry limits, so deeply nested files and large task folders remain recoverable.
Files migrated from outside the legacy local/shared scopes are recorded by
their exact relative paths before removal. Those records and any outstanding
recovery copies also survive archive/restore, so a migrated root document stays
recoverable. Explicit files-to-copy/provisioning rules retain their separate
archive contract. Restore can recover any layout; normal preparation then
migrates legacy files. Workspace lifecycle barriers continue to drain
attachment writes and scaffolds before archiving or deleting the checkout.

Regression coverage lives in `engine/files/__tests__/context-directory-migration.test.ts`,
the context graph, attachment reader/encoder, workspace service, bridge and
worktree suites, and the renderer's Context cache race tests.

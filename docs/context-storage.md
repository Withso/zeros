# Workspace context storage

The Context tab uses `.context/local/` for private material and
`.context/shared/` for material selected for sharing. Composer attachments use
`<scope>/attachments/<attachmentId>/<filename>`; other files inside either
scope are context documents. The tab's book icon and empty message, “No context
added”, do not affect storage or attachment identity.

Existing `.context/` scratch files and the older
`.context/attachments/<chat>/<file>` transcript layout remain in place. The
Context canvas lists the two explicit scopes, not arbitrary scratch files.
Fresh scaffolds ignore other root contents, including their own `.gitignore`.
A private-scope `.gitignore` protects new attachments even when an existing
root ignore file has unrelated rules. Existing ignore text is preserved; legacy
root and local ignore files merge with scaffold rules instead of colliding with
generated files.

## Migration and compatibility

Workspace creation, the first Context-tab load, attachment staging and share
actions prepare the directory. Preparation merges `.context-graph/` into
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
`.context/local/.zeros-context-migration/`, which is excluded from Context
cards. Recovery records contain a versioned original relative path and any
captured file; preparation resumes interrupted removals before scanning the
legacy directory. Paths are validated and metadata reads refuse symlinks.
Conflicting versions remain on disk with an error naming their locations.
Legacy files that collide with this metadata directory remain visible and
archivable while migration reports the conflict.

Preparation calls for the same workspace share an in-flight promise. Failed
preparation retries on refresh, and the Context tab displays the error while
keeping readable context visible. Attachment-stage and share failures also
retain their error messages.

Saved attachment `diskPath` values remain valid in both layouts. Attachment
reads try the exact saved path, the other scope in that root, then both scopes
in the other root. Exact successful reads win when conflicting copies exist.
The pre-graph `.context/attachments/...` layout remains exact-only until its
existing transcript-window migration copies the image into a scope. Resending
an edited message preserves its original attachment id for both graph layouts.

The `context.graph.*` bridge operations, `agent_attachment_write` IPC,
attachment ids, transcript fields and workbench persistence keys retain their
names. Historical prompt text and external shell commands are not rewritten;
the path fallback belongs to attachment reads in Zeros.

## Git sharing and archive recovery

Scaffolding does not rewrite the repository's `.gitignore`. An explicit share
action, or migration of already-shared material, can append narrowly scoped
exceptions when a parent rule ignores all of `.context/`. These re-open
`.context/shared/` while retaining ignores for sibling scratch files. Existing
`.context/.gitignore` text is preserved and receives sharing exceptions only
when necessary. Rules inside shared subfolders still take precedence: a share
that would remain ignored reports an error before moving the private record.
Sharing changes Git visibility; it does not stage or commit files.
Migration installs incoming ignore rules before checking every previously
visible shared destination, including tracked files that match an ignore rule.
Already-ignored files within the shared scope retain their existing treatment.

Archive recovery force-adds `.context/local/`, `.context/shared/` and the root
ignore file when context content exists. It also preserves an unmigrated
`.context-graph/` and the older `.context/attachments/` transcript store.
Files migrated from outside the legacy local/shared scopes are recorded by
their exact relative paths before removal. Those records and any outstanding
recovery copies also survive archive/restore, so a migrated root document stays
recoverable without including unrelated neighboring scratch files.
Unrelated ignored scratch files are not included through the context archive
rule. Explicit files-to-copy/provisioning rules retain their separate archive
contract. Restore can recover either layout; normal preparation then migrates
legacy files. Workspace lifecycle barriers continue to drain attachment writes,
scaffolds and share operations before archiving or deleting the checkout.

Regression coverage lives in `engine/files/__tests__/context-directory-migration.test.ts`,
the context graph, attachment reader/encoder, workspace service, bridge and
worktree suites, and the renderer's Context cache race tests.

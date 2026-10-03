# Git review actions

Hunk review is available for the live Uncommitted (`HEAD` to worktree) and
Unstaged (index to worktree) comparisons. Accept keeps the file and index as
they are and records a decision. Reject requires confirmation, validates that
the displayed patch remains one exact live hunk, and reverses only that hunk.
Neither action stages source or changes Git history. Historical, committed,
binary, rename, copy, and file-mode changes are outside this action contract.
Rejecting a tracked file deletion restores its content and regular-file mode
from the validated deleted-file header for the selected comparison: HEAD for
Uncommitted, index for Unstaged. The staged blob and mode remain unchanged.

Decisions are local metadata in the existing SQLite settings bag. The durable
`git.hunk-review.v1:` prefix is followed by a SHA-256 hash of the physical
workspace root. Each decision hashes the relative path, comparison, complete
hunk patch, and entire confirmed file content. A changed file snapshot must be
reviewed again. Records contain hashes and decision metadata rather than source
or patch text, and retention is bounded to 1024 decisions per root and a bounded
serialized value. Rowless primary checkouts have the same persistence behavior.

Merge conflict choices support normal and diff3 blocks, including multiple
blocks, CRLF, and files without a final newline. Current, Incoming, and Both
update an editor preview immediately; Both keeps current followed by incoming.
Unrelated source slices remain exact. Save resolution is a separate explicit
action. The engine reconstructs the choices against the original snapshot,
requires every conflict to be chosen, and verifies that the path is still
unmerged. It leaves the index and merge/rebase continuation to explicit Git
actions.

Source writes use workspace-relative path validation, the existing cloud file
authority, and Design recognition from current, index, HEAD, registry, and
sticky evidence. Code review refuses Design authoring and path aliases. Guarded
writes compare bounded UTF-8 bytes and file generation before preparing a
temporary file and immediately before atomic replacement. Restored-file
permissions are set on the temporary file before local/cloud ownership
publication and replacement. Creation modes are an internal Git-derived option,
never a file-write IPC parameter. Existing targets retain their permissions. A
stale or unsafe write returns an error; the renderer retains the preview and
choices. A changed confirmed snapshot requires an explicit Reload latest to
discard an unsaved resolution preview.

The standalone renderer components live in
`features/code-review/hunk-review-actions.tsx` and
`features/code-review/merge-conflict-actions.tsx`. Their owner receives the
confirmed disk content separately from the preview and gates inactive, read-only,
historical, and Design surfaces. Ordinary unguarded editor Save must be disabled
while displaying a resolution preview or routed through the conflict action.
Separate unsaved source edits must be saved or undone before choosing a
resolution. While Save resolution is pending, the editor and Discard preview
remain disabled; failure retains the choices and preview for retry. The parent
tracks the save lifetime so an early disk refresh cannot erase an editor draft.
Decision reads share a bounded exact-file cache; events invalidate the affected
workspace and active consumers revalidate while keeping confirmed data visible.

The protocol leaf `@zeros/protocol/git-review-actions` owns schemas and the pure
patch/conflict helpers. The workspace operations are `git.reviewHunks`,
`git.reviewHunk`, and `git.resolveConflict`; registration must retain write
admission, lifecycle serialization, cloud policy, Design guards, and workspace
change events. Engine and renderer clients never infer a historical patch is a
live mutation target.

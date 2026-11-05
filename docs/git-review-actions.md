# Git review actions

Per-hunk review (Accept and Reject under each hunk, with stored decisions) was
retired with the Changes redesign: diffs carry comments only. Stage, unstage
and discard keep their own hunk operations. Decisions stored under the
`git.hunk-review.v1:` settings prefix are no longer read and need no
migration.

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

The standalone renderer component lives in
`features/code-review/merge-conflict-actions.tsx`. Their owner receives the
confirmed disk content separately from the preview and gates inactive, read-only,
historical, and Design surfaces. Ordinary unguarded editor Save must be disabled
while displaying a resolution preview or routed through the conflict action.
Separate unsaved source edits must be saved or undone before choosing a
resolution. While Save resolution is pending, the editor and Discard preview
remain disabled; failure retains the choices and preview for retry. The parent
tracks the save lifetime so an early disk refresh cannot erase an editor draft.

The protocol leaf `@zeros/protocol/git-review-actions` owns the schema and the
pure conflict helpers. The workspace operation is `git.resolveConflict`;
registration must retain write admission, lifecycle serialization, cloud
policy, Design guards, and workspace change events.

## Direct commits and your Git setup

Create PR directly and Create draft directly commit through the engine's
hardened Git: repository hooks do not run, commits are not signed and Git LFS
filters do not run. The PR menu says so in Local workspaces. A direct commit is
refused, with nothing written, when it would add or change Git LFS-tracked files
or when the user's Git config sets `commit.gpgSign`; Create PR (the agent commits
with the user's own Git) or the terminal handles those. Cloud workspaces commit
with the Cloud Computer's Git, which runs hooks; there a commit of LFS-tracked
files is refused unless the recipe configures git-lfs.

A new workspace of a repository whose root `.gitattributes` uses `filter=lfs`
starts Setup with `git lfs pull` (Local: the user's git-lfs and credential
helpers; cloud: the VM's), then the repository's own setup command. Without
git-lfs it prints how to install it; neither case fails Setup. Automatic Design
folder rename and removal commits use the user's Git identity, and Zeros'
identity only when none is configured.

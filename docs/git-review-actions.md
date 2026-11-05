# Git review actions

Per-hunk review (Accept and Reject under each hunk, with stored decisions) was
retired with the Changes redesign: diffs carry comments only. Stage, unstage
and discard keep their own hunk operations. Decisions stored under the
`git.hunk-review.v1:` settings prefix are no longer read and need no
migration.

Merge conflicts resolve in place, where the file is shown. Each normal or
diff3 block is marked in its rows (current under its HEAD band, incoming above
its branch band) with Accept current change, Accept incoming change and Accept
both above it; Both keeps current followed by incoming. Accepting rewrites only
that block, so unrelated source, CRLF line endings and a missing final newline
stay exact (`conflictReplacement` in `@zeros/protocol/merge-conflicts`). Markers
that cannot all be paired get one notice naming the line and no actions, so
nothing rewrites a broken file.

In the Files editor (`code-editor/merge-conflict-blocks.ts`) an accept is one
ordinary editor transaction: ⌘Z undoes it, it shares the draft and undo history
with typed edits, and the file autosaves or saves with ⌘S like any other. A
navigator beside the file name steps between blocks. Diff view waits while Git
still lists the file as conflicted, so no accept swaps editors and drops its
undo history. A Changes card (`features/code-review/merge-conflict-pierre.tsx`)
shows the same blocks, buttons and navigator; an accept there rewrites the file
through the ordinary file write, only over the exact text the card shows. A
file that changed since is refreshed instead. Read-only views mark the blocks
and point to the editable file. Design files resolve like any other file;
people's writes to cloud Design paths stay refused by the engine.

Saving never stages: Git keeps listing the file as conflicted until it is
staged, and merge or rebase continuation stays an explicit Git action. The
former Resolve conflicts panel, its preview strip and the `git.resolveConflict`
workspace operation are gone; nothing persisted belongs to them.

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

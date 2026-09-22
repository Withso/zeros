# Opening local projects

All new local work uses Git worktrees. GitHub is optional.

Start from scratch creates an empty local Git repository and its first workspace.
The dialog asks for a project name and parent folder, with optional GitHub
publication. It has no template picker or shortcut badge. Create authorizes Git
initialization directly, so this flow does not show a second Git confirmation.

An in-app Open project action inspects the selected folder. When Git is absent,
show “Create a workspace ?” with “Set up Git to create a workspace for this
folder.” and the folder path. “Initialize git and create” confirms setup; Close
or Escape dismisses without registering or changing the folder. After confirmation,
register the folder, initialize Git, create the initial commit and open the first
managed worktree. Re-inspect on confirmation rather than trusting the old snapshot.
Existing Git repositories skip this dialog; an unborn HEAD receives an initial
commit when creating its first worktree. The commit includes existing non-ignored
files; an empty folder receives an empty initial commit. Existing repositories
with commits keep their history and working changes. Reopening a repository
reuses its live workspace rather than creating a duplicate.

There is no direct-folder preference, automatic main-checkout tab, or choice
between folder work and worktrees. Create always opens a worktree, preserving the chosen model,
effort and optional prompt in its first chat. Additional chat tabs share that
worktree. New projects never gain a root workspace merely by being registered.

Git setup is an explicit open/create action, not a startup or resume effect.
External deep links only register a project and open its existing workspace or
repository page. Inspection errors never count as proof that Git is absent.
Registration completes before Git mutation. Concurrent opens of the same root
share setup; different roots remain independent. Failed initialization offers
Retry. Failed worktree preparation stays on the repository page and never
falls back to creating a chat in the original directory. Retrying partial setup
preserves the initialized repository.

## Compatibility and recovery

Existing chats, files and workbench selections keep their original paths and
`local:<repoSlug>` identity. `useFolderWorkspaces` projects only previously
opened checkout directories, including subdirectories. It resolves the most-specific
registered owner, excludes managed worktrees, and reopens the saved exact cwd.
Repository filters distinguish absent selection memory from a previously opened
root; a repository with no live or remembered workspace opens its repository page
and updates the filter in the same state transition. Registration alone never
creates a root destination.
The retired `zeros.experimentalFeatures.workInLocalMain` key is ignored on read
and removed from the preference blob on the next write. Other preferences stay
intact. Existing root conversations are never moved, deleted or initialized
merely by restoring them.

Capability-aware recovery remains for older plain folders and external Git
changes. App resume quietly refreshes exact-owner Git/origin capabilities,
retaining confirmed data on errors. Legacy plain folders keep Folder icons and
no workspace count; Git-only settings and Review remain unavailable when their
requirements are absent. Review additionally requires a supported GitHub remote.
The Design canvas uses a managed workspace; its old plain-folder setup surface
remains available for restoring previous sessions.

The Files view shows a File icon and “No files in this workspace” only after
both normal and ignored listings confirm emptiness. It retains confirmed files
on failed refreshes and never covers an already open file.

Missing or inaccessible directories retain their saved state. Worktree errors
remain visible so users can retry without losing conversations or source files.

Continue on a new branch refused any uncommitted Design draft whenever the
target changed anything under the Design root, so a merged-PR workspace with
local Design edits could not continue. The guard now leaves tracked and
untracked edits to Git's per-path overwrite checks, merges overlapping tracked
edits three-way (`checkout -m`, conflicts left unmerged, prior edits kept in
the stash list) and protects only what Git does not: ignored drafts, and files
at paths the target adds. Git's sparse-checkout switch overwrites such
untracked files while only warning, and `git read-tree <tree>` clears
skip-worktree bits; restore staging with `git reset -q <tree> -- .`
(`zstack-verify` gotcha, case `continue-carries-uncommitted-design-draft`).

Restoring several archived workspaces ran them one after another: the
owner-scoped Design territory gate from #584 still chained every owner onto the
app-wide FIFO tail. Owner transitions now wait only for earlier app-wide ones,
and an app-wide transition waits for every in-flight owner (case
`owner-lifecycles-run-concurrently`).

Engine boot spent about 25 s in `archive-refs` because it started one Git
process per saved snapshot, and every archived workspace keeps one. Startup
maintenance lists each repository's pins once; the test counts Git argv
(case `boot-archive-pins-per-repository`). Restore logs now break their time
into check, add, apply and finish phases.

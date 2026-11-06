# Git changes and review

**What it is.** Changes shows comparison-specific diffs and counts. Merge
conflicts resolve in place, as ordinary edits; staging, committing and history
operations stay separate actions.

**Reach.** Select the workspace and open Changes. Inspect All, Uncommitted,
Staged and Unstaged independently. A conflicted file's card, and the file in
Files, show each conflict block with its accept row and a navigator.

**Drive.** In a disposable repository, change a small tracked file and inspect
its diff. Stage that file if staging is part of the task and verify the Staged
and Unstaged views. For a conflict, open the file in Files: **Accept current
change**, **Accept incoming change** and **Accept both** rewrite one block as
an ordinary edit that ⌘Z undoes, and the file saves like any other. Git keeps
listing it as conflicted until it is staged, and Diff view waits until then.

**Linux fixture.** Open `harness-file-editor.html?owner=personal&reset`; wait
for `window.__fileEditor`, write conflict text with
`window.__fileEditor.external("conflict.ts", text)` and open it with
`window.__fileEditor.open("conflict.ts")`. The **Conflicts** group reads
`1 / 2`; accept a block, press ⌘Z, and confirm
`window.__fileEditor.disk("conflict.ts")` after autosave. The full driver is
`scripts/ui-smoke-git-review-actions.mjs`, scenario `git-review-actions`.

**Observable end state.** The file on disk holds the chosen sides and no
markers, written through `file.write`; no other operation runs. Each comparison
displays its own rows/counts, and All supplies the Changes badge. Capture the
editor and record source readback for any real write.

**Gotchas.** A target-branch picker only changes metadata. Rebase, merge,
autostash and pushes require their own explicit task action. An added-then-deleted
path contributes 0/0/1/1 to All/Uncommitted/Staged/Unstaged. Markers that cannot
all be paired show one notice and no accept rows. Cloud Git operates through its
worker and source authorization; the fixture does not prove native Git or GitHub
writes.

Sources: `apps/desktop/src/renderer/shell/workbench/tabs/code-editor/merge-conflict-blocks.ts`,
`apps/desktop/src/renderer/features/code-review/merge-conflict-pierre.tsx`,
`apps/desktop/src/renderer/harnesses/harness-file-editor.tsx`.

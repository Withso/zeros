# Git changes and review

**What it is.** Changes shows comparison-specific diffs and counts. Review
decisions are separate from staging, committing and history operations.

**Reach.** Select the workspace and open Changes. Inspect All, Uncommitted,
Staged and Unstaged independently. Open a changed file and its review controls.

**Drive.** In a disposable repository, change a small tracked file and inspect
its diff. Stage that file if staging is part of the task and verify the Staged
and Unstaged views. **Accept** records a review decision while keeping source.
**Reject** can change source: open its confirmation, then Cancel/Escape for a
non-destructive check. Run a confirmed rejection only on your disposable edit.

**Linux fixture.** Open `harness-git-review-actions.html`; wait for
`window.reviewActionsFixture.ready` and visible **Accept**/**Reject** buttons.
Click Accept, await **Accepted**, and confirm
`window.reviewActionsFixture.disk()` is still `before\nchanged\nend\n`.
Reload, open Reject, verify Cancel has focus, press Escape, and verify Reject
regains focus with no review request. The full driver is
`scripts/ui-smoke-git-review-actions.mjs`, scenario `git-review-actions`.

**Observable end state.** The review decision and source contents agree with
the chosen action; Cancel performs no write. Each comparison displays its own
rows/counts, and All supplies the Changes badge. Capture the decision/diff and
record source readback for any real write.

**Gotchas.** A target-branch picker only changes metadata. Rebase, merge,
autostash and pushes require their own explicit task action. An added-then-deleted
path contributes 0/0/1/1 to All/Uncommitted/Staged/Unstaged. Stale content must
refuse a confirmed destructive review. Cloud Git operates through its worker and
source authorization; the fixture does not prove native Git or GitHub writes.

Sources: `apps/desktop/src/renderer/features/code-review/hunk-review-actions.tsx`,
`apps/desktop/src/renderer/harnesses/harness-git-review-actions.tsx`.

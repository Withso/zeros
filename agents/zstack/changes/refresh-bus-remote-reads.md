# Local refresh generations must not re-read remote or ignored state

Symptom: while an agent built and tested, the engine logged slow
gh.prInlineReview, gh.prReviewDiff, gh.prChecks and git count operations every
poll, and a Review tab re-downloaded the PR from GitHub every ~1.5 s.
Cause: one refresh bus carried every worktree write, including churn in
Git-ignored build output and redirected command logs (`dist/`, `coverage/`,
`.context/*.log`). Consumers of remote state (the published PR diff, inline
review, PR metadata) treated each generation as a reason to call GitHub.
Rule: a watcher reports only paths that can change a Git view; Git (not a name
heuristic) decides what is ignored, and Zeros-owned recognition inputs inside
ignored folders stay watched. Remote reads key on their own identity (head and
base SHAs) plus bounded intervals; a local generation may at most trigger a
throttled read with a trailing refresh.
Encoded by: watch.test.ts (ignored folders, folders created later, `.zeros`
recognition), ui-smoke-review-comparison.mjs local-refresh scenario, and
review-data-race.test.ts (refresh-key spacing).
Proposed target: docs/ui-interaction-performance.md, refresh bus consumers.

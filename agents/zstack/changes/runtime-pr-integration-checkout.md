# Integrating a runtime PR from a co-master's frozen patches

- Symptom: after applying a co-master's patch that moved the cloud worker to
  a new Claude SDK, the worker's contract test failed in the integration
  checkout while it passed in the co-master's worktree. Later, the PR showed
  a wall of failed checks minutes after a push.
- Cause: the integration checkout was installed before the lockfile change,
  so `apps/cloud-worker/node_modules` still held the old SDK without the new
  exports. The failed checks were roll-ups of a CI run cancelled because a
  label (`ci:ui-smoke`, then `agent-runtime:hold`) was added after the push.
- Rule: reinstall with `pnpm install --frozen-lockfile` after integrating a
  lockfile change, and apply labels before the final push. A run cancelled
  this way is not a failure; read the newest run for the same head.
- Encoded in `playbooks/integrate-pr.md` steps 2 and 7.

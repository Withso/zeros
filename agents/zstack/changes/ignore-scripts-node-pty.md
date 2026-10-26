# Rebuild node-pty after an install that skips scripts

- **Symptom.** A clean-tree worker verification failed PTY tests because its
  native `node-pty` binding was absent.
- **Cause.** The dependency install used `--ignore-scripts`, which skips the
  native build even though package resolution succeeds.
- **Rule.** Before qualifying the worker's PTY tests after that install, run
  `pnpm --dir apps/cloud-worker rebuild node-pty`, then rerun the worker suite.
  Record the initial prerequisite failure and the subsequent result; do not
  treat missing native bindings as a product regression or a passing check.
- **Encoded in.** The existing worker tests under
  `apps/cloud-worker/src/terminals/__tests__/` exercise the native binding.
  Setup guidance is in `skills/zstack-verify/SKILL.md`.

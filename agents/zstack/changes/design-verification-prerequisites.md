# Design verification prerequisites

- **A new workspace failed required gates for environment reasons.** Its setup ran only `pnpm install`,
  so `pnpm typecheck` lacked the control-plane dependencies and Playwright suites lacked Chromium. Install
  all three dependency graphs, and rerun failures in a clean base checkout before blaming the diff
  (`zstack-verify`).

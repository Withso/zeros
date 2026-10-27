# Dependency automation gaps

Advisories against zod, body-parser and Electron produced no bot PRs. Renovate's
Dependency Dashboard had not updated for more than 15 hours, and the agent runtime
radar was off (`ZEROS_AGENT_RUNTIME_MODE` unset). Renovate's only open security
PR stayed red because it cannot regenerate `THIRD-PARTY-LICENSES.txt`. The CI
audit is `--prod`, so it never saw Electron, a devDependency shipped to every
desktop user. Nothing tracked the gitleaks container digest, and Bun floated
to its latest release in the workflows that compile the shipped engine.

Before relying on automation for a fix, read the dashboard's last update and
the radar mode. Push regenerated licenses to bot PRs, or supersede them. Treat
Electron as production when triaging advisories. Every toolchain or container
pin needs an updater that can read it.

Encoded in `renovate.json` (same-major Electron updates; a gitleaks custom
manager), pinned `bun-version` in workflows,
`scripts/__tests__/renovate-coverage.test.ts`, `playbooks/ci-red.md` and case
`renovate-toolchain-pin-coverage`.

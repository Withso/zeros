# Keep browser runners within the pinned Playwright platform inventory

- Symptom: all Linux Vitest and UI-smoke shards failed before executing tests
  when GitHub moved `ubuntu-latest` to Ubuntu 26.04.
- Cause: the lockfile-pinned Playwright 1.59.1 has no Chromium dependency
  inventory or download for Ubuntu 26.04. A mutable runner alias advanced
  independently of the browser dependency.
- Rule: pin browser workloads to a supported Ubuntu release and change CI and
  Preflight together. Validate the runner against the installed Playwright's
  platform inventory; do not skip browser setup or weaken the test selection.
- Encoded in `scripts/__tests__/ci-workflow-parity.test.ts`, the pinned
  Linux assertion in `scripts/__tests__/vitest-ci-provisioning.test.ts`, and
  the Ubuntu 24.04 pins on both workflows' Vitest and UI-smoke jobs.

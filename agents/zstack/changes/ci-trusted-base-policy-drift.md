# Trusted-base hourly policy drift

- Symptom: every selected PR workload passed, but the aggregate gate returned
  `hourly_unavailable` after a new infrastructure E2E profile ran on main.
- Cause: PR CI intentionally loads its hourly reader from the event's trusted
  base SHA. The old reader rejected the new job name even though current main
  already contained the compatible reader and regression coverage.
- Rule: compare the failing gate's policy revision with the workflow producing
  its input. Integrate an already reviewed compatibility fix and run fresh PR
  CI; rerunning the old event retains its old policy revision.
- Encoded in: `playbooks/ci-red.md` and the retained success/failure
  infrastructure profile regressions in
  `scripts/__tests__/zeros-dev-hourly-actions.test.ts`. Both fail against the
  older reader and pass with main's existing fix.

# Alpha release metadata retry

The rolling Alpha feed stopped at an intermittent GitHub release-object HTTP
500, before uploading the signed assets. Later unchanged-source publications
succeeded. The cumulative ledger is an asset, not the failing metadata body;
there was no evidence that the retained target argument caused the failure.

Retry only the same idempotent metadata edit on an exact release-object 5xx,
at most three attempts with 1 s and 2 s backoffs. Preserve the publication lock,
original job lifetime, cancellation, signed producer and asset/tag ordering.
Keep other errors terminal and provider text out of diagnostics. A terminal
release failure still requires a full rerun or a new push.

The regression executes the actual workflow step with synthetic subprocesses.
It first exposed shell startup prepending an ambient CLI wrapper; fixtures now
set their executable path after shell startup and assert resolution before
running the step, using an explicit credential-free environment. That setup
failure is distinct from the retained HTTP 500 regression.

Encoded in `scripts/release/alpha-release-edit*.test.ts`,
`evals/cases/alpha-release-edit-retry.json`, `playbooks/ci-red.md`, and
`docs/deployment-environments.md`.

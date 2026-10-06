# Main Preflight concurrency

Main pushes share one Preflight concurrency group, `preflight-main`, with
cancellation off. GitHub keeps the run in progress and at most one pending run.
A newer push replaces the pending run, which completes as `cancelled` without
starting any job. The newer run tests the replaced commit too, because main
contains every earlier merge. A run in progress is never cancelled.

Release-branch pushes and merge-group events keep their own per-ref groups and
cancel their own superseded runs. They never wait behind main. Pull-request CI
does not use the main group.

## Why main coalesces

GitHub Free allows 20 concurrent jobs, five of them macOS, shared by the whole
organization. One full Preflight per merge filled that pool during merge
bursts: older runs, already superseded for Alpha, held runners while the
newest commit's jobs waited. Coalescing keeps at most one main Preflight
active, so pull-request CI and the newest main commit get runners sooner.

## Consequences

- **Coverage.** Every merge is tested, sometimes together with later merges.
  The culprit of a failure can be any commit since the last green main run;
  CI Recovery's incident body links that compare range. Replaced runs have no
  jobs and never open an incident.
- **Alpha.** Automatic Alpha needs its candidate's exact-SHA `alpha-gate`. If
  the candidate's pending run was replaced, the barrier supersedes it once
  main has moved on: a green skip before any destination mutation, instead of
  waiting for the barrier timeout. The newer commit's Alpha run ships the
  combined change.
- **Latency.** A merge can wait for the main run already in progress before
  its own run starts. Alpha therefore ships at most about once per Preflight
  run during a burst.
- **Releases.** Beta and Production read Preflight on their release branch's
  exact commit, which coalescing never touches.

## Validation

`scripts/__tests__/preflight-concurrency.test.ts` evaluates the group and
cancellation expressions for main, release and merge-group contexts and
asserts that no Preflight or CI job has job-level concurrency.
`pnpm check:actions` runs the parsed-YAML validator before actionlint. The
validator allows `queue` only on the manual Concurrency Canary job, whose one
successful dispatch proved that GitHub accepts job-level `queue: max`.
actionlint 1.7.12 ignores only the exact unknown `queue` diagnostic in that
canary file; remove the exception when the pinned actionlint supports the key.

GitHub's documented semantics are in [Control the concurrency of workflows and
jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

# Main Preflight concurrency

Every push to `main` gets an independent full Preflight run. Its concurrency
group is `preflight-main-${{ github.run_id }}`, with cancellation off. Distinct
run IDs let newer pushes proceed while every older active or pending run stays
eligible to finish. Rerun attempts retain their original run ID and group.

Release-branch pushes and merge-group events keep their own per-ref groups and
cancel their own superseded runs. They do not share main's groups. Pull-request
CI retains per-PR cancellation and its existing job-selection behavior.

Cloud Runner Qualification also uses an independent, non-cancelling
`cloud-runner-main-${{ github.run_id }}` group for every main push. Its PR and
merge-group runs retain their existing per-ref cancellation. The isolated
BuildKit builder still limits memory to 4 GiB with swap disabled, CPU to two
cores and internal parallelism to two; those limits protect each runner's
resources.
Workflow Checks runs actionlint on every main push, with no push path filter,
and keeps its unfiltered PR and merge-group triggers.

## Runner capacity

The organization's GitHub Enterprise plan permits **500 total concurrent
standard runner jobs, including up to 50 macOS jobs**, shared across workflows.
These are job limits, not workflow limits: each running matrix leg or aggregate
job consumes a runner slot. Preflight and pull-request CI have no job-level
concurrency or matrix `max-parallel` caps. Available runner capacity controls
scheduling, so jobs can still queue when the shared pool is occupied.

## Consequences

- **Coverage.** Every main push has its own exact-SHA Preflight evidence with
  the existing full workload profile, shard matrices and safety checks. CI
  Recovery continues to link the commit range since the last green main run;
  a failure can still involve an earlier merge in that range.
- **Alpha.** Automatic Alpha needs its candidate's exact-SHA `alpha-gate`. If
  main advances, candidate supersession and destination-mutation guards remain
  in force. The release barrier retains compatibility with cancelled pending
  runs from the previous coalescing policy; it can skip a superseded candidate
  before any destination mutation.
- **Latency.** A newer main run can start alongside older runs as runners
  become available. Its critical aggregates can admit Alpha without waiting
  for an older Preflight to finish. Runner capacity and Alpha promotion
  coordination still affect delivery time.
- **Releases.** Beta and Production read Preflight on their release branch's
  exact commit, with the same release-branch cancellation semantics.

## Validation

`scripts/__tests__/preflight-concurrency.test.ts` evaluates the group and
cancellation expressions for distinct main runs, rerun attempts, release and
merge-group contexts. It also preserves the full job inventory and shard
matrices and asserts that no Preflight or CI job has job-level concurrency or
`max-parallel` caps. CI/Preflight workload parity remains covered by
`scripts/__tests__/ci-workflow-parity.test.ts`.

The concurrency suite also verifies independent main Cloud Runner Qualification
runs, its retained PR/merge-group cancellation and BuildKit limits, and
Workflow Checks' unfiltered main trigger.

`pnpm check:actions` runs the parsed-YAML validator before actionlint. The
validator allows `queue` only on the manual Concurrency Canary job, whose one
successful dispatch proved that GitHub accepts job-level `queue: max`.
actionlint 1.7.12 ignores only the exact unknown `queue` diagnostic in that
canary file; remove the exception when the pinned actionlint supports the key.

GitHub's documented semantics are in [Control the concurrency of workflows and
jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

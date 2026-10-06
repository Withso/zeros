# Bounded post-merge concurrency

Preflight keeps its full job inventory for every main push. Its workflow-level
main group is unique to each run, so newer merges do not cancel or replace older
SHAs. Alpha-critical producers, including all control-plane database shards,
receive no job-level concurrency group.

## Canary rollout

Ship the Concurrency Canary workflow, actionlint configuration, validator and
tests as the first commit set, leaving Preflight unchanged. After that change
lands on the default branch, the repository owner dispatches it once:

```sh
gh workflow run concurrency-canary.yml
```

Confirm that GitHub creates the run and that its `queue-canary` job completes
successfully. A dispatch response alone does not prove workflow validation.
The canary has no automatic trigger, checkout, secrets or token permissions.
If GitHub rejects `queue`, only this canary file is affected.

Ship Preflight bounding in a **separate follow-up commit set and PR only after
that canary run is accepted and succeeds**. The prepared follow-up changes only
the two heavy jobs' concurrency blocks and adds their lint exception and
contract tests. Do not merge both commit sets together before acceptance.

## Main-push capacity contract

The follow-up gives each of the three composer shard indices its own shared
main group. The macOS workload uses two shared main groups, selected by the
parity of `github.run_number`. Across overlapping main runs, these groups permit
at most **three composer jobs plus two macOS jobs**, or five heavy jobs total.
One SHA still runs each composer shard and its macOS workload exactly once.

Release-branch pushes, merge-group events and any other event use separate
event/ref/run/attempt groups. They cannot enter main's heavy queues and gain no
new shared job limit. Existing workflow cancellation policy for those events
is unchanged. Pull-request CI does not use the heavy groups.

Each shared job group uses `queue: max`, which retains up to 100 pending jobs
instead of replacing pending SHAs. No queued group can use cancellation.
GitHub processes entries by when they start waiting on that group; workflow
dispatch or merge order is not guaranteed. Above 100 pending entries in a
group, GitHub cancels overflow. Keep traffic below that limit so every main
SHA retains complete evidence.

On GitHub Free's shared 20-job / 5-macOS quota, bounding the heavy lanes leaves
more capacity for quality, Vitest, build, control-plane, secret-scan and Alpha
work. These groups reserve no runner slots and provide no global scheduling
priority. Other workflows and sustained overload can still delay producers.

Warn when reconstructed heavy depth exceeds 5 or the oldest eligible job has
not started for 15 minutes. Treat depth above 10, age above 20 minutes, any
overflow, or missing/cancelled mandatory main evidence as an incident. Meter
traffic or add qualified capacity if producers' eligibility-to-start delay
p90 exceeds two minutes. That delay includes orchestration and provisioning;
it is not a measurement of pure concurrency-group wait.

## Local and CI validation

`pnpm check:actions` runs the parsed-YAML concurrency validator before
actionlint. The root Vitest suite also validates every repository workflow and
tests rejection of unauthorized jobs, workflow-level queues, unsupported
values and cancellation. actionlint 1.7.12 ignores only the exact unknown
`queue` diagnostic in the files using it; all other syntax, expression and
ShellCheck findings remain errors. Remove those exceptions when the pinned
actionlint release supports the key.

GitHub's documented semantics are in [Control the concurrency of workflows and
jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

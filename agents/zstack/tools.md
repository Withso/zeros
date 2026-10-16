# zstack verification and replay

These tools help an agent run the existing engineering checks and record what
they proved. They do not change required CI statuses, deploy anything, or merge
PRs. Local Personal and organization-local checks use the same app driver;
cloud verification uses the existing Alpha fixture and hourly workflow.

## Plan and verify a change

```sh
node scripts/zstack/verify.mjs plan --test scripts/__tests__/zstack-runner.test.ts
node scripts/zstack/verify.mjs run --test scripts/__tests__/zstack-runner.test.ts --execute --receipt /private/scratch/verify.json --mode master-subagents --agent 'GPT-6 Astra' --master Claude
```

The default mode is `single-session`. Record the actual model with `--agent`;
master/subagent mode requires both names. Create the private scratch directory
before running. Receipts use an exclusive, no-follow descriptor, owned mode
0600, and an owned directory that others cannot write. They never overwrite a
prior attempt.

The diff comes from the shared `collectLocalChanges` and `decideScope` policy,
including staged, unstaged and untracked files. A move includes both paths.
Unknown or incomplete Git evidence cannot produce a narrow passing plan.
Commands use fixed argv recipes: registry prose and caller-supplied JSON plans
are never shell-evaluated. Explicit test paths must exist within the checkout.
The tool finds conventional same-directory, `__tests__`, and script-name tests;
use `--test` for semantic adjacency it cannot infer.

Required local gates always include typecheck, lint, UI policy and the secret
scan. `test:git` is filtered to adjacent files; CP tests run in their package.
Applicable static `check:*` recipes come from the selected registry. Full root
and CP suites, packaging, qualification, browser and platform proofs remain in
the `ci`/`unverified` lists unless explicitly run through their existing path.
There is no claim that local success replaces CI success.

Every source file's bytes and mode contribute to a fingerprint. Credential,
Git-private and scratch paths are excluded without being read. The tool
checks the fingerprint before and after each command and stops on a change.
Recipes stop at their first failure, with a ten-minute per-command deadline,
an 8 MiB output bound and TERM/KILL cleanup for their process group. Child
output is hashed and discarded; receipts retain argv, counts, times and closed
results. The checks run trusted repository code as the current user. This is
process containment and evidence collection, not an OS security sandbox.

Local receipts are unsigned. Source fingerprints bind an observation, not a
trusted CI attestation. Tokens/cost are `null` when the host does not provide
them; no estimate is invented. Keep receipts outside the checkout.

## Local and cloud scenarios

```sh
node scripts/zstack/verify.mjs local-ui --shard 1/3
node scripts/zstack/verify.mjs cloud-health --source <intended-main-sha>
node scripts/zstack/verify.mjs cloud-dispatch --source <intended-main-sha>
node scripts/zstack/verify.mjs cloud-status --source <intended-main-sha>
```

Each command plans by default. Add `--execute --receipt <file>` only for the
verification authorized by the task. `local-ui` invokes `pnpm test:ui-smoke`,
the existing Playwright app driver, with a twenty-minute deadline. A shard
does not claim the remaining shards, and Linux never claims macOS engine
smoke. The driver retains the app's Local and cloud fixture scenarios.

Cloud helpers require the hourly workflow/helpers from PR #493. Health uses
the Alpha-only zeros-dev contract and its canonical credential store. Dispatch
uses `pnpm agent:gh workflow run zeros-dev-e2e.yml --ref main`; model keys stay
in Actions. It reports `dispatch_requested`, with no invented workflow run ID
and no E2E pass. Concurrent dispatches cannot be correlated from that response.
Status makes bounded public Actions reads and reuses the canary's trusted-run,
executed-lifecycle and completion-freshness checks. Only the expected main SHA
can pass, and a newer active run leaves completed evidence in force. This
qualifies that main source, not uncommitted local changes.

The hourly job preserves signed cleanup receipts and names its failing stage.
Use the existing receipt download and recovery procedure in `docs/zeros-dev.md`
for product-stage diagnostics; this wrapper neither imports an untrusted
artifact into the fixture nor treats an unsigned local receipt as its signed
cleanup authority. No fixture mutation occurs during a plan or status read.

## Replay and seeded checks

```sh
node scripts/zstack/eval-replay.mjs --case repository-name-casing
node scripts/zstack/eval-replay.mjs --case repository-name-casing --execute --receipt /private/scratch/replay.json
node scripts/zstack/eval-replay.mjs --case seeded-cache-generation --case seeded-foreign-writer-inventory --revision <full-source-sha> --execute --receipt /private/scratch/seeds.json
```

Only bounded Vitest recipes are executable initially: exact files, the root
or release config, the CP package, and an optional literal test-name filter.
Python, arbitrary shell chains, live scenarios and unknown commands remain
unsupported. Each side has a two-minute deadline; at most 32 selected cases
run sequentially. `--allow-pending` is author validation only: a pending replay
cannot resolve to a commit. Seeds still require an explicit immutable revision.
If `--all` exceeds 32 cases it refuses with `zstack_case_limit`; use explicit
case batches. It never silently truncates the corpus to satisfy the bound.

Replay reads Git objects without changing the index, refs or working tree.
It copies up to 256 MiB into private temporary projections, excludes credentials
and Git metadata, and reuses installed external dependencies only when the
lockfile matches. Workspace-package links resolve into each projection. The
fixed test files are identical on both sides; product helpers and configuration
remain historical. Missing historical imports stay unverified. Projections
are deleted in `finally`, including after cancellation and failed checks.

`caught` means the fixed tests passed and the same assertion identities failed
on the parent or seeded tree. `missed` means the parent passed. `unverified`
means the runner could not establish that comparison, including skipped-only
suites, imports, missing tools or timeout. Raw assertion messages are excluded
from receipts. Repeated parameterized names include their occurrence in the
identity, so a passing sibling cannot authorize a skipped row. Prerequisite
classification uses the primary missing-host-tool, disk-full or test-timeout
diagnostic; arbitrary ENOENT, EACCES or module errors and quoted assertion text
can be product failures and are not suppressed by a keyword match.
`--baseline` compares immutable case inputs, catches and the
overall catch rate; it refuses dropped cases or a lower rate. Do not remove
unverified cases to improve the score. This measures regression-check catches,
not the precision/recall of an LLM code reviewer.

Closed failures include `diff_incomplete`, `adjacent_tests_required`,
`source_changed`, `deadline`, `output_limit`, `cancelled`,
`test_report_invalid`, `test_environment_failed`, `zstack_revision_unavailable`
and `zstack_dependencies_unavailable`. The receipt retains the original result
when a later attempt succeeds; create a new output file for each attempt.

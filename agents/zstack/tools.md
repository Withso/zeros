# zstack verification and replay

These tools help an agent run the existing engineering checks and record what
they proved. They do not change required CI statuses, deploy anything, or merge
PRs. Local Personal and organization-local checks use the same app driver;
cloud verification is the deployed Dev gate0 probe.

## Plan and verify a change

```sh
node scripts/zstack/verify.mjs plan --test scripts/__tests__/zstack-runner.test.ts
node scripts/zstack/verify.mjs run --test scripts/__tests__/zstack-runner.test.ts --execute --receipt /private/scratch/verify.json --mode master-subagents --agent 'GPT-6 Astra' --master Claude
```

The default mode is `single-session`. Record the actual model with `--agent`;
`master-subagents` and `co-masters` require both model names (`--agent`, `--master`).
The latter records a peer pair without claiming subagents. Create the private scratch directory
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
scan. `test:git` is filtered to adjacent root files; control-plane and cloud-worker
tests run with their own package configs. A mixed selection runs each group.
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

## Local UI and live cloud proof

```sh
node scripts/zstack/verify.mjs local-ui --shard 1/3
```

The command plans by default. Add `--execute --receipt <file>` only for the
verification authorized by the task. `local-ui` invokes `pnpm test:ui-smoke`,
the existing Playwright app driver, with a twenty-minute deadline. A shard
does not claim the remaining shards, and Linux never claims macOS engine
smoke. The driver retains the app's Local and cloud fixture scenarios.

This tool has no cloud driver. The live cloud proof is the deployed Dev gate0
probe, run by the integrator with the task's Alpha authorization:

```sh
pnpm --dir apps/control-plane cloud-v2:gate0 --api "$ZEROS_GATE0_API_URL" --runtime <runtime-sha256>
```

It creates one disposable workspace from the organization's existing Cloud
Computer and checks:

- a native turn for each of Claude, Codex and Cursor;
- terminal, file and Git round trips;
- the mirrored history, including offline reads without a wake;
- one stop and one wake;
- deletion.

It starts a real Boat VM, so run it once per deployed change, not per edit.
Its output names only the failing stage. It never prints response bodies,
URLs or credentials. A green gate0 qualifies that deployed backend and
runtime, not uncommitted local changes.

## Replay and seeded checks

```sh
node scripts/zstack/eval-replay.mjs --case repository-name-casing
node scripts/zstack/eval-replay.mjs --case repository-name-casing --execute --receipt /private/scratch/replay.json
node scripts/zstack/eval-replay.mjs --case seeded-cache-generation --case seeded-foreign-writer-inventory --revision <full-source-sha> --execute --receipt /private/scratch/seeds.json
```

Only bounded Vitest recipes are executable: exact files, the root
or release config, the CP package, and an optional literal test-name filter.
Python, arbitrary shell chains, live scenarios and unknown commands remain
unsupported. Each side has a two-minute deadline and four workers; at most 32
selected cases run sequentially. `--allow-pending` is author validation only: a pending replay
cannot resolve to a commit. Seeds still require an explicit immutable revision.
If `--all` exceeds 32 cases it refuses with `zstack_case_limit`; use explicit
case batches. It never silently truncates the corpus to satisfy the bound.

`node scripts/zstack/eval-corpus.mjs` plans the whole corpus. Add `--execute
--output <new-directory>` to run batches of at most 32 against the committed
`evals/baseline.json`. It retains batch receipts and partial progress, and fails
on dropped/changed recipes, lost catches or a lower rate over the baseline case
set, including its unverified cases. New cases and the overall rate are also
reported. Seeds use HEAD unless `--revision` is supplied. See
`evals/README.md` for provenance and the nightly workflow.

Replay requires Git 2.45+ and locally available fix/parent commits. Ordinary
workspace verification does not require the replay-only Git flag. Replay preserves
the index, refs and working tree. Full clones use local objects. In a partial
clone, execution discovers a promisor remote and fetches missing trees/blobs in
batches of at most 4096 IDs before local-only `cat-file` reads. `--refetch`
bypasses stale commit-graph negotiation; one lazy fetch per blob can otherwise
fail on a missing commit-graph object or exhaust the read deadline. Fetches have
a three-minute deadline per batch, write no refs or FETCH_HEAD, and require the
host's Git access. Missing non-promised objects remain `zstack_git_unavailable`.

Each projection copies at most 256 MiB, excluding credentials and Git metadata.
Root and standalone pnpm graphs are checked independently against the actual
installed lock, manifests, workspace settings and patches. Matching complete
installs are reused. Otherwise, execution installs the historical graph with
`--frozen-lockfile --offline` from the shared pnpm store, then retries online on
a store/install miss. Both closed outcomes stay in the cache entry's metadata;
raw child output is hashed and discarded. A graph gets ten minutes total.
Installs use the same credential-free environment as checks.

The default cache is `~/.cache/zeros-zstack-dependencies`; `--dependency-cache`
selects another owned, canonical directory outside the checkout. Keys include
the lock hash, install inputs, platform, architecture and Node ABI. At most eight
graphs and 8 GiB are retained (the shared pnpm store has its own lifecycle).
One installer holds the cache lock. Live projections lease entries; eviction
removes the least recently used unleased entries. A graph that cannot fit fails
closed, and failed installs leave no ready entry. Stop the replay before manually
removing its cache. Workspace-package links always resolve into the projection.

Fixed tests are identical on both sides; helpers and configuration stay
historical. Missing historical imports stay unverified. Cleanup deletes
projections and releases their cache leases, including after failed checks.
`area` uses the closed owner vocabulary in `evals/README.md`; an incident title
is not a new subsystem. Frozen `git show <sha>:<path>` rule references keep old
lessons readable after a pack consolidation.

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
and `zstack_dependencies_unavailable`. Cache refusals use
`zstack_dependency_cache_unsafe`, `zstack_dependency_cache_busy` or
`zstack_dependency_cache_limit`. The receipt retains the original result
when a later attempt succeeds; create a new output file for each attempt.

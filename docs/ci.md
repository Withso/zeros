# Pull-request CI and full Preflight

`CI` (`.github/workflows/ci.yml`) selects whole existing workloads for pull
requests. `Preflight` (`.github/workflows/preflight.yml`) retains full post-merge
and release-evidence behavior. Selection preserves workload commands, shards,
runners, database reports, and artifacts.

The ruleset still requires `quality`, `test`, `build`, `source-sync (macOS)`,
`control plane`, `ui-smoke (composer)`, `secret scan (PR commit range)`,
`actionlint`, and `codeql`. Every PR reports those contexts. `zeros/ci-gate`
is an additional aggregate for a future ruleset migration; it is not required
by this change. Actionlint and CodeQL retain their separate workflows.

## Independent full coverage

`Full CI` (`.github/workflows/ci-full.yml`) runs alongside the required PR
checks. It calls the existing Preflight workflow for every PR, including
documentation-only changes, with all four database shards enabled. This runs
the complete Linux tests/build, macOS source-sync workload, three composer
browser shards, dependency audits and source/security contracts even when the
fast PR classifier does not select them. The shared workflow definitions keep
commands and future coverage changes in one place.

The existing required CI job remains the single PR commit-range secret scanner.
Full CI omits that duplicate scanner and the Alpha-only admission aggregate;
neither omission drops a test or permits the assurance run to admit a release.

Full CI also calls the existing native ABI, unsigned Electron packaging,
packaged-engine/PTY smoke and runtime-drift checks on every PR and every push
to main or a release branch. Their weekly and manual entrypoints remain
available. Main and release pushes already run Preflight directly, so Full CI
does not duplicate that full graph on pushes.

These additional checks have `Full suite / ...` and `Extended checks / ...`
names. They are independent of the existing required contexts and
`zeros/ci-gate`; merging does not wait for them. Failures remain visible in
Actions and on the PR. CI Recovery continues to monitor full main Preflight;
it does not automatically open incidents for the separate extended checks.
Beta and Production still require successful exact-source Preflight and
CodeQL evidence. A PR assurance run is not release evidence: its workflow
path, event and tested merge commit differ from the authenticated push runs.

All reused verification jobs have read-only tokens, no inherited secrets and
no protected environments. Fork PRs use `pull_request`, never
`pull_request_target`. Credentialed live-provider qualification and deployment
workflows retain their explicit operator triggers; they are not safe to run
against arbitrary PR source. Runtime drift reports stale pins but fails broken
ones, as before.

CodeQL runs its `security-and-quality` suite across all JS/TS sources on PRs,
main and release pushes. This includes every query in `security-extended` and
adds maintainability and reliability analysis. Findings remain Code Scanning
alerts; the required `codeql` context proves successful analysis, not that
there are no alerts. See [GitHub's query suite definitions](https://docs.github.com/en/code-security/code-scanning/managing-your-code-scanning-configuration/codeql-query-suites).

Different PRs and main pushes can use the Enterprise runner pool concurrently.
Only obsolete runs of the same PR are cancelled. Extra capacity does not remove
job dependencies, runner provisioning time or release destination locks; see
[CI concurrency](ci-concurrency.md).

## Trusted workflow selection

The `scope` job checks out full history and extracts `scripts/ci/scope.mjs`,
`scope-rules.json`, and `control-plane-scope.mjs` with `git show` at the PR's base
SHA. It puts them together in `$RUNNER_TEMP/ci-policy/`, preserving relative
imports, and runs the trusted classifier with `--mode pr` against the candidate
checkout. PR copies of the policy never authorize skips. Event identities and
`LABELS_JSON` enter through `env:`; the workflow uses `pull_request` and
`contents: read` permissions.

The classifier owns path and label selection through the registry below.
CI validates the `zeros.ci-selection/v1` ledger and output format, forwards the
classifier ledger unchanged, and consumes only the classifier's `job-*` outputs.
It does not translate path lanes or interpret labels itself. Missing, duplicate,
unknown, inconsistent, or malformed outputs fail scope before any output is
published.

If any trusted policy file is missing, CI emits the same ledger schema with
`policy_digest: null`, an empty `lanes` map and `requests` list, a
`missing-policy:` reason, and every job selected except `ui-smoke`. Without a
trusted classifier, label requests cannot be interpreted and composer remains
off. A present policy that crashes or lacks the job-output contract fails
scope; it does not receive this missing-file fallback. Land the classifier
contract before the selective workflow.

`quality`, `test`, `source-sync`, and `control-plane` always run as required
aggregates. The required `quality` job runs `recovery.mjs guard-markers` before
validating the selected `quality-workload` result. The marker guard runs even
on documentation-only PRs and after a failed scope decision, without installing
dependencies or running unselected typechecks and lint.
The existing database scope is unioned with the trusted `job-control-plane-db`
floor. It can add coverage and cannot subtract it. Selected database shards
still require complete reports and no skipped database tests.

## Lanes and checks

Lane IDs are professional lower-kebab-case names. Every matching rule contributes
its owners; rule order has no precedence. The check registry retains each check's
`always`, `full`, and `any_lanes` predicate and concrete commands. An empty command
list marks a reserved future check, such as the scope-policy guard or isolated
critical browser entry; it does not authorize substituting full composer smoke.

| Lane                     | Ownership or selection                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `docs-only`              | Modified documentation in the audited allowlist                                           |
| `ci-config`              | CI definitions; shared invalidators select the full PR set                                |
| `web`                    | Web hub, handoff, Functions, and shared web inputs                                        |
| `marketing`              | Marketing source and shared web/token/schema inputs                                       |
| `control-plane`          | Control-plane static checks and their shared inputs                                       |
| `control-plane-db`       | Imported database input closure from `control-plane-scope.mjs`                            |
| `desktop-renderer`       | Renderer, styles, catalogs, and shared UI inputs                                          |
| `desktop-engine`         | Engine and shared desktop source outside the renderer                                     |
| `electron`               | Electron source and the renderer helpers it imports                                       |
| `packaging`              | Packaging, release contracts, shipped vendor/legal assets                                 |
| `model-catalogs`         | Catalogs and provider/generated protocol tooling                                          |
| `protocol`               | Protocol source and shared catalog contracts                                              |
| `design-containment`     | Design packages, containment, and authored-source tools                                   |
| `cloud-runtime`          | Cloud worker, engine bundle, qualification, and development tooling                       |
| `dependencies-toolchain` | Dependency graphs and toolchain inputs                                                    |
| `repository-contracts`   | Repository layout tests, checked documents, and root script tests                         |
| `smoke-harness`          | Browser smoke scripts, fixtures, and renderer harnesses                                   |
| `macos`                  | Derived from source-sync and unsigned-packaging check predicates, or requested explicitly |
| `runtime-bundle`         | Linux bundle verification, including all browser-harness paths                            |
| `ui-smoke`               | Full composer smoke; explicit PR label or full mode only                                  |

`docs-only` is an additive lane bit, never permission to suppress other lanes.
All-lanes fallback includes it alongside every other PR lane. Added documentation
selects repository layout contracts. Deleting or moving an audited document also
selects its layout owner. An unreviewed modified document remains unknown unless
another explicit rule owns it.

Database input ownership is imported from `CONTROL_PLANE_DATABASE_INPUTS` and
`isControlPlaneDatabaseInput` in `scripts/ci/control-plane-scope.mjs`, whose tests
derive the control-plane import closure. The JSON uses `input_source` predicates
instead of copying that list. Protocol files outside that closure do not select
the database suites merely because they are protocol files.

Browser-harness inputs are `scripts/ui-smoke-*`, `scripts/ui-smoke/**`, and
`apps/desktop/src/renderer/harnesses/**`. They select `runtime-bundle` while leaving
`ui-smoke` off in PR mode. Web verification uses offline typechecks, tests,
`build:standalone`, and `check:deep-link-schemes`. The deployed Pages probe is
excluded from this registry.

The `jobs` map groups check IDs into the existing workflow workloads. A job is
selected if any mapped check is selected; full mode selects every job. The map
is validated before outputs are written: references must exist, and every
non-advisory check must have a job or an explicit `runs_elsewhere` execution
owner. Shared checks may belong to multiple jobs because their commands span
the existing workload boundaries.

| Job output                 | CI workload                                                                                | Mapped check IDs                                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-quality`              | `quality-workload`, with the always-running required `quality` aggregate                   | `desktop-static`, `ui-source-guard`, `protocol-package-static`, `web-static-and-tests`, `marketing-static`, `release-contracts`, `changed-prettier-advisory`                                                                                                                                                   |
| `job-vitest`               | `test-shard`, with the required `test` aggregate                                           | `root-vitest`, `web-static-and-tests`, `codex-keeper-pin`, `preload`, `design-containment`, `catalog-and-provider-runtime`, `engine-migrations`, `backend-migration-guards`, `dependency-licenses-audit`, `release-and-security-static`, `adapter-fixtures`, `protocol-advisory`, `settings-schema-generation` |
| `job-build`                | `build`                                                                                    | `renderer-build`, `engine-and-electron-build`, `web-and-marketing-build`                                                                                                                                                                                                                                       |
| `job-macos`                | `source-sync-workload`, with the required `source-sync (macOS)` aggregate                  | `source-sync-macos`, `unsigned-packaging-proof`                                                                                                                                                                                                                                                                |
| `job-control-plane-db`     | `control-plane-database`, with report validation in the required `control plane` aggregate | `control-plane-database`, `control-plane-reports`                                                                                                                                                                                                                                                              |
| `job-ui-smoke`             | `ui-smoke (composer)`                                                                      | `composer-full`                                                                                                                                                                                                                                                                                                |
| `job-control-plane-static` | `control-plane-static` and `control-plane-scope`                                           | `control-plane-static` (always selected)                                                                                                                                                                                                                                                                       |
| `job-secret-scan`          | `secret scan (PR commit range)`                                                            | `commit-range-secrets` (always selected)                                                                                                                                                                                                                                                                       |

`tracked-secrets` runs in full Preflight and is also bundled into selected CI
Vitest shards; its independent selection does not force a Vitest workload on
every documentation change. Commit-range scanning stays mandatory on every PR.
Actionlint, CodeQL, cloud qualification, and Alpha runtime-bundle checks record
their separate workflow owners. The unsigned packaging proof runs in Scheduled
and contributes to the macOS workload floor. The reserved critical-composer
entry has no executable suite yet and is advisory; it never substitutes for
`composer-full`. These execution-owner annotations do not add workflow steps.

## Local preview and additive labels

Run before the final push:

```sh
pnpm ci:plan
```

Local mode compares committed work with the merge base of `origin/main` and `HEAD`,
then unions staged, unstaged, and untracked paths. It prints the base SHA and a
table of lanes, selections, and reasons. Fetch `origin/main` if that comparison
is unavailable. The same fail-closed rules apply to incomplete local evidence.

GitHub's permission to apply labels authorizes these additions, including
maintainer labels on fork PRs. The classifier alone validates the closed
vocabulary and computes additions. Removing a label recomputes optional
coverage while retaining the path floor.

CI runs for `opened`, `synchronize`, `reopened`, `ready_for_review`, `labeled`,
and `unlabeled`. Label changes start a fresh run on the same PR head; per-PR
concurrency cancels its predecessor. Selection uses the event's label snapshot.
It does not provide an immutable merge request or an App-owned merge gate.

| Label                 | Additional selection                           |
| --------------------- | ---------------------------------------------- |
| `ci:full`             | Every PR lane plus `ui-smoke`                  |
| `ci:ui-smoke`         | Full composer smoke                            |
| `ci:macos`            | macOS verification                             |
| `ci:control-plane-db` | Control-plane static and database suites       |
| `ci:packaging`        | Packaging, with dependent execution predicates |
| `ci:web`              | Offline web verification                       |

The vocabulary is closed. An unknown `ci:*` label fails with the supported list;
ordinary labels have no effect. `LABELS_JSON` accepts a JSON array of strings or
GitHub label objects with `name`. Preview requests with:

```sh
LABELS_JSON='["ci:web","ci:macos"]' pnpm ci:plan
```

`FORCE_FULL=true` or `1` selects every PR lane except `ui-smoke`; `false`, `0`, or an
unset value leaves path selection in place. Only `ci:ui-smoke` and `ci:full` add
full composer smoke in PR/local mode. A selected PR runs the complete serial
composer suite with Preflight's browser setup. Full Preflight retains its three
balanced composer shards and required aggregate after merge on main/release
pushes.

## Fail-closed evidence

PR mode takes `EVENT_NAME` and chooses its base from `PULL_REQUEST_BASE_SHA`,
`MERGE_GROUP_BASE_SHA`, or `PUSH_BEFORE_SHA`. It records `PULL_REQUEST_HEAD_SHA` as
the PR source and checked-out `HEAD` as the tested commit. If set, `GITHUB_SHA`
must match that tested commit. The source commit must exist and be an ancestor
of the tested commit, which permits a synthetic merge checkout.

The classifier requires complete history and an available, nonzero, full base
SHA that is an ancestor of the tested checkout. It runs Git as an executable
with an argument array:

```text
git diff --name-status --no-renames -z <base>...HEAD --
```

Renames are normally add/delete pairs; the parser also accepts explicit rename
records and unions both owners. Deletions and type changes retain their path
owners. They do not independently select the full set.

Missing, zero, malformed, absent, shallow, or non-ancestor bases; unsupported
events; source/tested identity mismatches; Git errors; invalid UTF-8 or malformed
diff records; an empty diff; more than 300 distinct paths; global invalidators;
and unknown paths select **every PR lane except `ui-smoke`** with a reason. The
300-path limit counts both rename sides and deduplicates paths across local
comparisons. Even an all-lanes path fallback cannot select full composer smoke.

Global invalidators include the root package/lock/toolchain graph, CI definitions,
check scripts, repository rules, and other cross-cutting inputs retained from the
seed. Globs are anchored, case-sensitive POSIX paths: `*` and `?` exclude `/`,
`**` includes `/`, and `**/` permits zero directories. Dotfiles are ordinary
names. There is no brace expansion, negation, or first-match behavior.

Malformed policy, unknown CI labels, invalid forced-selection configuration, or
internal errors exit nonzero and emit no partial lane outputs. CI treats that failure as red. A candidate change to the selector, registry,
or workflows is itself a global invalidator; CI loads trusted baseline code
rather than letting a PR attest to its own skip claims.

## Output contract

```sh
node scripts/ci/scope.mjs --mode pr
node scripts/ci/scope.mjs --mode full
```

PR/full stdout uses GitHub output syntax: one `ledger=<canonical JSON>` line,
followed by one `<lane>=true|false` line per path lane, then one
`job-<id>=true|false` line per workload group. Workflow consumers use the job
outputs directly rather than translating path lanes themselves. Reasons go to stderr and to
`GITHUB_STEP_SUMMARY` when set. Full mode ignores diffs and selects every lane,
including composer smoke.

The v1 ledger contains exactly:

```text
schema: "zeros.ci-selection/v1"
event, mode, base_sha, source_sha, tested_sha, policy_digest, full
lanes: { <registered lane>: <boolean>, ... }
jobs: { <registered job>: <boolean>, ... }
requests: [ <sorted additive labels>, ... ]
reasons: [ <sorted reasons>, ... ]
```

Unknown commit identities are `null`; known identities are full SHAs. Object
keys are sorted recursively, requests are deduplicated, and lane/job values and
`full` are real booleans. The tested identity is confirmed from checked-out
`HEAD`, never inferred from event variables. Full mode preserves the declared
event source (`PULL_REQUEST_HEAD_SHA` for PRs, `GITHUB_SHA` for other events),
falling back to `HEAD` when no source is supplied. A missing checkout leaves
`tested_sha` null while retaining a supplied source SHA.

The SHA-256 policy digest includes the canonical registry
and imported database input list. The ledger is at most 64 KiB; diagnostics retain
up to 40 bounded reasons and an omitted-count reason when needed. Selection never
depends on diagnostic truncation.

The 60-PR replay fixture and per-PR JSON lane/job snapshot live under
`scripts/__tests__/fixtures/ci/`. Replay must keep at least half of the sample
out of all-lanes fallback and select full composer smoke from paths for none.

## Fail-closed job results

Every producer uses `!cancelled()` with a condition that runs when its trusted
job output is selected or scope failed. Its first step fails unless scope
succeeded. The database producer also guards its combined scope. A failed
classifier therefore produces red checks. A cancelled, superseded run starts no
producer, while the required aggregates and `ci-gate` keep `always()` and fail
closed, so a cancelled run never reports a passing required check.
Control-plane static/audit and commit-range secrets remain always selected.

The required aggregates validate raw selections and results before adapting
proved unselected outcomes to their original enforcing commands. They accept
exactly:

| Selected | Job result                                       | Verdict |
| -------- | ------------------------------------------------ | ------- |
| `true`   | `success`                                        | Pass    |
| `false`  | `skipped`                                        | Pass    |
| `false`  | `success`                                        | Pass    |
| `true`   | `skipped`                                        | Fail    |
| Either   | Failure, cancellation, missing or unknown result | Fail    |

`ci-gate` runs with `if: always()` and directly needs every other CI job. It
validates ledger schema, commit identities, job inventory, scope outputs,
mandatory selections, and every result against the same truth table. It also
checks the conservative missing-policy fallback and the effective database
selection. Database report completeness remains enforced by the unchanged
`control-plane-results.mjs` command in the required aggregate.

Verification uses `pnpm check:actions` and the CI, repository-layout, Vitest
provisioning, and database scope suites. The parity test compares every shared
workload with Preflight, mapping its quality commands to `quality-workload` and
comparing the PR composer's setup with the post-merge shard setup. It excludes
explicit PR-only selection steps, adapters, and profile gates while retaining
the Alpha-gate and composer-shard assertions. Workflow tests execute the real trusted classifier in
temporary repositories and cover policy replacement, label additions/removal,
fallback, invalid outputs, database unions, failures, cancellation, and selected
skips.

## Owner merges for CI definitions

CI-definition PRs need an owner merge. Agents must not auto-merge changes to the
paths recognized by `scripts/ci/ci-definition.mjs`: workflows/actions,
`.github/actionlint.yaml`, `.github/CODEOWNERS`, `scripts/ci/**`, `scripts/check-*`,
the explicit Vitest runner, composer entry and `scripts/ui-smoke/**`, release
scripts, root Vitest/ESLint configs, root package/lock/workspace files, and the
control-plane/web package and lockfiles.

List definition paths in a committed diff with:

```sh
node scripts/ci/ci-definition.mjs --base origin/main --head HEAD
```

The command lists sorted paths, including both sides of renames and deletions.
A failed comparison exits nonzero so an unreadable diff cannot authorize an
automatic merge. This is a definition detector, not a repository merge action.

## Agent auto-merge

Agents must arm merges with `pnpm agent:merge <pr-number>`. The wrapper uses
the workspace's own `gh` identity, reads the complete PR diff and open-PR list,
and queries GitHub's required checks. Use `pnpm agent:merge <pr-number> --dry-run`
to print the decision without changing GitHub state. A refusal exits non-zero.

CI-definition PRs require the owner to review and merge them. The shared
`scripts/ci/ci-definition.mjs` policy must export `isCiDefinitionPath(path)`;
the wrapper refuses to arm a merge when that policy is unavailable. Renamed
files are checked under both paths. Drafts, forks, closed PRs, changes to
`.github/ci-incidents/*.json` (including removals), skip markers in PR titles or
bodies, and failed or cancelled required checks are also refused. Pending checks
may wait for GitHub's normal auto-merge requirements.

Only one open PR may have auto-merge enabled. Only a human may override this
guard: first document the justification in a comment on the target PR using the
same human GitHub identity, then run
`pnpm agent:merge <pr-number> --force --reason <comment-URL>`. The wrapper verifies
the comment's author and PR. This flag cannot override any other guard. Agents
must never supply `--force`. The open-PR guard reads a snapshot; avoid concurrent
arming from separate workspaces.

The merge request uses `gh pr merge --auto --squash --match-head-commit` with the
checked head SHA and explicit checked PR title and body. This keeps GitHub's
squash-message defaults or later PR text changes from introducing a skip marker.
Do not call `gh pr merge` or the bot merge command directly.

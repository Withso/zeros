# CI selection

`scripts/ci/scope.mjs` classifies changed paths using the versioned registry in
`scripts/ci/scope-rules.json`. This is a policy seed for the future selective
`CI` workflow. It changes no workflow, required status check, release evidence
identity, publication step, or Beta/Production behavior. Existing Preflight and
CodeQL execution remains in place until a separate workflow rollout.

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

## Local preview and additive labels

Run before the final push:

```sh
pnpm ci:plan
```

Local mode compares committed work with the merge base of `origin/main` and `HEAD`,
then unions staged, unstaged, and untracked paths. It prints the base SHA and a
table of lanes, selections, and reasons. Fetch `origin/main` if that comparison
is unavailable. The same fail-closed rules apply to incomplete local evidence.

Add labels to the PR before the final push so the future workflow receives the
complete request. Labels are additive: removing one cannot remove the path floor.

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
full composer smoke in PR/local mode. In the intended selective workflow, full
composer UI smoke runs after merge through full mode on main/release pushes;
the current workflows are unchanged by this seed.

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
internal errors exit nonzero and emit no partial lane outputs. The future
required gate must treat that failure as red. A candidate change to the selector,
registry, or workflows is itself a global invalidator; the future workflow must
load trusted baseline code rather than let a PR attest to its own skip claims.

## Output contract

```sh
node scripts/ci/scope.mjs --mode pr
node scripts/ci/scope.mjs --mode full
```

PR/full stdout uses GitHub output syntax: one `ledger=<canonical JSON>` line,
followed by one `<lane>=true|false` line per lane. Reasons go to stderr and to
`GITHUB_STEP_SUMMARY` when set. Full mode ignores diffs and selects every lane,
including composer smoke.

The v1 ledger contains exactly:

```text
schema: "zeros.ci-selection/v1"
event, mode, base_sha, source_sha, tested_sha, policy_digest, full
lanes: { <registered lane>: <boolean>, ... }
requests: [ <sorted additive labels>, ... ]
reasons: [ <sorted reasons>, ... ]
```

Unknown commit identities are `null`; known identities are full SHAs. Object
keys are sorted recursively, requests are deduplicated, and lane values and
`full` are real booleans. The tested identity is confirmed from checked-out
`HEAD`, never inferred from event variables. Full mode preserves the declared
event source (`PULL_REQUEST_HEAD_SHA` for PRs, `GITHUB_SHA` for other events),
falling back to `HEAD` when no source is supplied. A missing checkout leaves
`tested_sha` null while retaining a supplied source SHA.

The SHA-256 policy digest includes the canonical registry
and imported database input list. The ledger is at most 64 KiB; diagnostics retain
up to 40 bounded reasons and an omitted-count reason when needed. Selection never
depends on diagnostic truncation.

The 60-PR replay fixture and per-PR JSON lane snapshot live under
`scripts/__tests__/fixtures/ci/`. Replay must keep at least half of the sample
out of all-lanes fallback and select full composer smoke from paths for none.

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

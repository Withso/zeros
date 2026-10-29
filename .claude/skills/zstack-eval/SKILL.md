---
name: zstack-eval
description: "Run and extend zstack's eval cases — escaped Zeros bugs paired with the check that should have caught them — and keep every pack change from lowering the pass rate."
---

<!-- GENERATED from agents/zstack/skills/zstack-eval/SKILL.md by scripts/design-system/build-design-docs.mjs. Edit it there, then run `pnpm design:docs`. -->

# zstack-eval

Real bugs that reached `main` or a live environment are recorded as eval cases.
Add each **new case as its own file**, `agents/zstack/evals/cases/<id>.json`, so
parallel PRs never touch the same file. `cases.json` holds the original cases and
stays readable, but don't append to it. Each case records:

| Field | Meaning |
|---|---|
| `id` | Stable kebab-case identifier |
| `kind` | `replay` (a real fix), `seeded` (a deliberate mutation) or `scenario` (a live Local or cloud flow) |
| `area` | Closed subsystem name from `scripts/zstack/evals.mjs`; ownership map in `agents/zstack/evals/README.md` |
| `fixedBy` | The merge commit that fixed it. The pre-fix tree is its first parent. |
| `symptom` | What was observed |
| `rule` | What the pack now says, and which skill or playbook says it |
| `check` | The command that fails before the fix and passes after it |

## Running

- `node scripts/zstack/evals.mjs --validate` checks every case's shape. Run it
  whenever the pack changes.
- `node scripts/zstack/evals.mjs --list` prints the cases.
- `node scripts/zstack/eval-replay.mjs --case <id>` plans a replay. Add
  `--execute --receipt <file>` to run it. Multiple `--case` arguments select a
  bounded subset; `--all` refuses with `zstack_case_limit` if the corpus exceeds
  32 cases, without dropping cases. For the whole corpus use
  `node scripts/zstack/eval-corpus.mjs`; add `--execute --output <new-directory>`
  to run batches against `evals/baseline.json`. It preserves partial receipts and
  refuses dropped/changed recipes, lost catches or a lower rate over the baseline
  case set. New cases and the overall rate are also reported. Seeds use HEAD by
  default. Provenance and the nightly workflow are in `evals/README.md`.
  Record the same orchestration mode/models as the engineering task; `co-masters`
  uses `--agent` and `--master` for a peer pair with no subagents.
- A replay resolves `fixedBy` only from local commits. `pr:<n>` must map to
  exactly one first-parent mainline commit. It copies source into disposable
  projections, overlays the fixed tests onto the parent, and binds workspace
  dependencies to the projection. It never checks out or moves refs.
- Execution needs Git 2.45+. Missing promised trees/blobs are fetched in batches
  before bounded local reads, with `--refetch` to bypass stale commit-graph
  negotiation. A full clone with its required objects needs no network fetch.
- Root and standalone pnpm locks are independent. Exact installed graphs are
  reused; other historical graphs are installed outside the checkout, offline
  from the shared store first, then online. The default cache is
  `~/.cache/zeros-zstack-dependencies`, or `--dependency-cache <directory>`.
  Keys include lock/install inputs and native ABI; eight graphs/8 GiB are
  retained. Active projections pin entries until cleanup. Cache, install and
  Git failures remain **unverified**, never catches. See `tools.md` for bounds.
- Seeded cases use `evals/seeds/<id>.json` and require `--revision <full-sha>`.
  Each seed replaces one exact source string in the disposable red tree; a
  stale or ambiguous target refuses execution. Product source stays untouched.
- Fixed assertions must pass before the same assertion identities can count
  as red. Import failures, no tests, timeouts, missing dependencies and other
  infrastructure failures are **unverified**. A green parent is **missed**.
  Match repeated parameterized names by occurrence as well as file/name;
  a passing sibling never proves a skipped assertion. A product error such
  as ENOENT is not evidence of a missing host prerequisite by itself.
  A test-only fix may need a separate explicit seed; overlaying its fixed test
  onto both sides does not demonstrate that the old test caught a bug.
- `--baseline <receipt>` refuses dropped/changed cases, lost catches, duplicate
  identities or a lower catch rate. Keep unverified cases in the denominator.
  Report both the actual catches and the verification gaps; validation alone
  is never a replay pass. See `agents/zstack/tools.md`.

## Extending

- Every escaped bug gets a case in the same PR as its fix.
- A subagent that doesn't yet know its PR number writes `"fixedBy": "pending"` and validates with
  `node scripts/zstack/evals.mjs --validate --allow-pending`. The integrator replaces `pending` with `pr:<n>`
  when opening the PR, and with the merge SHA in a later pack update. CI validates strictly, so a
  placeholder can never reach `main`.
- A pack change may not remove a case or make a case's check pass on a
  pre-fix tree.
- Pick an existing `area` by code ownership; adding a subsystem requires updating
  the closed vocabulary and its ownership table. When a lesson is folded out of
  the pack, preserve its historical rule as `git show <commit>:<path>`.

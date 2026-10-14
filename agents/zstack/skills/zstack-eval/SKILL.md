---
name: zstack-eval
description: "Run and extend zstack's eval cases — escaped Zeros bugs paired with the check that should have caught them — and keep every pack change from lowering the pass rate."
globs: "agents/zstack/**,scripts/zstack/**"
---

# zstack-eval

Real bugs that reached `main` or a live environment are recorded as eval cases.
Add each **new case as its own file**, `agents/zstack/evals/cases/<id>.json`, so
parallel PRs never touch the same file. `cases.json` holds the original cases and
stays readable, but don't append to it. Each case records:

| Field | Meaning |
|---|---|
| `id` | Stable kebab-case identifier |
| `kind` | `replay` (a real fix), `seeded` (a deliberate mutation) or `scenario` (a live Local or cloud flow) |
| `area` | Subsystem from the owner map |
| `fixedBy` | The merge commit that fixed it. The pre-fix tree is its first parent. |
| `symptom` | What was observed |
| `rule` | What the pack now says, and which skill or playbook says it |
| `check` | The command that fails before the fix and passes after it |

## Running

- `node scripts/zstack/evals.mjs --validate` checks every case's shape. Run it
  whenever the pack changes.
- `node scripts/zstack/evals.mjs --list` prints the cases.
- Replay execution, which applies the rule to the pre-fix tree and measures
  catch rate, is the next pack milestone (Z1). Until then, use the cases as a
  review checklist: for each case whose area your diff touches, confirm your
  change would not reintroduce it.

## Extending

- Every escaped bug gets a case in the same PR as its fix.
- A subagent that doesn't yet know its PR number writes `"fixedBy": "pending"` and validates with
  `node scripts/zstack/evals.mjs --validate --allow-pending`. The integrator replaces `pending` with `pr:<n>`
  when opening the PR, and with the merge SHA in a later pack update. CI validates strictly, so a
  placeholder can never reach `main`.
- A pack change may not remove a case or make a case's check pass on a
  pre-fix tree.

---
name: zstack-eval
description: "Run and extend zstack's eval cases — escaped Zeros bugs paired with the check that should have caught them — and keep every pack change from lowering the pass rate."
---

<!-- GENERATED from agents/zstack/skills/zstack-eval/SKILL.md by scripts/design-system/build-design-docs.mjs. Edit it there, then run `pnpm design:docs`. -->

# zstack-eval

`agents/zstack/evals/cases.json` lists real bugs that reached `main` or a live
environment. Each case records:

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
- A pack change may not remove a case or make a case's check pass on a
  pre-fix tree.

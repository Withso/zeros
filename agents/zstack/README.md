# zstack: the Zeros engineering pack

zstack is the in-repo engineering loop every agent follows when it works on
Zeros. It applies whether the host is Zeros itself, Claude Code, Codex,
Cursor, Devin, Factory or Conductor. It sits on top of `AGENTS.md`,
`RULES.md` and the existing skills. It adds procedures, evidence rules and
evals, and a learn step that improves the pack after every loop.

The pack is never finished. When a loop exposes a missed check, a flaky gate,
a wrong assumption or a new gotcha, that loop updates the pack in the same
branch.

## Layout

| Path | Contents |
|---|---|
| `skills/<name>/SKILL.md` | Canonical skills. They are generated into `.claude/skills/`, `.agents/skills/` and `.cursor/rules/`. |
| `playbooks/*.md` | Task procedures that the skills load by path. They are not generated. |
| `evals/cases/<id>.json` | Eval cases, one per file. Each one is an escaped bug with the check that should have caught it. `evals/cases.json` holds the original cases. |
| `changes/<id>.md` | Lessons waiting to be folded into `CHANGELOG.md` at the next version. |
| `CHANGELOG.md` | One entry per pack change, recording the lesson that caused it. |

## Skills

| Skill | Use |
|---|---|
| `zstack` | Start here for every task. It records the mode, picks a playbook and runs the loop. |
| `zstack-verify` | Choose and run checks for Local and cloud. Evidence rules. |
| `zstack-review` | Independent review of a diff against Zeros invariants. |
| `zstack-eval` | Run and extend the eval cases. Pack changes must not regress them. |
| `zstack-learn` | End-of-loop retrospective that writes lessons back into the pack. |

## Editing

1. Edit only the canonical files here.
2. Run `pnpm design:docs` to regenerate the provider copies.
3. `pnpm check:ui` fails when a copy is stale; CI already runs it.
4. Put each lesson in `changes/<id>.md` and each new eval case in
   `evals/cases/<id>.json`, one file each, so parallel PRs never conflict. The
   integrator folds fragments into `CHANGELOG.md`.
5. Validate evals with `node scripts/zstack/evals.mjs --validate`.

Changes to safety rules in `AGENTS.md` or `RULES.md`, to CI definitions, or to
credential policy need the owner. Every other pack change goes through normal
review.

## Provenance

The method draws on pstack, Cursor's plugin of Lauren Tan's engineering
practices (github.com/cursor/plugins, MIT, researched at `e43c7ee`). No pstack
text is copied. Where they differ, Zeros' own rules take precedence.

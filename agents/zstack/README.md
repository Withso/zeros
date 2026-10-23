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

For review at the next pack version: [fold proposed playbook lessons from
individual fragments](proposals/lesson-fragments.md). Z1 does not change the
shared playbook anchors or safety ownership.

## Verification tools

`node scripts/zstack/verify.mjs plan` maps the local diff through the shared
CI policy and lists adjacent tests and required local gates. `run --execute
--receipt <file>` executes that plan with source fingerprints, bounded child
processes and a receipt. Full CI suites and native checks unavailable on the
host remain explicitly unverified. See [the tool guide](tools.md).

`local-ui` uses the existing Playwright app driver. There is no cloud driver:
the live cloud proof is the deployed Dev gate0 probe, which the integrator runs
with Alpha authorization (see `zstack-verify`).

`node scripts/zstack/eval-replay.mjs --case <id>` plans an isolated replay.
Execution compares the fixed tests with the fix's first-parent source. Cases
replay at their fix commit, so a `check` may name tests that later work
retired, such as the v1 cloud suites. Seeded
cases have one exact mutation in `evals/seeds/<id>.json`. Replays write counts
and hashes, never raw test output. Missing prerequisites and unsupported
commands stay unverified; a green parent is a miss, not a catch.

## Provenance

The method draws on pstack, Cursor's plugin of Lauren Tan's engineering
practices (github.com/cursor/plugins, MIT, researched at `e43c7ee`). No pstack
text is copied. Where they differ, Zeros' own rules take precedence.

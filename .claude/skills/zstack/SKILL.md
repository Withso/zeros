---
name: zstack
description: "Start here for Zeros work: trace current source, run the smallest check that proves the claim, and report what actually ran."
---

<!-- GENERATED from agents/zstack/skills/zstack/SKILL.md by scripts/design-system/build-design-docs.mjs. Edit it there, then run `pnpm design:docs`. -->

# zstack

Use `AGENTS.md` and `RULES.md` for policy. Use current code, schemas, config and tests for behavior; use `agents/zstack/principles.md` and playbooks only as needed.

## Route

| Task | Playbook in `agents/zstack/playbooks/` |
|---|---|
| Read-only question or plan | investigation.md |
| Bug / feature / behavior-preserving change / sketch | bug-fix.md / feature.md / refactor.md / prototype.md |
| CI red / integration / live Alpha | ci-red.md / integrate-pr.md / alpha-operator.md |
| UI or performance | ui-design.md / performance.md |
| Pack behavior change | skill-eval.md |
| Multi-agent pause or resume | pause-resume.md |

Load helpers explicitly from `agents/zstack/skills/<name>/SKILL.md` when the host cannot invoke them; use `zeros-workspaces` for shared Local/cloud paths. Only a user request starts `zstack-reflect` or `zstack-correct`.

## Fit the host

Use `node scripts/zstack/verify.mjs host` (Devin: add `--host devin`). Start single-session; never spawn without approval. Use host tools only if available; inherit their models unless the user overrides them. Report unsupported overrides instead of substituting. Delegate bounded implementation and at most one risky-work reviewer unless approved otherwise. The primary owns integration and evidence. Without delegation, do a cold review pass.

## Trace, prove, deliver

1. Record the revision. Trace the entry point → caller → owner → downstream consumer → nearest test. Identify the observable outcome and applicable placements. If read-only, stop at a revision-pinned answer with source citations and uncertainties; do not edit.
2. For a bug, reproduce the intended assertion failing on the base; for a feature, name a concrete acceptance case. Make the smallest compatible change.
3. Use `zstack-verify` and the existing diff/CI planner. Run the closest check first, then the required gates. For UI behavior, exercise the actual interaction with `zstack-drive` where authorized. Linux renderer fixtures are not native macOS or live cloud proof.
4. For pack or covered changes use `zstack-eval`; apply the short-comment rule to your diff and do a full `zstack-review`. Fix verified findings and recheck.
5. Hand off the revision, one or two source anchors, executed checks and results, and what was not run and why. Cite receipts for execution, not proof of reading source. CI remains the merge authority.
6. PR: Why, What changes, Tests, Rollout, Local workspace impact and Cloud workspace impact. Follow `integrate-pr.md` when authorized to integrate. Prefer a regression test, lint, type or replay case over a new lesson fragment.

Never expose credentials, bypass gates, or treat missing tools, authorization, or platform proof as a pass.

## Host adapter

Run `node scripts/zstack/verify.mjs host --host claude` for the execution plan. Use the active Agent tool only if exposed. Add `--can-delegate` only after checking the host and `--delegate` only for an authorized role.

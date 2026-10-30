---
name: zstack
description: "Start here for every Zeros engineering task (bug, feature, refactor, CI red, review, PR integration, Alpha operator, release): record the orchestration mode the user chose, pick the playbook, run the zstack loop (plan → red → implement → verify → eval → review → fix → deliver → learn) and leave a receipt."
globs: "**"
---

# zstack: the Zeros engineering loop

Use this for any change to Zeros, whichever host you run in. `AGENTS.md` and
`RULES.md` are authoritative. This skill turns them into a repeatable loop.

## 1. Record the mode before working

- **Single session** is the default unless the user asks for subagents. You
  run the whole loop yourself, including a fresh-context review pass over your
  own diff.
- **Master plus subagents** only when the user asks for it. The user names
  which model is the master and which models are subagents, and the pairing
  can change from task to task.
  - The master owns Git, integration and the final review of every diff.
  - Subagents return frozen patches with a SHA and evidence, not commits.
  - A subagent's hand-picked test selection is not evidence. Require whole
    touched test directories, and run the full suite yourself before each
    commit: suites coupled by source text or CI scope fail far from the edit.
  - Never start agents or sessions the user did not authorize.
  - When a subagent's progress feed is quiet for longer than its usual
    cadence, check its session status through the host and send its next
    step. An idle agent is lost capacity.
  - Agents sharing a machine run heavy checks through a small number of
    shared slots, each with a timeout and per-test timeouts: one hung suite
    holding a single global lock idles every other agent.
  - A contract or interface change reaches a running subagent only when you
    tell it. Stop it and resume it with the delta before it builds on the old
    text.
  - Sending a step is not idempotent. Read the host's documented reply
    shape before treating a send as failed, check the transcript before
    resending, and pass the host's message id flag when it has one.
- **Co-masters** only when the user pairs two masters. Split file ownership
  before work, give each master its own worktree and PRs, and let one of them
  arm every merge after reviewing the other's full diff. Each cross-reviews the
  other's PRs. Shared contracts change only through an explicit delta message.
- Write the mode, models and the user's instruction into your first progress
  note.

## 2. Classify the task and load only what it needs

| Task | Load |
|---|---|
| New or changed behavior | `agents/zstack/playbooks/feature.md` |
| Bug or regression | `agents/zstack/playbooks/bug-fix.md` |
| Behavior-preserving rename, move, extraction or deletion | `agents/zstack/playbooks/refactor.md` |
| Read-only question, explanation or decision support | `agents/zstack/playbooks/investigation.md` |
| Throwaway sketch to settle a design or behavior question | `agents/zstack/playbooks/prototype.md` |
| CI red, flaky test or release failure | `agents/zstack/playbooks/ci-red.md` |
| Integrating or merging someone's patch (master) | `agents/zstack/playbooks/integrate-pr.md` |
| Live Alpha DB, provider, Railway or WorkOS action | `agents/zstack/playbooks/alpha-operator.md` |
| Pause or resume a multi-agent effort | `agents/zstack/playbooks/pause-resume.md` |
| UI, styling, tokens or mockups | `agents/zstack/playbooks/ui-design.md` and the `zeros-ui` skill |
| Performance or a new canvas/runtime backend | `agents/zstack/playbooks/performance.md` and `zstack-verify` |
| Workspaces, engine, bridge, agents or Git | the `zeros-workspaces` skill (Local and cloud owners and placements) |
| Changing the zstack pack itself | `agents/zstack/playbooks/skill-eval.md` when the change can alter agent behavior, and `zstack-learn` |
| The user asks to reflect on a session | `zstack-reflect`; never start it unprompted |

Every task also uses `agents/zstack/principles.md`: the eighteen principles
that hold Zeros' recorded lessons, each with the eval cases behind it.

Guard the context window. Read the feature area you are changing and the docs
`AGENTS.md` points to for it, not the whole repository.

## 3. The loop

1. **Plan.** State the observable outcome and acceptance criteria, which
   subsystem owns the change, how Local and cloud are affected, and which
   principles the change touches.
2. **Red.** A bug needs a failing regression test before the fix. A feature
   needs a concrete usage example. A finding becomes work only once it has a
   failing test or a recorded repro.
3. **Implement** the smallest change that satisfies the outcome. Preserve
   persisted keys, wire fields and runtime behavior unless a migration is part
   of the task.
4. **Verify** with `zstack-verify`: adjacent suites plus the required static
   gates, and live Alpha checks when the change needs them.
5. **Eval** with `zstack-eval` when the pack or a covered area changed.
6. **Review.** Run the `zstack-comments` pass, then `zstack-review`. Review the
   full diff yourself; no other reviewer replaces that.
7. **Fix** what the review found, in bounded rounds, then re-verify the files
   you touched.
8. **Deliver** a PR with Why, What changes, Tests and Rollout sections, merged
   only through `pnpm agent:merge` (`integrate-pr.md`).
9. **Learn** with `zstack-learn`. Write any lesson back into the pack in the
   same branch.

## 4. Receipt

End each loop with a compact receipt:
- revision and zstack version (from `agents/zstack/CHANGELOG.md`);
- mode and models;
- the commands run and their results, with counts;
- evidence paths;
- anything not verified, with the reason (for example, macOS-only).

## 5. Non-negotiables (from `AGENTS.md`)

- Never print, log, commit or echo a credential, including in arguments and
  test output. `.env.agent` holds Alpha and test credentials only.
- Merge only through `pnpm agent:merge`. PRs that change CI-definition paths
  need the owner's merge.
- Never claim a platform-only check passed on a platform where it did not run.
- Local Personal, organization-local and cloud placements must all keep
  working, including A → B → A owner switching.

---
name: zstack-learn
description: "End-of-loop retrospective for Zeros work: turn each surprise (missed check, flaky gate, wrong assumption, environment gotcha) into a pack update, an eval case, or — preferably — a test, lint or type, in the same branch."
---

<!-- GENERATED from agents/zstack/skills/zstack-learn/SKILL.md by scripts/design-system/build-design-docs.mjs. Edit it there, then run `pnpm design:docs`. -->

# zstack-learn

Run this at the end of every loop, and immediately after any surprise.

## Find the lessons

Ask:
- What did I believe that turned out to be false?
- Which check would have caught this sooner?
- What did I have to rediscover that the pack should have told me?
- Which step cost the most time or tokens, and why?

## Encode each lesson in the strongest form available

1. **Structure first.** A failing test, a lint rule, a type or a script check
   that makes the mistake impossible to repeat.
2. **An eval case** in `agents/zstack/evals/cases.json`, with `fixedBy` and the
   command that catches it.
3. **A pack rule.** One or two precise sentences in the skill or playbook where
   the next agent will actually read them.

Record each lesson in `agents/zstack/CHANGELOG.md` as symptom → cause → rule
→ where it is encoded.

## Boundaries

- Changes to `RULES.md` or `AGENTS.md` safety rules, to CI definitions or to
  credential policy go to the owner as a proposal. Don't merge them yourself.
- Keep the pack small. Replace a weaker rule instead of adding a near-duplicate.
  Cut rules that no case or incident supports.
- Never record secrets, private identifiers or live resource IDs.

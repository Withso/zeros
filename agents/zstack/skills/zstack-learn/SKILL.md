---
name: zstack-learn
description: "End-of-loop retrospective for Zeros work: turn each surprise (missed check, flaky gate, wrong assumption, environment gotcha) into a pack update, an eval case, or — preferably — a test, lint or type, in the same branch."
globs: "**"
---

# zstack-learn

Run this at the end of every loop, and immediately after any surprise. For a
whole long session, the user can ask for `zstack-reflect`, which mines the
transcript instead of memory, or `zstack-correct`, which mines repository
history and proves an enforcer against a real past mistake.

## Find the lessons

Ask:
- What did I believe that turned out to be false?
- Which check would have caught this sooner?
- What did I have to rediscover that the pack should have told me?
- Which step cost the most time or tokens, and why?

## Encode each lesson in the strongest form available

1. **Structure first.** A failing test, a lint rule, a type or a script check
   that makes the mistake impossible to repeat (principle 18).
2. **An eval case**, `agents/zstack/evals/cases/<id>.json`, with `fixedBy` and
   the command that catches it (`zstack-eval`).
3. **Guidance**, only when no structure can hold it: one or two sentences in
   the principle, skill, playbook or `gotchas.md` entry an agent will read at
   that moment. Replace a weaker rule; never append an incident narrative.

A lesson fully held by a test or eval case needs no prose at all.

## Record and fold

- Record guidance as a fragment, `agents/zstack/changes/<id>.md`: symptom →
  cause → rule → where it is encoded, and the target it belongs in (a principle
  number, skill, playbook or `gotchas.md`). Keep it under 2,000 characters.
  Don't edit `CHANGELOG.md` or a shared playbook anchor from a feature branch.
- The pack owner folds every waiting fragment at each pack version: merge it
  into its target as a sentence or two, delete the fragment, and summarize the
  version in `CHANGELOG.md`.
- `scripts/__tests__/zstack-pack.test.ts` fails when more than 40 fragments
  wait or a skill, playbook or reference outgrows its budget. When it fails,
  fold or cut; never raise a budget to fit new text.

## Boundaries

- Changes to `RULES.md` or `AGENTS.md` safety rules, to CI definitions or to
  credential policy go to the owner as a proposal. Don't merge them yourself.
- Cut rules that no case or incident supports.
- Never record secrets, private identifiers or live resource IDs.

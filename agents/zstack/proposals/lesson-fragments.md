# Proposal: fold playbook lessons once per pack version

Several independent fixes append to the same `bug-fix.md` step. Their tests
and implementations are independent, but integration repeatedly conflicts at
that shared prose anchor. Per-case evals and changelog fragments have already
removed the equivalent conflicts from the eval registry and changelog.

Extend that existing fragment workflow to proposed playbook text:

1. Each fix adds `changes/<id>.md`, its regression and its per-file eval.
2. The fragment names the target skill/playbook and includes the proposed
   replacement text. The fix does not also append it to a shared playbook.
3. The pack owner folds the pending fragments once when bumping the version,
   combining overlapping rules and removing weaker duplicates. Skills keep
   their normal generated copies; playbooks remain plain Markdown.
4. The integrated rule keeps links to the contributing case IDs, so an agent
   can find the incident without loading every fragment.

A fragment can use this small form:

```md
Symptom: <observable failure>
Cause: <verified cause>
Encoded by: <regression path and eval id>
Proposed target: playbooks/bug-fix.md, step 3
Proposed text: <one or two precise sentences>
```

This is a review proposal, not a new safety policy. Existing ownership of
AGENTS/RULES, credential policy and CI definitions stays unchanged. An urgent
correction to an unsafe pack rule still goes directly to its owner; a fragment
does not delay or authorize it. No additional generated index, script, merge
check or automatic folding is needed.

If accepted, the pack owner can update `zstack-learn` and the README once at
the next version. Z1 itself keeps its lessons in separate fragments and avoids
the shared `bug-fix.md` anchor.

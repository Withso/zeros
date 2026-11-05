# UI directions land at their owner

**Symptom.** Implementing the approved Zeros Design meant finding every caller
of each changed look by hand. Callers reshaped primitives (Badge heights, a
blue workspace chip, hand-built menu rows and icon buttons), source tests
pinned the old look at call sites, and one icon-only button had no accessible
name because its tooltip stood in for a label.

**Cause.** The UI playbook told agents to compose primitives, but nothing told
them what to do when the user changed a look. A correction was applied where
it was asked for, so the direction lived in one feature file while every other
surface kept the old one.

**Rule.** A look the user corrects or approves is a direction. Move its owner
(token, primitive or shared pattern) and migrate the callers, add the check
that holds it, record it in `docs/design-system.md` §0 and the page spec, run
`pnpm design:docs` so the `zeros-ui` skills carry it, and retire the variant it
replaces. Fix drift from the direction in the files you touch. A board that
breaks a system rule is built to the rule, with the decision logged.

**Encoded in.** `playbooks/ui-design.md` steps 1, 5 and 8;
`docs/design-system.md` §0 (the direction and "How the direction changes") and
the agent brief that renders `zeros-ui`; `ui/icon-only-button` in
`scripts/design-system/ui-policy.mjs`; eval cases
`field-focus-ring-keyboard-only`, `toolbar-one-tab-stop`,
`icon-only-action-names` and `ui-direction-single-owner`. Their `fixedBy` names
the branch commits; replace them with `pr:<number>` when the PR opens.

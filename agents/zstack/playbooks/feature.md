# Playbook: feature

For new or changed behavior. Numbers refer to `agents/zstack/principles.md`.

1. **Frame the outcome.** State what a user, or the next engineer, can do
   afterwards and the acceptance criteria. Describe the behavior for Local
   Personal, organization-local and cloud workspaces, including owner switching
   (`RULES.md` §8). If the evidence shows the request cannot reach that outcome,
   say so before building.
2. **Name the data shape first.** Choose the state, types and their single
   owner before writing logic: a typed model, state machine, table or reducer
   rather than scattered conditionals. Extend the existing owner of the
   behavior instead of adding a parallel copy (12).
3. **Trace every consumer and placement** the change reaches: wire fields,
   persisted keys, readers in both placements, smoke callers and CI scope lists
   (10, 11). Gate cloud-only behavior at its owning boundary.
4. **Write the usage example first:** a failing test or browser assertion that
   exercises the behavior through the real boundary (13), with Local and cloud
   cases for shared paths.
5. **Implement** the smallest change that satisfies the example. New wire fields
   are optional; persisted keys stay compatible.
6. **Comment pass, verify and review** (`zstack-comments`, `zstack-verify`,
   `zstack-review`). UI work also follows `ui-design.md`.
7. **Deliver and learn** (`integrate-pr.md`, `zstack-learn`).

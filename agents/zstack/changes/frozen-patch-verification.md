# Verify the frozen patch in its own source tree

- **Symptom.** Verification in a shared working tree could include edits made
  after a patch was frozen, so its passing result did not qualify the exact
  patch the master was about to commit.
- **Cause.** A frozen diff and the live working tree are different artifacts;
  concurrent work continues after handoff. Shared workspace dependency links
  can also resolve source from the original tree.
- **Rule.** The integrator applies the frozen patch to its stated base in a
  separate worktree or disposable projection, binds workspace dependencies to
  that tree, and runs the required suites there. Record the base, patch SHA-256
  and evidence together. Keep later edits out of the committed patch and never
  replace another agent's live source to construct the verification tree.
- **Encoded in.** The master verified the cloud lifecycle patches in separate
  trees before committing them. The repeatable handoff rule is in
  `skills/zstack-verify/SKILL.md`; workspace-link pitfalls are also recorded in
  `changes/cloud-v2-integration-lessons.md`.

# Playbook: integrate and merge a patch

This is for the integrator, the master in multi-agent mode or the single
session itself.

1. **Verify the handoff.** Match the patch SHA256 to the READY post, check
   whether it touches CI-definition paths, and confirm it applies cleanly to
   current `main`.
2. **Integrate in a separate worktree,** never the checkout that live operator
   runs use. Apply with `git apply --index --whitespace=error`.
3. **Review the full diff yourself** (`zstack-review`). For a revised patch you
   already reviewed, review the interdiff (`git range-diff`).
4. **Commit** with the workspace's own identity. The message gives the why and
   then the what, and ends with the agent's `Co-Authored-By` trailer.
5. **Replace any `"fixedBy": "pending"`** in `agents/zstack/evals/cases/*.json` (or the legacy
   `cases.json`) with the PR's `pr:<n>`, amend, and push before CI runs.
6. **Open the PR** with Why, What changes, Tests and Rollout sections, ending
   with the repository's PR footer. Add lane labels the paths need, for example
   `ci:ui-smoke`.
7. **Merge** with `pnpm agent:merge <n>`, which arms auto-merge. Only one armed
   PR at a time: queue the rest and arm each one after the previous merges.
   CI-definition PRs need the owner's merge.
8. **Don't wait for an Alpha release after every merge.** Releases are
   cumulative. Make sure a successful one exists only when live Alpha behavior
   is needed: zeros-dev E2E, owner testing or a live qualification.

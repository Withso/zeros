# Playbook: integrate and merge a patch

This is for the integrator, the master in multi-agent mode or the single
session itself.

1. **Verify the handoff.** Match the patch SHA256 to the READY post, check
   whether it touches CI-definition paths, and confirm it applies cleanly to
   current `main`.
   Authors emit frozen patches with `git diff --binary` from an index (use
   `git add -N` for new files). An isolated scratch index can preserve the
   workspace index. Before READY, run `git apply --check --whitespace=error`
   against the frozen base, then apply in scratch and verify every source hash;
   include new-file cases. GNU patch alone does not check Git patch metadata.
2. **Integrate in a separate worktree,** never the checkout that live operator
   runs use. Apply with `git apply --index --whitespace=error`.
3. **Review the full diff yourself** (`zstack-review`). For a revised patch you
   already reviewed, review the interdiff (`git range-diff`).
4. **Commit** with the workspace's own identity. The message gives the why and
   then the what, and ends with the agent's `Co-Authored-By` trailer.
5. **Open the PR** with Why, What changes, Tests and Rollout sections, ending
   with the repository's PR footer. Add lane labels the paths need, for example
   `ci:ui-smoke`. Check that all four sections are present before arming.
6. **Pin pending eval cases.** The PR number exists only once the PR is open.
   Replace any `"fixedBy": "pending"` in `agents/zstack/evals/cases/*.json` (or
   the legacy `cases.json`) with `pr:<n>`, validate, amend and push with
   `--force-with-lease`. CI restarts on the new head.
7. **Merge** with `pnpm agent:merge <n>`, which arms auto-merge. Only one armed
   PR at a time: queue the rest and arm each one after the previous merges.
   CI-definition PRs need the owner's merge.
8. **Don't wait for an Alpha release after every merge.** Releases are
   cumulative. Make sure a successful one exists only when live Alpha behavior
   is needed: zeros-dev E2E, owner testing or a live qualification.

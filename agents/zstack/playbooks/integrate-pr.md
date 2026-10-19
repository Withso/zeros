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
   A hosted `gh` wrapper can replace `GH_TOKEN` with an app token; confirm
   the acting identity (`gh api user`) before owner-only operations. If
   `gh pr edit` is refused for review-request access, update the body with
   `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -F body=@<file>`. Confirm
   a push with `git ls-remote`, not with a pipeline's exit status.
7. **Merge** with `pnpm agent:merge <n>`, which arms auto-merge. Only one armed
   PR at a time: queue the rest and arm each one after the previous merges.
   CI-definition PRs need the owner's merge. Before arming, wait for the PR's
   `CodeQL` alert check (separate from the `codeql` job). It is not required,
   so auto-merge won't wait for it; a new high alert, even in a test, is fixed
   before merge.
   - **Stacked PRs.** After the base PR squash-merges, the next PR in the stack
     conflicts (add/add) on files the base created and the stack later changed.
     Replay only that PR's own commits onto `main`
     (`git cherry-pick <base-tip>..<stack-tip>`), re-run its checks and
     force-push with `--force-with-lease`. Keep a stacked branch's copies of
     the base's eval files byte-identical (same `pr:<n>` pins).
   - **Before READY, run the repository-wide invariant suites** the change can
     reach; targeted adjacent runs miss them:
     - control-plane SQL, locks or imports: `src/database-lock-tags.test.ts`,
       `scripts/__tests__/control-plane-scope.test.ts` and the previous-schema
       seed tests such as `data-purge-migration.integration.test.ts`;
     - a new VM-side module: `scripts/__tests__/cloud-computer-template-projection.test.ts`
       plus every `scripts/__tests__/cloud-*` suite;
     - or the full control-plane database shards.
8. **Don't wait for an Alpha release after every merge.** Releases are
   cumulative. Make sure a successful one exists only when live Alpha behavior
   is needed: zeros-dev E2E, owner testing or a live qualification.
   - **Space merges that release.** Overlapping releases can fail forward-only
     admission while another release holds the API in maintenance; the last
     release still ships everything, so read the newest run, not the first
     failure.
   - During a canary watch, merge only between runs. A runtime-changing merge
     must be published and qualified before the next dispatch, or that run ends
     in `runtime_selection_changed`.
9. **Before a release during a freeze,** list which deployables each pending
   PR changes (control plane, cloud runtime, desktop), so the release's effect
   is known before it ships.

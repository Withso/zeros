# Hosted gh wrapper and app-token permissions

- Symptom: owner-only GitHub operations returned 403 "Resource not accessible
  by integration", and `gh pr edit --body-file` failed the same way.
- Cause: a hosted `gh` wrapper replaced `GH_TOKEN` with an app token, and
  `gh pr edit` also reads review requests, which the app token cannot.
- Rule: confirm the acting identity with `gh api user` before owner-only
  operations; update PR bodies through the REST PATCH endpoint; confirm a push
  with `git ls-remote`, not with a pipeline's exit status.
- Encoded in `playbooks/integrate-pr.md` (step 6).

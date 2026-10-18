# Stacked squash integration and repository-wide invariants

- Symptom: after a base PR squash-merged, its stacked successor became
  unmergeable. Separately, three PRs with green targeted runs failed CI on
  repository-wide suites: missing advisory-lock purpose tags, a control-plane
  import outside the CI scope list, a previous-schema seed using current code,
  and a new VM-side module missing from the projected engine view.
- Cause: a squash commit has no ancestry with the stacked branch's base
  commits, so files the base created and the stack changed conflict (add/add).
  Authors ran only the suites adjacent to their change.
- Rule: replay only the stacked PR's own commits onto `main` and re-verify.
  Before READY, run the invariant suites the change can reach, or the full
  control-plane database shards. Space merges that trigger releases, and keep
  runtime-changing merges out of an in-flight canary run.
- Encoded in `playbooks/integrate-pr.md`.

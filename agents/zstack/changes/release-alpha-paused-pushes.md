# Release (alpha) and pushes made while it was disabled

- Symptom: seven merges reached main, but Alpha still ran an older commit and
  no Release (alpha) run existed for any of them.
- Cause: the workflow runs only on a push to main and has no manual dispatch.
  It was enabled again seconds after the last push, so those pushes never
  created a run.
- Rule: before assuming Alpha runs main, compare the last Release (alpha)
  run's head SHA with `origin/main` and check the workflow's state; the
  pending commits ship with the next push.
- Encoded in `playbooks/alpha-operator.md` (Diagnosis).

# Alpha deploys only through Release (alpha)

- Symptom: five merged PRs never reached Alpha while main CI stayed green, and
  the Alpha update feed advertised a ZIP that returned 404.
- Cause: an asset upload failed after the ledger upload, so the rolling tag
  stayed behind the ledger and every later Release (alpha) run failed its
  barrier. Release (alpha) is the only path that deploys the Alpha control
  plane.
- Rule: compare the last successful Release (alpha) run with `origin/main`
  and scan for a failure streak. Recovery is owner-led: verify the retained
  artifact, upload only the missing asset, move the tag forward to the
  ledger's last source after an ancestry check, verify the ledger, then fully
  rerun the latest release run.
- Encoded in `playbooks/alpha-operator.md` (Diagnosis).

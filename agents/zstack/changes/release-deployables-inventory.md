# Release deployables inventory

- Symptom: during a freeze, the effect of the next Alpha release was unclear
  until each pending PR was traced by hand.
- Cause: one push to main ships the control plane, the cloud runtime and the
  desktop app together, and PRs did not record which of them they change.
- Rule: before a release during a freeze, list which deployables each pending
  PR changes (control plane, cloud runtime, desktop).
- Encoded in `playbooks/integrate-pr.md` (step 9).

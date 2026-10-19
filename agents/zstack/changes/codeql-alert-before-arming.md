# CodeQL alerts before arming auto-merge

- Symptom: a PR auto-merged while its `CodeQL` alert check was still pending.
  The check then reported a new high `js/file-system-race` alert in the PR's
  new regression test, which needed a fix-forward PR.
- Cause: the alert check is separate from the required `codeql` job and is not
  required, so auto-merge does not wait for it. A test's `lstat()` followed by
  `readFile()` of the same path is enough to raise it.
- Rule: before arming, wait for the PR's `CodeQL` alert check. In tests, read a
  file's bytes and identity through one handle (`playbooks/integrate-pr.md`).
- Same run: the integrator typed estimated times into the board even though the
  clock-read rule existed. Write the time with `date -u` inside the append
  command itself (`skills/zstack-verify`).

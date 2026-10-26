# A fallback can hide a primary path that never works

- **Symptom.** Restoring a checkpoint brought back edits to assume-unchanged
  files, yet a sparse (skip-worktree, absent) file came back deleted.
- **Cause.** The archive's primary path copied the real index, cleared the
  marks and ran `git add -A`. `git update-index -z --stdin --no-assume-unchanged`
  always failed, because `--stdin` must be the last argument. A fallback (read
  `HEAD` into a fresh index, then `git add -A`) ran every time instead. It also
  captured the edits, so only the sparse case showed the difference.
- **Rule.** When a script has a fallback, test at least one case that only the
  primary path gets right, so a failure there can't hide behind the fallback.
  For `git update-index`, put `--stdin` last.
- **Encoded in.** "keeps edits Git was told to ignore, while a sparse file
  stays a file and not a deletion" in
  `apps/control-plane/src/cloud/checkpoint.test.ts`.

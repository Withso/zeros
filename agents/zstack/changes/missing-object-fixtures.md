# Build a missing-object Git fixture from a source that never had the object

- **Symptom.** A test meant to prove that a restore reports a missing base
  commit passed the restore instead.
- **Cause.** The "stranger" repository was cloned from a repository that had
  already fetched that commit. Its remote-tracking refs kept the commit
  reachable through `reset` and `gc`.
- **Rule.** To simulate a missing object, start from a source that never had
  it, or remove every ref and remote that reaches it, expire reflogs and
  `gc --prune=now`. Then assert `git cat-file -e` fails before exercising the
  code.
- **Encoded in.** The `cat-file` precondition in "fetches a base commit the new
  Cloud Computer lacks" in `apps/control-plane/src/cloud/checkpoint.test.ts`.

# Compare the staged diff with the frozen patch before committing it

- **Symptom.** Committing a co-master's 19-file frozen patch produced a
  20-file commit, which also carried the master's own staged migration rename.
- **Cause.** An earlier `git mv` (and `git checkout <rev> -- <path>`) had
  staged the master's work. `git add <patch files>` plus `git commit` committed
  the whole index.
- **Rule.** Before committing a frozen patch, check that
  `git diff --cached | sha256sum` equals the patch hash. Unstage anything else
  first (`git restore --staged`). Restoring a file from another revision stages
  it too.
- **Encoded in.** Step 4 of `playbooks/integrate-pr.md`.

# Cloud sessions and merges: Git signing, a stale typecheck cache, a resting pointer, a merged branch

Target: `gotchas.md` (Node, Vitest and TypeScript; browser and harness).

- **Signed commits.** A cloud session's `~/.gitconfig` set `commit.gpgsign`
  with SSH signing and no `ssh` binary, so eleven engine suites (Git ops,
  worktrees, the workspace service, Design removal and more) failed with
  "Your Git config signs commits, and commits made directly by Zeros are
  unsigned." The engine starts Git with a sanitized environment that drops
  `GIT_CONFIG_GLOBAL`. Rerunning with `HOME` pointed at a directory holding a
  neutral `.gitconfig` passed them. What still failed stayed environmental: an
  `insteadOf` rewrite of `git@github.com:` to HTTPS, no `ssh`, Git 2.43 for
  the zstack history scripts, and a process group that survives SIGKILL.
- **Stale typecheck cache.** After a merge brought in 761 changed files,
  `pnpm typecheck` was killed at about 13 GB of memory, while
  `tsgo --noEmit -p tsconfig.typecheck.json --incremental false --checkers 1`
  peaked at 2.9 GB with no errors. Deleting the build-info files under
  `node_modules/.cache/zeros-typecheck` let the gate run normally.
- **A resting pointer in a keyboard assertion.** After the merge, the
  workspace hover-card smoke failed: a check that "no tooltip" shows on the
  keyboard path found the sidebar resize handle's hover tooltip. Main's merged
  PR menu gained a note line, which widened it, and the earlier menu step had
  left the pointer on the handle. Park the pointer (`page.mouse.move`) before a
  keyboard path, and rerun the full smoke registry after a merge, because
  either side's layout can move what sits under the pointer.
- **A merged branch is gone.** GitHub deletes a merged PR's branch. When
  `git ls-remote` lists none, restart it from `origin/main` and push plain:
  no force-push, which auto mode refuses. Drop the stale tracking ref first.

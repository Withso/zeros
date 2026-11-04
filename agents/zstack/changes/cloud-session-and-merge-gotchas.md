# Cloud sessions: a signing Git config and a stale typecheck cache

Target: `gotchas.md` (Node, Vitest and TypeScript section).

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

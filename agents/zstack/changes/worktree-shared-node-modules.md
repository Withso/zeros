A linked worktree whose `node_modules` entries are symlinks into the main
checkout shares its install. Running `pnpm install` from that worktree
rewrites the main checkout's workspace package links (`node_modules/@zeros/*`)
and `.modules.yaml` so that they point at the worktree. Other agents' typechecks
and tests then resolve stale package sources, with no error. Give each agent
worktree a real install (`CI=true pnpm install --offline --frozen-lockfile`),
or run dependency changes only from the main checkout. Verify with
`readlink -f node_modules/@zeros/protocol` before trusting a typecheck.

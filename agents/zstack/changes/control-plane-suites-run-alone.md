# Control-plane database suites run alone, from a tree nobody is editing

**Symptom.** Two full `pnpm test:control-plane` runs on one local Postgres
cluster, each on its own database, both failed about 25 migration-ladder tests
("applies the NEWEST migration", "replays from intermediate revision N"). A
run started before more edits also reported new tests failing against old code.

**Cause.** The migration suites reset `public` and create the cluster-wide
`zeros_app` role, so separate databases on one cluster still collide (the
reason `vitest.config.ts` keeps files serial). Vitest loads each file when it
reaches it, so a run started before later edits mixes revisions.

**Rule.** Run one control-plane suite per Postgres cluster at a time, and do not
edit the checkout while it runs. For a base comparison, use a `git worktree` at
the base revision and run it after, not beside, the head run.

**Encoded in.** This note; the serial-file comment in `apps/control-plane/vitest.config.ts`.

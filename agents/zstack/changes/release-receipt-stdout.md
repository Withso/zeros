# A release receipt read from stdout breaks when anything else prints

- The hosted promotion and the controlled cutover read the migration plan as
  JSON from a child `pnpm exec` command's stdout. After #689 added
  `apps/cloud-worker` (`engines.node >=24`) to the pnpm workspace, `pnpm exec`
  on the release jobs' Node 22 printed `WARN Unsupported engine` there. Every
  Alpha release and cutover then stopped at "migration plan" with only the
  generic reconcile message. Credentials, network and migrations were fine.
- When a privacy-preserving release step fails without a reason, reproduce
  the exact CI command in a fresh checkout. Use the job's Node version, its
  frozen installs and its environment names, and check the receipt byte for
  byte. A local run against long-lived `node_modules` and a newer Node can't
  show this class of failure.
- Child output that a parent parses must be the only output: run pnpm with
  `--silent`, or use a receipt file. A parse failure must name itself; it
  must not fall through to the generic stage message.
- Adding a workspace package changes every `pnpm exec` in CI. Check its
  `engines` against each workflow's `node-version`, and which steps parse
  child stdout.

Encoded in `scripts/release/migration-command.test.ts` (#691).

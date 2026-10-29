# Playbook: live Alpha operator actions

Applies to anything that writes to Alpha's database, provider, Railway or
WorkOS. Never use Beta or Production credentials or data.

## Before

- Get the owner's approval for the specific write. A read needs none, but it
  must stay read-only.
- Read credentials into memory from `.env.agent`. Never pass them as
  arguments, never print them, and redact tokens from any output you keep.
- Prefer the repository's operators (`apps/control-plane/src/manage-*.ts`).
  They plan, machine-verify the exact expected previous state, execute, then
  read back. Stop on any mismatch; never widen a plan to make it pass. The
  cloud gate0 probe is the live lifecycle check (see `zstack-verify`).

## Database access

- **RLS-safe reads** with a read-only role:
  `WITH cfg AS MATERIALIZED (SELECT set_config('app.system','on',true) AS v)
  SELECT x.* FROM cfg CROSS JOIN LATERAL (SELECT … WHERE cfg.v = 'on') x`.
- **Owner-level operator writes** use a temporary PlanetScale role:
  - it inherits `postgres`, with a TTL of 3600;
  - grant `zeros_app` to the connection's `session_user`, not the API
    username, which carries a routing suffix;
  - delete the role afterwards and retry until a GET returns 404.

## Diagnosis

- For latency, first confirm that the control plane and the database run in
  the same region, and measure one round trip. A cross-region hop is paid by
  every query.
- Release (alpha) runs only on a push to main, and it is the only path that
  deploys the Alpha control plane. Before assuming Alpha runs main, compare
  the head SHA of the last *successful* Release (alpha) run with `origin/main`,
  check the workflow's state, and scan `gh run list --workflow "Release
  (alpha)"` for a failure streak. Merges made while it was disabled ship only
  with the next push. A publication interrupted after the ledger upload (an
  asset upload failing) leaves the rolling tag behind the ledger, and every
  later run then fails its barrier while main CI stays green. Recovery is
  owner-led: verify the retained signed artifact against the published
  digests, upload only the missing asset, move the tag forward to the
  ledger's last `sourceSha` after an ancestry check, run
  `release-ledger-cli.ts --verify`, then fully rerun the latest release run.
- Rerun a failed Release (alpha) in full (`gh run rerun <id>`), never with
  `--failed`. Publication verifies that the signed macOS build came from the
  same run attempt, so a partial rerun redeploys hosted services and then
  refuses the earlier build ("belongs to another source, run, producing attempt
  or version"). Before and after, read `https://api-alpha.zeros.build/v1/release-identity`
  (source SHA, maintenance, ready) and the `alpha` release name.

## Pins and rebuilds

- Every VM fetches the worker runtime at boot and checks it against the
  control plane's `CLOUD_V2_RUNTIME_SHA256`. A runtime change needs a publish
  and that variable, not a Computer rebuild.
- Rebuild a Computer only when its repositories or setup change. Boot a
  workspace from the new build before calling it ready.

## Collisions and cleanup

- An operator approval embeds the target's version snapshot, and a stopped
  workspace's version still ticks, so a plan and an execute run as two
  separate commands can fail closed with a plan mismatch. Run plan and
  execute in one process, and retry the pair on that mismatch only.
- Don't change Railway variables in a way that redeploys a service while a
  release workflow is running. Check for an in-flight release first.
- Before deleting a scratch, worktree or `.context` folder, check that no
  agent's PATH or running process uses it. Inspect working directories and
  process names; if PATH inspection is needed, extract only PATH in memory.
  Never emit raw process arguments or environments: agent launch arguments can
  contain session credentials. Keep shared host tools in one stable directory
  outside any `.context`.

## After

- Record the outcome as booleans, counts and closed codes in a mode-0600 state
  file outside the repository.
- Report anything left pending, for example a deletion still observing.

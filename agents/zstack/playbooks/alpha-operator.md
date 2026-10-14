# Playbook: live Alpha operator actions

Applies to anything that writes to Alpha's database, provider, Railway or
WorkOS. Never use Beta or Production credentials or data.

## Before

- Get the owner's approval for the specific write. A read needs none, but it
  must stay read-only.
- Read credentials into memory from `.env.agent`. Never pass them as
  arguments, never print them, and redact tokens from any output you keep.
- Prefer the repository's operators (`apps/control-plane/src/manage-*.ts`,
  the zeros-dev harness). They plan, machine-verify the exact expected
  previous state, execute, then read back. Stop on any mismatch; never widen a
  plan to make it pass.

## Database access

- **RLS-safe reads** with a read-only role:
  `WITH cfg AS MATERIALIZED (SELECT set_config('app.system','on',true) AS v)
  SELECT x.* FROM cfg CROSS JOIN LATERAL (SELECT … WHERE cfg.v = 'on') x`.
- **Owner-level operator writes** use a temporary PlanetScale role:
  - it inherits `postgres`, with a TTL of 3600;
  - grant `zeros_app` to the connection's `session_user`, not the API
    username, which carries a routing suffix;
  - delete the role afterwards and retry until a GET returns 404.

## Collisions and cleanup

- Don't change Railway variables in a way that redeploys a service while a
  release workflow is running. Check for an in-flight release first.
- Before deleting a scratch, worktree or `.context` folder, check that no
  agent's PATH or running process uses it (`/proc/*/environ`). Keep shared host
  tools in one stable directory outside any `.context`.

## After

- Record the outcome as booleans, counts and closed codes in a mode-0600 state
  file outside the repository.
- Report anything left pending, for example a deletion still observing.

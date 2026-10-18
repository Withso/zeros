# Control-plane database load simulator

The load simulator measures what the control plane's database costs today for
quiet and active cloud workspaces. It runs real control-plane code in-process
against a real PostgreSQL database and drives it from simulated engines,
desktops and background workers at the cadences the shipped clients use. It
records transactions, statements, round trips, connection checkouts, latency
and control-plane CPU per operation, then compares the totals with checked-in
budgets.

Source: `apps/control-plane/src/load-sim/`. Local workspaces are unaffected: the
simulator only exercises cloud-workspace control-plane paths and changes no
product behavior.

## Running it

The command line rebuilds the target database from migrations on every run, so
point it at a disposable loopback database. The URL is validated before
anything is dropped: query parameters are refused outright (pg would apply
them over the URL host, so `?host=…` could redirect the rebuild), the host
must be a loopback IP literal in `127.0.0.0/8` or `::1` (a name such as
`127.example.com` is refused; `localhost` is accepted only after it resolves to
loopback addresses), and the database name must match `zeros_load_sim…`. The
checks live in `apps/control-plane/src/load-sim/database-guard.ts`.

```sh
LOAD_SIM_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/zeros_load_sim \
  pnpm --dir apps/control-plane load:db

# Shorter run, saved report
pnpm --dir apps/control-plane load:db -- --workspaces 0,1,10 --duration 20 --out /tmp/load.json
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--workspaces` | `0,1,10,50` | Active-workspace counts for the real-time scenarios. |
| `--duration` | `30` | Seconds measured per active scenario. |
| `--quiet-duration` | `120` | Seconds measured for the 0-active scenario (long enough to include a 60 s orphan sweep). |
| `--warmup` | `5` | Seconds run before each scenario's measurement window. |
| `--iterations` | `25` | Serial calls per operation for the per-request table. |
| `--no-background` | off | Do not start the in-process background workers. |
| `--workos off` | on | Run the services with WorkOS authority disabled. |
| `--out` | `$TMPDIR/zeros-load-sim-<random>/report-<time>.json` | JSON report path; the Markdown tables are always printed. Each default report gets a new private directory. |
| `--write-budgets` | none | Write budgets derived from this run (see "Budgets"). |

The run exits with code 1 when a measurement exceeds `budgets.json` or when
any scenario records an operation failure. It also prints the measured quiet
and per-active-workspace rates beside the plan targets.

If `pg_stat_statements` is preloaded on the server, the command line installs it
in a separate `load_sim` schema and reports the top statements by server time.
The Vitest suite never installs it, because extensions change the migrated
schema fingerprint.

### Vitest budget check

`src/load-sim/load-simulator.integration.test.ts` runs in the existing
control-plane integration lane when `TEST_DATABASE_URL` is set, and skips
otherwise. It takes about 10 seconds and checks:

- the probe counts a batched transaction setup correctly;
- `budgets.json` has a budget for exactly the simulated operations;
- each operation's per-request transactions, statements and round trips;
- the projected steady-state transaction rate per active workspace and per
  running engine;
- a 3 second real-time run of one workspace has no failures and stays under a
  ceiling derived from the cadence table.

## What is real and what is simulated

| Real | Simulated or omitted |
| --- | --- |
| Migrated schema, SQL, transactions and stored functions on PostgreSQL 18 | Network distance to the database (see the round-trip floor column) |
| `createPool` API and worker pools with production pool settings | Boat provider (`FakeBoatProvider` returns immediately) |
| Engine services: heartbeat, uplink lease renewal, uplink checkpoint-request read, checkpoint-hint wait, durable record head, credential controls, actor confirmation | Engine and desktop processes, relay sockets and HTTP framing (except the catalog route) |
| Desktop paths: actor-session renew, relay authority revalidation, catalog through the Hono route with `resolveAuthenticatedUser` | WorkOS network calls |
| Provider resolver, reconciler job claim/intent claim/drift/orphan sweep, access revocation, checkpoint request and security-event workers | WorkOS sync, outbox and other workers not listed |

Each workspace is seeded as a ready workspace with a WorkOS link, a database
qualification, a cursor credential, an activated boot, a user, session and
device, and a consumed actor session.

## Cadences

Per active workspace, one running engine and one connected desktop:

| Operation | Role | Interval | Source |
| --- | --- | --- | --- |
| `engine.credentialControls` | engine | 500 ms after completion | `apps/desktop/src/engine/cloud-local-command-queue-boot.ts` |
| `engine.uplinkLeaseRenewal` | engine | 300 s | `UPLINK_WATERMARK_INTERVAL_MS` in `apps/control-plane/src/realtime/uplink-protocol.ts` (S2 `lease.v1`) |
| `engine.uplinkCheckpointSweep` | engine | 30 s (one read per uplink, an upper bound: one statement serves up to 500) | `SWEEP_TICKS` in `apps/control-plane/src/realtime/uplink-checkpoint.ts` (S2 `checkpoint.v1`) |
| `engine.durableRecordHead` | engine | 10 s, every heartbeat tick, posted or skipped | `synchronizeDurableRecord` in cloud runtime registration |
| `engine.actorConfirm` | client | 5 s (half of `confirmedUntil`) | engine actor confirmation |
| `client.renew` | client | 5 s (lease / 2) | `apps/desktop/src/engine/transport/cloud.ts` |
| `client.relayRevalidate` | client | 5 s | `authorityCheckMs` in `apps/control-plane/src/cloud-workspaces/runtime-bridge.ts` |
| `client.catalog` | client | 30 s, `limit=100` | `apps/desktop/src/renderer/state/cloud-workspace-lifecycle.tsx` |

`engine.heartbeat` keeps its per-request budget but has no steady-state
cadence: with `lease.v1` the uplink renews the lease and a periodic beat posts
only when it carries something (S2 1.2.0). An engine without `lease.v1` still
posts every 10 s (`DEFAULT_ENGINE_HEARTBEAT_INTERVAL_MS` in
`apps/control-plane/src/cloud-workspaces/engine-heartbeat.ts`), 0.1 tx/s more
per running engine. `engine.checkpointHintWait` likewise keeps its
per-request budget without a cadence: with `checkpoint.v1` the uplink pushes
queued checkpoint requests and the engine pauses its hint wait (S2 1.2.0).
An engine without `checkpoint.v1` still runs the wait (six reads per 25 s,
`apps/control-plane/src/cloud-workspaces/engine-checkpoint-hints.ts`),
0.24 tx/s more per running engine.

Turn events (`engine.uplinkTurnEvent`, S2 `turns.v1`) cost one transaction per
turn transition, two or three per turn, and are not part of the steady state.

The background workers run once per process at their configured intervals
(`apps/control-plane/src/worker-polling-config.ts`). Lifecycle due work runs as
jobs (docs/cloud-workspace/job-queue.md): one engine-health cycle per running
workspace per lease period (the job runs at the lease expiry: every 31-36 min
with `lease.v1`, modeled as 1800 s, and every 90 s for an engine on the HTTP
heartbeat alone), drift when a binding's `next_drift_check_at`
passes (60 s while running or transitional, 6 h once settled stopped or
archived), and the 60 s orphan sweep, which paces drift from Boat's paged
inventory instead of inspecting each workspace.

## Metrics

- **Transactions**: explicit `BEGIN` blocks plus statements run outside a
  transaction, which count as one autocommit transaction each. Counted on the
  client, attributed per operation with `AsyncLocalStorage`.
- **Statements**: every query, including `BEGIN`, `COMMIT` and `SET LOCAL`.
- **Round trips**: network exchanges with the server; a batched setup with
  several statements counts as one.
- **Checkouts**: pool connection acquisitions.
- **Notify commits/s**: commits that issued a NOTIFY. Explicit `pg_notify`
  statements are counted client-side; job-queue wake-ups are issued by a
  database trigger, so a LISTEN connection counts their deliveries (identical
  notifications dedupe per transaction, so deliveries equal notifying commits
  on that channel). Authority-cache hints (`zeros_cloud_authority_cache`,
  migration 0151) are counted the same way and included; one commit can
  carry several scopes, so with them the column is an upper bound.
  PostgreSQL serializes notifying commits at commit time. `load:db` prints the
  projected notifying commits at 100, 500 and 1000 active workspaces.
- **Authority hints/s**: authority-cache hint deliveries alone.
- **RTT floor**: round trips multiplied by an assumed 5 ms database distance;
  the minimum added latency for a remote database.
- **CP CPU ms/s**: control-plane process CPU time per wall second.
- **Server tx/s and server exec ms/s**: `pg_stat_database` and
  `pg_stat_statements` deltas. These are approximate; they include autovacuum
  and statistics flush timing.

## Budgets

`src/load-sim/budgets.json` stores today's cost plus headroom:

- transactions per request: measured, no headroom, because a new transaction is
  a deliberate change;
- statements and round trips per request: `ceil(measured × 1.25)`;
- steady-state transactions per second: measured × 1.1, rounded up to 0.01;
- notifying commits per active workspace per second, and authority-cache
  hints per active workspace per second: observed between the quiet and
  busiest scenario, × 1.1;
- Boat calls per minute are enforced against the provider's 1000
  requests/min/IP rate limit with a two-replica allowance: one paged
  inventory list per minute (`ceil(sandboxes / 100)` calls) plus one inspect
  per fallback-horizon drift run.

Budgets are a ratchet. When a change makes a path cheaper, regenerate them with
`--write-budgets src/load-sim/budgets.json` and commit the lower numbers. Do not
raise a budget to pass the check without explaining the new cost in the pull
request. The plan targets (0.5 tx/s quiet and 0.01 tx/s per active workspace)
are recorded in the file and reported, but not enforced until the hot paths are
rebuilt.

Capability member-epoch bumps (migration 0152) are event-driven, not
steady-state, so the scenarios do not exercise them. Their bound per event:
an organization-wide input (organization, team or entitlement change,
billing-scope flip, role-relevant workspace change, a seat past the limit)
writes N + G epoch rows in one statement for an organization with N members
and G live non-member guests; a per-account input writes one row per
organization the account belongs to; a membership row change writes one.
An UPDATE that changes no role input writes none, so a directory sync that
rewrites unchanged roles costs nothing here.

In the October 2026 re-run (0, 1 and 10 active, 30 s) authority hints were
0.023 per active workspace per second and all notifying commits 0.047
(100 active ≈ 4.7/s, 1000 active ≈ 47/s). Before the
`cloud_workspace_generations.ports_observed_at` exemption, every port-scan
heartbeat notified: 0.100 hints per active workspace per second.

## Baseline (October 2026)

PostgreSQL 18.6 on loopback, Node 24, 4 CPUs, WorkOS authority on.

### Per request

| Operation | Tx | Statements | Round trips | p50 ms | RTT floor @5 ms |
| --- | --- | --- | --- | --- | --- |
| `engine.heartbeat` | 1 | 9 | 7 | 9.5 | 35 |
| `engine.durableRecordHead` | 1 | 7 | 5 | 3.2 | 25 |
| `engine.uplinkLeaseRenewal` (2026-10-18) | 1 | 7 | 5 | 3.3 | 25 |
| `engine.uplinkCheckpointSweep`, one uplink (2026-10-18) | 1 | 5 | 1 | 0.6 | 5 |
| `engine.checkpointHintWait`, one read (2026-10-18) | 1 | 5 | 3 | 0.9 | 15 |
| `engine.uplinkIdleStopRequest`, declined (2026-10-18) | 1 | 6 | 4 | 2.9 | 20 |
| `engine.uplinkTurnEvent`, stored with notice (2026-10-18) | 1 | 9 | 7 | 1.5 | 35 |
| `engine.credentialControls` | 1 | 10 | 8 | 4.6 | 40 |
| `engine.actorConfirm` | 1 | 11 | 9 | 10.1 | 45 |
| `client.renew` | 1 | 12 | 10 | 9.7 | 50 |
| `client.relayRevalidate` | 1 | 10 | 8 | 5.7 | 40 |
| `client.catalog` (including authentication) | 2 | 14 | 10 | 15.9 | 50 |
| `provider.resolve` | 1 | 7 | 5 | 2.2 | 25 |
| `worker.lifecycleJobClaim` | 1 | 5 | 1 | 0.9 | 5 |
| `worker.reconcileOnce` | 1 | 5 | 3 | 4.5 | 15 |
| `worker.reconcileDrift` (due) | 6 | 36 | 24 | 12.8 | 120 |
| `worker.reconcileOrphans` (inventory sweep) | 3 | 16 | 10 | 5.6 | 50 |
| `worker.engineHealthJob` (full job cycle) | 5 | 25 | 9 | 7.4 | 45 |
| `worker.jobAudit` (six due scans + purge) | 7 | 35 | 19 | 11.1 | 95 |

### Real time

| Active workspaces | Tx/s | Tx/s per active | Statements/s | Notify commits/s | CP CPU ms/s | Failures |
| --- | --- | --- | --- | --- | --- | --- |
| 0 (45 s) | 0.04 | n/a | 0.22 | 0 | 0.8 | 0 |
| 1 | 2.93 | 2.89 | 29.0 | 0 | 7.0 | 0 |
| 10 | 28.5 | 2.84 | 285.4 | 0.6 | 45.0 | 0 |

The quiet control plane is within the 0.5 tx/s target. The notifying commits
at 10 workspaces are the one-time job inserts right after seeding; the
steady-state job cycle (reschedule to a future time, completion) is silent
by design.

### Projection at nominal cadence

One active workspace costs **2.92 tx/s** and 28.9 statements/s, about 290 times
the 0.01 tx/s target. A running engine alone costs 2.26 tx/s; each connected
desktop adds 0.67 tx/s; a settled stopped workspace costs 0.0003 tx/s. The
reconciler's share is the engine-health job cycle (5 transactions every 90 s,
0.056 tx/s per running workspace); inventory-paced drift and the orphan sweep
add nothing while the listing confirms the bindings. One replica's Boat calls
project to 6.4 per minute at 500 workspaces against the enforced 1000
requests/min/IP budget (two replicas).

With `lease.v1` (re-run 2026-10-18) one active workspace projects to
**3.01 tx/s** and 29.0 statements/s, and a running engine alone to 2.35 tx/s.
The 10 s heartbeat (0.1 tx/s) is gone and the engine-health cycle falls to
0.003 tx/s per running workspace, while the model now counts the
checkpoint-hint wait (0.24 tx/s per running engine); the lease renewal adds
0.003 tx/s. The steady-state budgets moved to 3.32 tx/s per active workspace
and 2.59 tx/s per running engine.

With `checkpoint.v1` (re-run 2026-10-18) one active workspace projects to
**2.81 tx/s** and 28.0 statements/s, and a running engine alone to
2.14 tx/s. The checkpoint-hint wait (0.24 tx/s per running engine) leaves
the steady state, and the uplink's queued-request read adds at most
0.033 tx/s per running engine: one statement every 30 s serves up to 500
uplinks of a `realtime` instance, so the model's one read per engine is an
upper bound. In real time, 10 active workspaces ran at 27.7 tx/s (2.77 per
active workspace) with no failures. The steady-state budgets moved to
3.09 tx/s per active workspace and 2.36 tx/s per running engine.

### Findings

1. `engine.credentialControls` polls every 500 ms: 2.0 tx/s per running engine,
   about 67% of all transactions.
2. The authority check `SELECT` in `assertCurrentCloudEngineAuthority` runs on
   every engine request and takes about 57% of server execution time at 50
   active workspaces (5.6 s per 30 s window, 1.6 ms mean).
3. The engine lease and `cloud_workspace_runtime_authority_live` check is the
   second-largest statement (1.6 s per window).
4. The actor role and fingerprint `SELECT` behind renew and actor confirmation
   is third (0.8 s per window).
5. The orphan sweep costs three transactions per 60 s per replica while the
   paged listing confirms every binding; its marginal per-workspace cost is
   zero in steady state.
6. The checkpoint-hint wait reads the database every 5 s per running engine
   (0.24 tx/s). With `checkpoint.v1` the uplink pushes `checkpoint.request`
   instead and the wait pauses, leaving one queued-request read per uplink
   every 30 s (at most 0.033 tx/s).

The provider resolver's connection query took 9.5 ms mean on loopback,
compared with 25.4 ms measured on Alpha.

## Gaps

- Database distance is not simulated. Use the RTT floor column for a remote
  database such as PlanetScale.
- Boat timing is faked, so provisioning and wake latency are not measured.
- Access, sync and presence panels, commands, uploads, checkpoints and setup
  flows are not driven.
- WorkOS sync, the outbox and other workers are not started.
- Server transaction counts are noisy at low rates.

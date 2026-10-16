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
point it at a disposable loopback database. Non-loopback hosts are refused.

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
| `--out` | `$TMPDIR/zeros-load-sim/report-<time>.json` | JSON report path; the Markdown tables are always printed. |
| `--write-budgets` | none | Write budgets derived from this run (see "Budgets"). |

The run exits with code 1 when a measurement exceeds `budgets.json`. It also
prints the measured quiet and per-active-workspace rates beside the plan
targets.

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
| Engine services: heartbeat, durable record head, credential controls, actor confirmation | Engine and desktop processes, relay sockets and HTTP framing (except the catalog route) |
| Desktop paths: actor-session renew, relay authority revalidation, catalog through the Hono route with `resolveAuthenticatedUser` | WorkOS network calls |
| Provider resolver, reconciler tick/drift/orphan sweep, access revocation, checkpoint request and security-event workers | WorkOS sync, outbox and other workers not listed |

Each workspace is seeded as a ready workspace with a WorkOS link, a database
qualification, a cursor credential, an activated boot, a user, session and
device, and a consumed actor session.

## Cadences

Per active workspace, one running engine and one connected desktop:

| Operation | Role | Interval | Source |
| --- | --- | --- | --- |
| `engine.credentialControls` | engine | 500 ms after completion | `apps/desktop/src/engine/cloud-local-command-queue-boot.ts` |
| `engine.heartbeat` | engine | 10 s | `DEFAULT_ENGINE_HEARTBEAT_INTERVAL_MS` in `apps/control-plane/src/cloud-workspaces/engine-heartbeat.ts` |
| `engine.durableRecordHead` | engine | after each heartbeat | `synchronizeDurableRecord` in cloud runtime registration |
| `engine.actorConfirm` | client | 5 s (half of `confirmedUntil`) | engine actor confirmation |
| `client.renew` | client | 5 s (lease / 2) | `apps/desktop/src/engine/transport/cloud.ts` |
| `client.relayRevalidate` | client | 5 s | `authorityCheckMs` in `apps/control-plane/src/cloud-workspaces/runtime-bridge.ts` |
| `client.catalog` | client | 30 s, `limit=100` | `apps/desktop/src/renderer/state/cloud-workspace-lifecycle.tsx` |

The background workers run once per process at their configured intervals
(`apps/control-plane/src/worker-polling-config.ts`). The reconciler checks drift for a workspace when its
`last_observed_at` is older than the interval, and sweeps orphans every 60 s.

## Metrics

- **Transactions**: explicit `BEGIN` blocks plus statements run outside a
  transaction, which count as one autocommit transaction each. Counted on the
  client, attributed per operation with `AsyncLocalStorage`.
- **Statements**: every query, including `BEGIN`, `COMMIT` and `SET LOCAL`.
- **Round trips**: network exchanges with the server; a batched setup with
  several statements counts as one.
- **Checkouts**: pool connection acquisitions.
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
- steady-state transactions per second: measured × 1.1, rounded up to 0.01.

Budgets are a ratchet. When a change makes a path cheaper, regenerate them with
`--write-budgets src/load-sim/budgets.json` and commit the lower numbers. Do not
raise a budget to pass the check without explaining the new cost in the pull
request. The plan targets (0.5 tx/s quiet and 0.01 tx/s per active workspace)
are recorded in the file and reported, but not enforced until the hot paths are
rebuilt.

## Baseline (October 2026)

PostgreSQL 18.6 on loopback, Node 24, 4 CPUs, WorkOS authority on.

### Per request

| Operation | Tx | Statements | Round trips | p50 ms | RTT floor @5 ms |
| --- | --- | --- | --- | --- | --- |
| `engine.heartbeat` | 1 | 9 | 7 | 9.5 | 35 |
| `engine.durableRecordHead` | 1 | 7 | 5 | 3.2 | 25 |
| `engine.credentialControls` | 1 | 10 | 8 | 4.6 | 40 |
| `engine.actorConfirm` | 1 | 11 | 9 | 10.1 | 45 |
| `client.renew` | 1 | 12 | 10 | 9.7 | 50 |
| `client.relayRevalidate` | 1 | 10 | 8 | 5.7 | 40 |
| `client.catalog` (including authentication) | 2 | 14 | 10 | 15.9 | 50 |
| `provider.resolve` | 1 | 7 | 5 | 2.2 | 25 |
| `worker.lifecycleDeadlines` | 1 | 5 | 3 | 5.3 | 15 |
| `worker.reconcileOnce` | 1 | 5 | 3 | 4.5 | 15 |
| `worker.reconcileDrift` (due) | 6 | 36 | 24 | 12.3 | 120 |
| `worker.reconcileOrphans` | 1 empty, 2 at 1 workspace, 51 at 50 | | | | |

### Real time

| Active workspaces | Tx/s | Tx/s per active | Statements/s | CP CPU ms/s | Server exec ms/s | Failures |
| --- | --- | --- | --- | --- | --- | --- |
| 0 (120 s) | 0.15 | n/a | 0.75 | 1.4 | 0.01 | 0 |
| 1 | 2.90 | 2.75 | 28.5 | 7.2 | 13.2 | 0 |
| 10 | 28.6 | 2.84 | 284.9 | 52.2 | 68.8 | 0 |
| 50 | 145.1 | 2.90 | 1439.7 | 142.6 | 323.1 | 0 |

The quiet control plane is within the 0.5 tx/s target. Server-side counts for
the quiet run (0.62 tx/s) include autovacuum and statistics activity.

### Projection at nominal cadence

One active workspace costs **2.98 tx/s** and 29.4 statements/s, about 300 times
the 0.01 tx/s target. A running engine alone costs 2.32 tx/s; each connected
desktop adds 0.67 tx/s. The reconciler adds 0.10 tx/s for drift checks and
0.017 tx/s for the orphan sweep per workspace.

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
5. The orphan sweep costs one transaction per workspace each 60 s, so its cost
   grows linearly with inventory.

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

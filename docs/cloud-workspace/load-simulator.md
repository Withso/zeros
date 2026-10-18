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
| Provider resolver, lifecycle deadline scan, reconciler intent/drift/orphan sweep, access revocation, checkpoint request and security-event workers | WorkOS sync, outbox and other workers not listed |

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

The background workers still use the existing polling lifecycle loop. Drift
and orphan scans run every 60 seconds; `worker.lifecycleDeadlines` measures the
idle deadline read. No lifecycle job or inventory-pacing operation is modeled.

## Metrics

- **Transactions**: explicit `BEGIN` blocks plus statements run outside a
  transaction, which count as one autocommit transaction each. Counted on the
  client, attributed per operation with `AsyncLocalStorage`.
- **Statements**: every query, including `BEGIN`, `COMMIT` and `SET LOCAL`.
- **Round trips**: network exchanges with the server; a batched setup with
  several statements counts as one.
- **Checkouts**: pool connection acquisitions.
- **Notify commits/s**: commits that issued a NOTIFY. Explicit `pg_notify`
  statements are counted client-side; job-queue wake-ups are issued by the existing
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

`src/load-sim/budgets.json` records measured transactions per request, 25%
headroom for statements and round trips, and 10% for nominal steady-state
transactions and observed notification rates. Every modeled operation must
have exactly one entry. Budgets are regenerated on this tree, with the existing
polling lifecycle worker and per-workspace drift and orphan inspections.

The measured baseline on this tree is 0.108 tx/s quiet and 2.920 tx/s per
active workspace. A stopped workspace still costs 0.117 tx/s in drift and
orphan inspections; the budget retains that existing lifecycle cost.

The plan targets remain 0.5 tx/s quiet and 0.01 tx/s per active workspace.
Uplink rows describe enabled capabilities; the legacy routes are also measured
individually. The projection uses `lease.v1` and `checkpoint.v1` cadences.
They do not imply that the flags are enabled by default.

## Gaps

- Database distance is not simulated. Use the RTT floor column for a remote
  database such as PlanetScale.
- Boat timing is faked, so provisioning and wake latency are not measured.
- Access, sync and presence panels, commands, uploads, checkpoints and setup
  flows are not driven.
- WorkOS sync, the outbox and other workers are not started.
- Server transaction counts are noisy at low rates.

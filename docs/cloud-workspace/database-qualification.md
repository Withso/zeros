# Hosted Postgres qualification

Status, September 22, 2026: Alpha, Beta and Production use PlanetScale Postgres.
Each cutover preserved its own source data, applied forward migrations, verified
runtime roles and API behavior, and retained the old writer fence. Normal app
access is restored. Backup recovery checks do not complete regional disaster
recovery or sustained production-load qualification. The control-plane
application stays on Railway. Existing
SQL, workspace identities, RLS, migrations and portable client contracts remain
authoritative. The compute providers remain independent of database hosting.

## Environment boundaries

- Keep Alpha, Beta and Production on separate clusters with separate credentials,
  data and deployment secrets. Preserve the existing release promotion ladder.
- Alpha and Beta may use small single-node clusters for routine development.
  They do not establish production HA or capacity evidence. Rehearse those
  properties on a disposable cluster matching the intended production topology.
- Run destructive integration suites only against an explicitly disposable
  database branch. Current suites execute `DROP SCHEMA public CASCADE` and must
  never target shared Alpha, Beta or Production. Serialize suites sharing a target.
- Inspect existing data, schema ledgers and external integrations before selecting
  fresh provisioning or data transfer. An internal audience does not imply an
  empty or disposable database.
- Choose the database region based on measured latency from the app deployment.
  Similar region names do not establish private networking or low latency.
- Pin a supported target Postgres major and extension versions, and test that
  major in CI before deployment. Keep source-major upgrade coverage during the
  migration. Do not rewrite applied migration files or checksum history.

## Connections and authority

`DATABASE_URL` owns the bounded request pool. `DATABASE_LISTEN_URL` optionally
gives the durable event listener a separate max-one pool with runtime privileges.
`DATABASE_MIGRATION_URL` belongs to the one-shot migrator, with a max-one pool;
it must not be supplied to a hosted API using verify-only boot. Transaction
helpers use `SET LOCAL ROLE zeros_app` and transaction-local authorization.
Boot verification enters that role too: a NOINHERIT runtime login has no direct
table access. Migration 0086 makes its migration-ledger access read-only.

Create runtime membership under the stable migration-owner role, with `SET`
permission but neither inherited table authority nor `ADMIN OPTION`. Inspect
`pg_auth_members.grantor` and verify the native runtime login after retiring
temporary administrative credentials. PostgreSQL membership grants depend on
their grantor retaining authority; object reassignment alone does not preserve
every grant. See [PostgreSQL role grants](https://www.postgresql.org/docs/18/sql-grant.html).

Initial compatibility testing must use direct primary connections on port 5432
with certificate and hostname verification. A single transaction-pooler URL is
not a compatible replacement: WorkOS session advisory locks span external HTTP
and separate SQL transactions, in addition to LISTEN and migration locks.
Configuration rejects PlanetScale pooling/replica routes, unverified TLS, routing
query overrides, and mismatched branch suffixes or databases. Use Node's verified
TLS profile (`sslmode=verify-full`), without libpq's `sslrootcert=system`, which
the Node parser treats as a filename. Qualify the actual pinned Node
driver and packaged trust store, including rejection of invalid certificates.
[PlanetScale connection guidance](https://planetscale.com/docs/postgres/connecting/pgbouncer)

Implemented connection controls and remaining hosted qualification:

- Separate migration authority from routine application authority. Audit boot
  migrations, operator CLIs, direct pool queries, object ownership, default
  privileges and RLS before switching credentials. A read/write credential
  alone cannot perform the existing boot DDL.
- Preserve the non-owner, non-superuser, `NOBYPASSRLS` `zeros_app` role and its
  transaction-local use. Prove cross-tenant rejection and pooled-request context
  cleanup after success, errors, cancellation and reconnect. Test creation and
  membership of the role under the target managed administrator.
- Idle and owned-transaction failures are observed without an uncaught process
  error. WorkOS lock loss aborts its SDK fetches and fences subsequent SQL and
  retries; a request already delivered remains uncertain. Retire broken
  checked-out clients, including listener initialization failures and shutdown
  races. Re-establish listening and replay durable records after reconnect.
- Connections retire after ten minutes, including the continuously checked-out
  listener. Configure bounded retry/backoff and connection deadlines without
  blindly retrying writes whose commit result is unknown.
- Budget connections across all processes, workers, rollout overlap, migration
  jobs and operator sessions. Read actual database limits; small-cluster defaults
  are not a universal immutable cap. Keep administrative recovery headroom.
- If request transactions later use port 6432, add a separately bounded direct
  WorkOS lock pool, retain direct migration/listener paths, and validate startup parameters, transaction-local settings, timeouts
  and tenant isolation under the pooler. Do not enable pooling merely by
  replacing the shared URL.

Managed roles have different administrative privileges from a local superuser;
the default PlanetScale role also bypasses RLS. Use explicit application roles
and tested grants. PlanetScale advises recycling connections within 24 hours;
driver pool eviction alone does not establish safe listener rotation.
[Role management](https://planetscale.com/docs/postgres/connecting/roles),
[connection resilience](https://planetscale.com/docs/postgres/connection-resilience)

Start PS-5 qualification with one API replica, six request connections and one
dedicated listener. Rolling overlap would consume fourteen direct connections,
before an explicit migrator and operator headroom. Compare the complete budget
with the target's usable slots and measured load. The minimum is three request
slots with shared LISTEN, or two with dedicated LISTEN, because a provider lock
holder needs another connection to checkpoint. These minima are deadlock guards,
not performance sizing recommendations.

## Verification order

1. Inventory the source database and prepare an exact, reversible deployment
   plan. Record version, schema checksums, roles, extensions, size, backup and
   restore evidence without exporting user data into repository logs.
2. Add regression coverage for connection loss, listener replacement, role
   boundaries, pool exhaustion and ambiguous commits. Run migrations and the
   database suites on disposable local and hosted targets of the selected major.
3. Deploy the qualified application to isolated Alpha. Exercise real identity,
   private-repository access and revocation through the public API. Measure
   connection waits, transaction latency, event replay and worker progress.
4. Run the Boat headless lifecycle, agents, Code/Design, simultaneous-device,
   spend and recovery matrix against the target database. Daytona must separately
   pass its worker-host compatibility gate before its complete runtime matrix.
5. Rehearse HA switchover, restart, expired credentials, sustained load and restored
   database promotion on the production-equivalent disposable cluster. Verify
   no duplicate allocation, prompt, grant, settlement or external side effect.
6. Exercise database restore together with encrypted objects and required key
   versions. Record measured recovery loss and duration. Only then promote the
   same application artifact through Beta and Production under the existing
   deployment procedure.

## Recovery and cutover

Database backups do not include the encrypted workspace blobs stored by the
separate object-store adapter. The current hosted adapter uses a mounted
filesystem volume. Its offsite copies, integrity checks, deletion tombstones,
key recovery and retention must cover the database's entire restore window.
Restore tests must verify every object referenced by the recovered checkpoint.

Managed backups and PITR are useful inputs, not a completed disaster-recovery
drill. Verify branch settings, extensions, roles and credentials after a restore;
do not assume a new branch inherits every setting. A same-region restore does
not prove regional recovery.
[Backup behavior](https://planetscale.com/docs/postgres/backups),
[branch compatibility](https://planetscale.com/docs/postgres/postgres-compatibility)

For a nonempty source, rehearse the selected transfer method into an empty
target. Preserve or deliberately reconstruct role ownership, grants, sequences,
extensions, RLS and the migration ledger; a per-database dump alone does not
recreate cluster roles. Never restore a full schema on top of an independently
migrated schema. Keep migration approval and drain requirements intact.

During cutover, fence all old writers, including background workers, migrations,
webhook consumers and active engine admissions. Keep compute stop deadlines
enforced. Reconcile external provider outcomes and security revocations before
resuming after database restoration; recovered outbox rows must not repeat an
already-completed external action or revive revoked authority.

`DATABASE_MAINTENANCE_MODE=true` supplies the application fence: only GET/HEAD
`/healthz` answers normally; all other HTTP routes return a no-store 503 with
Retry-After, upgrades are refused, and every worker and boot migration is off.
It intentionally accepts either schema side of the cutover and does not claim
schema verification. Deploy this reviewed mode to the old source, wait for old
replicas and in-flight external work to drain, then take a new immutable backup
and manifest. Rehearsal backups taken while writers were active are insufficient.
Restore into an empty target, use stable migration ownership, apply the complete
reviewed pending ladder with its controlled approvals, and verify exact source
data, sequences, policies, checksums and role boundaries. Run ANALYZE before
measuring restored query plans. A target maintenance boot may verify connectivity;
normal `DATABASE_MIGRATIONS_ON_BOOT=false` boot must verify the complete ledger
before reopening routes or background processing. First normal boot already
starts writers and is the rollback boundary, even before a user makes a request.

Retaining the old database is not sufficient rollback after the new database
accepts writes. Before reopening writes, validate the rollback boundary. Once
new writes exist, recovery needs a verified reverse data path or a forward fix;
switching back to stale data can lose confirmed state. Retire source resources
only after the agreed restore and observation criteria pass.

These checks extend steps 1, 5, 6 and 8 of the cloud roadmap. They do not close
the remaining agent-account, LSP, provider-cleanup or Daytona-host requirements.
Customer billing remains outside the current internal pilot.

## Stable migration owner and operator plans

Use an explicit login in every DSN. The driver and approval parser share the
same route validation, materialize port 5432 and reject query overrides,
duplicate parameters and transaction-pooler routes. Approvals include the
normalized login, including PlanetScale's branch suffix. Password-only rotation
preserves target identity. Old outstanding approvals must be regenerated;
existing append-only receipts remain intact.

Set `DATABASE_MIGRATION_ROLE=postgres` on the isolated migrator and owner
operator job, with a rotating login explicitly authorized to SET that role.
Do not put this role or migration credentials on the verify-only API service.
The validated role is selected in connection startup before any DDL or owner
check; ambient `PGOPTIONS` cannot substitute a different role. All new objects,
default privileges and security-definer functions therefore retain stable
ownership when the login rotates. Runtime transactions still enter `zeros_app`.
The compute-funding operator uses that restricted application path and does not
inherit migration-owner authority.

For an empty logical database on a cluster where `zeros_app` already exists,
the administrator that owns role administration must grant its stable migration
owner ADMIN and SET rights on `zeros_app` before running historical migration
0004. Keep INHERIT disabled. Role grants are cluster-wide: inspect existing
memberships first, retain the separate runtime login, and do not broaden it.
Applied historical migration files are never edited for this bootstrap.

Run `node dist/migrate.js --plan` from the exact reviewed artifact to obtain
`pendingMigrations` and `controlledApprovals` without ledger or schema writes.
Review that list with the drain/backup plan, then supply its exact filenames in
`CONTROL_PLANE_MIGRATION_APPROVALS` to the one-shot migrator. Strict execution
preflights all pending controlled approvals before committing any application
migration prefix. A fresh reset requires all eight current marked files;
already applied files need no additional approval.

The later boundaries require draining old lifecycle/allocator workers and
stopping existing hosted Boat allocations (0073), retiring old API/SSE readers
before changing security-event cursor order (0075), draining workers before
individual Pro and staff-pilot authority changes (0076), and draining funding
workers before account-wide credit accounting (0079). Do not run old and new
workers together or reinterpret historical payers, reservations or receipts.

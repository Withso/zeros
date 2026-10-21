import { randomBytes } from "node:crypto";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import pg from "pg";
import { describe, it, expect } from "vitest";
import { createPool, withSystemTx } from "./db.js";
import { ensureUser } from "./auth.js";
import { runMigrations } from "./migrate.js";
import { assertHostedDatabaseOwnership } from "./development-environment.js";
import { bindFixture, seedHostedFixture } from "../../../scripts/dev-environment/hosted-fixtures.mjs";
import { grantHostedRuntimeAuthority, repairHostedRuntimeAuthority } from "../../../scripts/dev-environment/hosted-database.mjs";

const url = process.env.TEST_DATABASE_URL;
const database = url ? describe : describe.skip;

// pg-pool resolves end() as soon as a client leaves its list, before the
// client socket finishes closing (pg-pool _remove filters _clients
// synchronously; client.end's socket 'end' arrives later). A
// DROP DATABASE ... WITH (FORCE) issued in that window terminates a backend
// whose half-closed client then raises a late 'error' — an unhandled error on
// a listenerless pool. End owned pools first, then wait until the server
// reports no remaining backends on the database before dropping it.
async function dropOwnedDatabase(cluster: pg.Pool, databaseName: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await cluster.query(
      "SELECT count(*)::int AS backends FROM pg_stat_activity WHERE datname = $1", [databaseName]);
    if (rows[0].backends === 0 || Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await cluster.query(`DROP DATABASE ${pg.escapeIdentifier(databaseName)} WITH (FORCE)`);
}

// A TCP relay in front of the test server. While held, it queues the client's
// bytes and half-close instead of forwarding them, so the backend stays
// connected after its client has sent Terminate. Unlike signalling the backend
// process, this also works when the server runs in another PID namespace, such
// as CI's Postgres service container.
async function holdingRelay(server: URL) {
  const upstream = { host: server.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(server.port || 5432) };
  let holding = false;
  const held: Array<() => void> = [];
  const sockets = new Set<Socket>();
  const forward = (action: () => void) => { if (holding) held.push(action); else action(); };
  const listener = createServer({ allowHalfOpen: true }, client => {
    const backend = connect({ ...upstream, allowHalfOpen: true });
    for (const socket of [client, backend]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => { client.destroy(); backend.destroy(); });
    }
    client.on("data", chunk => forward(() => backend.write(chunk)));
    client.on("end", () => forward(() => backend.end()));
    backend.on("data", chunk => client.write(chunk));
    backend.on("end", () => client.end());
  });
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  return {
    port: (listener.address() as AddressInfo).port,
    hold() { holding = true; },
    release() { holding = false; for (const action of held.splice(0)) action(); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    },
  };
}

database("hosted Dev database ownership", () => {
  it("ends a pool and force-drops its database without a late client error", async () => {
    // Regression for the CI "Unhandled Errors" 57P01 teardown flake: pg-pool
    // resolves end() before the client socket closes, so a FORCE drop in that
    // window terminated a backend whose half-closed client then raised a late,
    // unhandled pool error. The relay holds the client's Terminate across
    // end(), so the window is deterministic instead of a scheduler race.
    const relay = await holdingRelay(new URL(url!));
    const cluster = new pg.Pool({ connectionString: url, max: 1 });
    const databaseName = `zeros_dev_teardown_${randomBytes(6).toString("hex")}`;
    const clientBackends = async () => (await cluster.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend'",
      [databaseName])).rows[0].n;
    try {
      await cluster.query(`CREATE DATABASE ${pg.escapeIdentifier(databaseName)} TEMPLATE template0`);
      const target = new URL(url!);
      target.hostname = "127.0.0.1"; target.port = String(relay.port); target.pathname = `/${databaseName}`;
      const pool = new pg.Pool({ connectionString: target.toString(), max: 1 });
      const lateErrors: unknown[] = [];
      pool.on("error", err => lateErrors.push(err));
      await pool.query("SELECT 1");
      relay.hold();
      await pool.end();
      // The window is open: end() has resolved, but the held Terminate keeps
      // the backend connected.
      expect(await clientBackends()).toBe(1);
      const drop = dropOwnedDatabase(cluster, databaseName);
      await new Promise(resolve => setTimeout(resolve, 200));
      relay.release();
      await drop;
      // Give any late socket delivery a chance to reach the client.
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(lateErrors).toEqual([]);
    } finally {
      relay.release();
      await relay.close();
      await cluster.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(databaseName)} WITH (FORCE)`);
      await cluster.end();
    }
  }, 60_000);

  it("migrates with the marker present and confines the runtime to its own readonly generation marker", async () => {
    const cluster = new pg.Pool({ connectionString: url, max: 1 });
    const suffix = randomBytes(6).toString("hex");
    const databaseName = `zeros_dev_test_${suffix}`, role = `pscale_api_dev_test_${suffix}`;
    const password = randomBytes(24).toString("hex");
    const migrationUrl = new URL(url!); migrationUrl.pathname = `/${databaseName}`;
    const admin = new pg.Pool({ connectionString: migrationUrl.toString(), max: 1 });
    const identity = { owner: "a".repeat(24), generation: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222", sourceSha256: "a".repeat(64), workerInputsSha256: "b".repeat(64) };
    let runtime: pg.Pool | undefined;
    let databaseCreated = false, roleCreated = false;
    try {
      // Global setup already migrated the shared database. This test needs an
      // empty branch with its marker present before migrations, not that baseline.
      const baselineSql = "SELECT 'public'::regnamespace::oid AS public_oid, count(*)::int AS migrations FROM public.schema_migrations";
      const baseline = (await cluster.query(baselineSql)).rows;
      expect(baseline[0].migrations).toBeGreaterThan(0);
      await cluster.query(`CREATE DATABASE ${pg.escapeIdentifier(databaseName)} TEMPLATE template0`);
      databaseCreated = true;
      await admin.query("CREATE TABLE zeros_development_identity(owner text PRIMARY KEY,generation uuid NOT NULL)");
      await admin.query("INSERT INTO zeros_development_identity VALUES($1,$2)", [identity.owner, identity.generation]);
      await runMigrations(admin);
      // CI uses password authentication; a passwordless test login only worked
      // with a local trust-authenticated server.
      await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);
      roleCreated = true;
      await grantHostedRuntimeAuthority(admin, role);
      await admin.query(`REVOKE zeros_app FROM ${role}`);
      await repairHostedRuntimeAuthority(admin, { ...identity, backendStopped: true, roles: { runtime: { baseUsername: role } } });
      const connection = new URL(migrationUrl); connection.username = role; connection.password = password;
      runtime = createPool(connection.toString(), { maxConnections: 1 });
      expect((await runtime.query("SELECT current_user AS role")).rows).toEqual([{ role }]);
      await expect(assertHostedDatabaseOwnership(runtime, identity)).resolves.toBeUndefined();
      await expect(assertHostedDatabaseOwnership(runtime, { ...identity, owner: "b".repeat(24) })).rejects.toThrow(/ownership/);
      await expect(runtime.query("DELETE FROM zeros_development_identity")).rejects.toMatchObject({ code: "42501" });
      await admin.query(`GRANT CREATE ON SCHEMA public TO ${role}`);
      await expect(assertHostedDatabaseOwnership(runtime, identity)).rejects.toThrow(/privileges/);
      await admin.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);

      const user = await ensureUser(admin, { provider: "workos", providerSubject: "user_devfixture",
        email: "dev-fixture@example.test", displayName: "Dev fixture" });
      const organizationId = "33333333-3333-4333-8333-333333333333";
      const modules = {
        "manage-staff.js": () => import("./manage-staff.js"),
      };
      const fixture = bindFixture(identity, { workosUserId: "user_devfixture", workosOrganizationId: "org_devfixture",
        expectedEmail: "dev-fixture@example.test", expectedOrganizationSlug: "dev-fixture", computeAllowance: "pro-monthly", bootstrapOrganization: true });
      const fixtureProof = { userId: fixture.workosUserId, email: fixture.expectedEmail, organizationId: fixture.workosOrganizationId,
        externalId: organizationId, name: "Dev fixture", membershipId: "om_devfixture", membershipUpdatedAt: new Date().toISOString(), verifiedAt: Date.now() };
      const input = { runtime, migration: admin, withSystemTx, module: name => modules[name as keyof typeof modules](),
        request: { ...identity, fixture, fixtureProof, roles: { runtime: { url: connection.toString() }, migration: { url: migrationUrl.toString() } }, worker: { storageMiB: 20480 }, boat: { secondsPerDollar: 100_000 } } };
      await expect(seedHostedFixture(input)).resolves.toEqual({ seeded: true });
      await expect(seedHostedFixture(input)).resolves.toEqual({ seeded: true });
      expect((await admin.query("SELECT cloud_workspaces_allowed FROM organizations WHERE id=$1",[organizationId])).rows).toEqual([{cloud_workspaces_allowed:true}]);
      const member = await admin.query("SELECT role,workos_membership_id FROM organization_members WHERE org_id=$1 AND user_id=$2", [organizationId, user.id]);
      expect(member.rows).toEqual([{ role: "owner", workos_membership_id: "om_devfixture" }]);
      expect((await admin.query("SELECT count(*)::int AS n FROM teams WHERE org_id=$1", [organizationId])).rows).toEqual([{ n: 1 }]);
      await admin.query("UPDATE organizations SET slug='changed-fixture' WHERE id=$1", [organizationId]);
      await expect(seedHostedFixture(input)).rejects.toThrow(/conflicts/);
      expect((await cluster.query(baselineSql)).rows).toEqual(baseline);
    } finally {
      // pg-pool resolves end() before these clients' sockets finish closing;
      // dropOwnedDatabase waits out the half-closed backends so the FORCE drop
      // cannot deliver 57P01 to one of them as a late unhandled pool error.
      await runtime?.end();
      await admin.end();
      try {
        if (databaseCreated) await dropOwnedDatabase(cluster, databaseName);
      } finally {
        try { if (roleCreated) await cluster.query(`DROP ROLE ${role}`); }
        finally { await cluster.end(); }
      }
    }
    // A fresh database replays the full migration ladder, as in hosted Dev.
  }, 60_000);
});

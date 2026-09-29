import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, it, expect } from "vitest";
import { createPool, withSystemTx } from "./db.js";
import { ensureUser } from "./auth.js";
import { runMigrations } from "./migrate.js";
import { assertHostedDatabaseOwnership } from "./development-environment.js";
import { bindFixture, seedHostedFixture } from "../../../scripts/dev-environment/hosted-fixtures.mjs";
import { grantHostedRuntimeAuthority, repairHostedRuntimeAuthority } from "../../../scripts/dev-environment/hosted-database.mjs";
import { authorizeCloudWorkspaceOperation } from "./cloud-workspaces/authorization.js";
import { DatabaseProMonthlyAllowance, readProComputeUsage } from "./cloud-workspaces/pro-allowance.js";

const url = process.env.TEST_DATABASE_URL;
const database = url ? describe : describe.skip;

database("hosted Dev database ownership", () => {
  it("migrates with the marker present and confines the runtime to its own readonly generation marker", async () => {
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const role = `pscale_api_dev_test_${randomBytes(6).toString("hex")}`;
    const identity = { owner: "a".repeat(24), generation: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222", sourceSha256: "a".repeat(64), workerInputsSha256: "b".repeat(64) };
    let runtime: pg.Pool | undefined;
    try {
      await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await admin.query("CREATE TABLE zeros_development_identity(owner text PRIMARY KEY,generation uuid NOT NULL)");
      await admin.query("INSERT INTO zeros_development_identity VALUES($1,$2)", [identity.owner, identity.generation]);
      await runMigrations(admin);
      await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOBYPASSRLS`);
      await grantHostedRuntimeAuthority(admin, role);
      await admin.query(`REVOKE zeros_app FROM ${role}`);
      await repairHostedRuntimeAuthority(admin, { ...identity, backendStopped: true, roles: { runtime: { baseUsername: role } } });
      const connection = new URL(url!); connection.username = role; connection.password = "";
      runtime = createPool(connection.toString(), { maxConnections: 1 });
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
        "manage-cloud-workspace-quota.js": () => import("./manage-cloud-workspace-quota.js"),
        "cloud-workspaces/pro-allowance.js": () => import("./cloud-workspaces/pro-allowance.js"),
      };
      const fixture = bindFixture(identity, { workosUserId: "user_devfixture", workosOrganizationId: "org_devfixture",
        expectedEmail: "dev-fixture@example.test", expectedOrganizationSlug: "dev-fixture", computeAllowance: "pro-monthly", bootstrapOrganization: true });
      const fixtureProof = { userId: fixture.workosUserId, email: fixture.expectedEmail, organizationId: fixture.workosOrganizationId,
        externalId: organizationId, name: "Dev fixture", membershipId: "om_devfixture", membershipUpdatedAt: new Date().toISOString(), verifiedAt: Date.now() };
      const input = { runtime, migration: admin, withSystemTx, module: name => modules[name as keyof typeof modules](),
        request: { ...identity, fixture, fixtureProof, roles: { runtime: { url: connection.toString() }, migration: { url } }, worker: { storageMiB: 20480 }, boat: { secondsPerDollar: 100_000 } } };
      await expect(seedHostedFixture(input)).resolves.toEqual({ seeded: true });
      await expect(seedHostedFixture(input)).resolves.toEqual({ seeded: true });
      const credit = await admin.query("SELECT amount_micro_usd,source_kind FROM managed_compute_funding_receipts");
      expect(credit.rows).toEqual([{ amount_micro_usd: "18000000", source_kind: "pro_monthly_allowance" }]);
      expect((await admin.query("SELECT count(*)::int AS n FROM managed_compute_credit_grants")).rows).toEqual([{ n: 0 }]);
      const allowance = new DatabaseProMonthlyAllowance(runtime, { policyId: "hosted-dev", secondsPerDollar: 100_000 });
      await expect(allowance.ensure(user.id)).resolves.toMatchObject({ state: "ready", replayed: true });
      await expect(readProComputeUsage(runtime, user.id)).resolves.toMatchObject({ state: "ready", availablePercent: 100 });
      const teamId = (await admin.query("SELECT id FROM teams WHERE org_id=$1", [organizationId])).rows[0].id;
      await expect(withSystemTx(runtime, tx => authorizeCloudWorkspaceOperation(tx, {
        organizationId, teamId, actorUserId: user.id, billingOwnerUserId: user.id,
        workosEnabled: true, requireWorkspaceOwner: true,
      }))).resolves.toMatchObject({ entitlementScope: "account", plan: "pro" });
      const member = await admin.query("SELECT role,workos_membership_id FROM organization_members WHERE org_id=$1 AND user_id=$2", [organizationId, user.id]);
      expect(member.rows).toEqual([{ role: "owner", workos_membership_id: "om_devfixture" }]);
      expect((await admin.query("SELECT count(*)::int AS n FROM teams WHERE org_id=$1", [organizationId])).rows).toEqual([{ n: 1 }]);
      await admin.query("UPDATE organizations SET slug='changed-fixture' WHERE id=$1", [organizationId]);
      await expect(seedHostedFixture(input)).rejects.toThrow(/conflicts/);
    } finally {
      await runtime?.end();
      await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`).catch(() => {});
      await admin.end();
    }
  });
});

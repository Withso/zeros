import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import { createCloudComputerV2Routes } from "./computer-v2-routes.js";
import { DatabaseCloudWorkspaceManagementService } from "./management.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("Cloud Computer repository setup", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let service: DatabaseCloudComputerV2Service;
  const config = {} as CloudWorkspaceBackendConfig;
  const input = (expectedSettingsVersion = 0, script = "pnpm install") => ({
    expectedSettingsVersion,
    operationId: randomUUID(),
    script,
    timeoutSeconds: 900,
  });
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    service = new DatabaseCloudComputerV2Service(pool, config);
    const installationId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        "INSERT INTO github_authorizations(owner_user_id,app_variant,github_login) VALUES($1,'github.com','fixture-user')",
        [fixture.userId],
      );
      await tx.query(
        `INSERT INTO github_installations(id,github_installation_id,app_variant,owner_user_id,account_login,account_type,target_type)
      VALUES($1,123,'github.com',$2,'fixture-org','Organization','Organization')`,
        [installationId, fixture.userId],
      );
      await tx.query(
        "INSERT INTO cloud_github_connections(org_id,owner_user_id,installation_id) VALUES($1,$2,$3)",
        [fixture.organizationId, fixture.userId, installationId],
      );
      await tx.query(
        `INSERT INTO cloud_github_source_access(org_id,owner_user_id,installation_id,repository_owner,repository_name,forge_repository_id,actor_fingerprint,expires_at)
      VALUES($1,$2,$3,'fixture-org','repo','123',cloud_github_actor_fingerprint($1,$2),now()+interval '10 minutes')`,
        [fixture.organizationId, fixture.userId, installationId],
      );
    });
    await service.saveDraft(fixture.organizationId, fixture.userId, {
      expectedRevision: 0,
      repositories: [
        { id: "123", owner: "fixture-org", name: "repo", installationId },
      ],
      installScript: "",
      timeoutSeconds: 900,
    });
  });
  const update = (value = input(), repository = "123", user = fixture.userId) =>
    service.updateRepositorySetupScript(
      fixture.organizationId,
      user,
      repository,
      value,
    );
  async function current() {
    return (
      await pool.query(
        `SELECT head.current_version,version.document FROM repository_settings_heads head
      JOIN repository_settings_versions version ON version.org_id=head.org_id AND version.repository_id=head.repository_id
        AND version.scope=head.scope AND version.version=head.current_version
      JOIN repositories repo ON repo.id=head.repository_id
      WHERE head.org_id=$1 AND repo.forge_repository_id='123' AND head.scope='cloud'`,
        [fixture.organizationId],
      )
    ).rows[0];
  }

  it("updates only the cloud setup commands, including before the first workspace or build", async () => {
    const before = await service.read(fixture.organizationId, fixture.userId);
    expect(await update()).toMatchObject({ repositoryId: "123", version: 1 });
    const repositoryId = (
      await pool.query(
        "SELECT id FROM repositories WHERE org_id=$1 AND forge_repository_id='123'",
        [fixture.organizationId],
      )
    ).rows[0].id;
    const management = new DatabaseCloudWorkspaceManagementService(
      pool,
      config,
      { workosEnabled: false },
    );
    const otherValues = {
      env: { PUBLIC_SETTING: "repo-value" },
      git: { baseBranch: "release" },
      runtime: { node: "24" },
    };
    const secretRefs = [{ id: randomUUID(), name: "REGISTRY_TOKEN" }];
    await management.putRepositorySettings({
      organizationId: fixture.organizationId,
      actorUserId: fixture.userId,
      repositoryId,
      scope: "cloud",
      expectedVersion: 1,
      document: {
        values: otherValues,
        secretRefs,
        setupCommands: [{ command: "old", timeoutSeconds: 5 }],
      },
    });
    await management.putRepositorySettings({
      organizationId: fixture.organizationId,
      actorUserId: fixture.userId,
      repositoryId,
      scope: "shared",
      expectedVersion: 0,
      document: {
        values: { shared: true },
        setupCommands: [{ command: "shared", timeoutSeconds: 10 }],
      },
    });
    expect(await update(input(2, "pnpm test"))).toMatchObject({ version: 3 });
    expect((await current()).document).toEqual({
      values: otherValues,
      secretRefs,
      setupCommands: [{ command: "pnpm test", timeoutSeconds: 900 }],
    });
    expect(await service.read(fixture.organizationId, fixture.userId)).toEqual(
      before,
    );
    expect(
      (await pool.query("SELECT 1 FROM cloud_computer_v2_builds")).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT document FROM repository_settings_versions WHERE repository_id=$1 AND scope='shared'",
          [repositoryId],
        )
      ).rows[0].document,
    ).toEqual({
      values: { shared: true },
      setupCommands: [{ command: "shared", timeoutSeconds: 10 }],
    });
    expect(await update(input(3, ""))).toMatchObject({ version: 4 });
    expect((await current()).document).toEqual({
      values: otherValues,
      secretRefs,
      setupCommands: [],
    });
  });

  it("requires exact CAS even on repeated operation IDs and serializes simultaneous writers", async () => {
    const request = input();
    const results = await Promise.allSettled([
      update(request),
      update({ ...request, operationId: randomUUID(), script: "another" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failure = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({
      status: 409,
      code: "cloud_settings_version_conflict",
      details: { currentVersion: 1 },
    });
    await expect(update(request)).rejects.toMatchObject({ status: 409 });
    expect(Number((await current()).current_version)).toBe(1);
  });

  it("accepts an active repository removed from the draft, but refuses unselected and cross-org IDs", async () => {
    const built = await service.build(fixture.organizationId, fixture.userId, {
      expectedRevision: 1,
      operationId: randomUUID(),
    });
    const pins = {
      baseImageId: "fixture-base",
      runtimeId: "fixture-runtime",
      repositoryManifest: [
        { id: "123", owner: "fixture-org", name: "repo", sha: "a".repeat(40) },
      ],
    };
    await service.claimNextBuild(1);
    await service.markBuildStage(built.build.id, 1, "capture_confirmed", pins);
    await service.completeBuild(built.build.id, 1, {
      ...pins,
      template: {
        providerResourceId: null,
        accountScope: null,
        billingOrg: null,
        protectedContractDigest: "f".repeat(64),
        stoppedAt: new Date().toISOString(),
      },
    });
    const state = await service.read(fixture.organizationId, fixture.userId);
    await service.saveDraft(fixture.organizationId, fixture.userId, {
      expectedRevision: state.revision,
      repositories: [],
      installScript: "",
      timeoutSeconds: 900,
    });
    await expect(update()).resolves.toMatchObject({ version: 1 });
    await expect(update(input(), "456")).rejects.toMatchObject({ status: 404 });
    const other = await seedReadyCloudWorkspace(pool);
    await expect(
      service.updateRepositorySetupScript(
        other.organizationId,
        other.userId,
        "123",
        input(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it.each(["member", "support_admin", "nonstaff"])(
    "returns 403 for %s, including direct service callers",
    async (role) => {
      if (role === "member")
        await pool.query(
          "UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2",
          [fixture.organizationId, fixture.userId],
        );
      else
        await pool.query("UPDATE users SET staff_role=$2 WHERE id=$1", [
          fixture.userId,
          role === "nonstaff" ? null : role,
        ]);
      await expect(update()).rejects.toMatchObject({ status: 403 });
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("user", {
          id: fixture.userId,
          staffRole:
            role === "member" ? "developer" : role === "nonstaff" ? null : role,
        } as AuthedUser);
        await next();
      });
      app.route("/", createCloudComputerV2Routes(pool, config));
      app.onError((error, c) => {
        if (error instanceof HttpError)
          return c.json({ error: error.code }, error.status);
        throw error;
      });
      const response = await app.request(
        `/v1/organizations/${fixture.organizationId}/cloud-computer/v2/repositories/123/setup`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input()),
        },
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await current()).toBeUndefined();
    },
  );

  it.each([
    { timeoutSeconds: 901 },
    { timeoutSeconds: 0 },
    { script: "é".repeat(8193) },
    { script: "bad\0script" },
    { values: { env: {} } },
  ])("rejects non-narrow or invalid input", async (change) => {
    await expect(update({ ...input(), ...change })).rejects.toMatchObject({
      status: 422,
    });
    expect(await current()).toBeUndefined();
  });
});

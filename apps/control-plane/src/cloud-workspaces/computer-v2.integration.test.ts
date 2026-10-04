import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, withUserTx } from "../db.js";
import { createRoutes } from "../routes.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import {
  openCloudWorkspaceSecretBinding,
  resolveDatabaseCloudWorkspaceSettings,
} from "./settings.js";
import { DatabaseCloudWorkspaceManagementService } from "./management.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import { seedComputerTemplateRuntime, templateRuntime } from "./computer-template-test-fixtures.js";
import { requireCloudComputerAuthority } from "./computer.js";
import { createCloudComputerV2Routes } from "./computer-v2-routes.js";
import type {
  CloudComputerV2DraftInput,
  CloudComputerV2Repository,
} from "./computer-v2-contract.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const draft: CloudComputerV2DraftInput = {
  repositories: [],
  installScript: "",
  timeoutSeconds: 900,
};
const pins = {
  baseImageId: templateRuntime.baseImageId,
  runtimeId: templateRuntime.descriptor.runtimeId,
  repositoryManifest: [],
};
const template = () => ({
  providerResourceId: null,
  accountScope: null,
  billingOrg: null,
  protectedContractDigest: "f".repeat(64),
  stoppedAt: new Date().toISOString(),
});

d("Cloud Computer v2 metadata and completion CAS", () => {
  let pool: pg.Pool,
    service: DatabaseCloudComputerV2Service,
    fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let config: CloudWorkspaceBackendConfig;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 6,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await seedComputerTemplateRuntime(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    config = {
      settingsSecretKeyV1: randomBytes(32).toString("base64url"),
    } as CloudWorkspaceBackendConfig;
    service = new DatabaseCloudComputerV2Service(pool, config);
  });
  const read = (options = {}) =>
    service.read(fixture.organizationId, fixture.userId, options);
  const save = (
    expectedRevision = 0,
    input: CloudComputerV2DraftInput = draft,
    user = fixture.userId,
  ) =>
    service.saveDraft(fixture.organizationId, user, {
      expectedRevision,
      ...input,
    });
  const build = (
    expectedRevision = 0,
    operationId = randomUUID(),
    input?: CloudComputerV2DraftInput,
  ) =>
    service.build(fixture.organizationId, fixture.userId, {
      expectedRevision,
      operationId,
      ...(input ? { draft: input } : {}),
    });
  const cancel = (id: string, expectedRevision: number) =>
    service.cancel(fixture.organizationId, fixture.userId, id, {
      expectedRevision,
    });
  async function finish(
    id: string,
    fence = 1,
    manifest = pins.repositoryManifest,
  ) {
    await service.markBuildStage(id, fence, "capture_confirmed", {
      ...pins,
      repositoryManifest: manifest,
    });
    return service.completeBuild(id, fence, {
      ...pins,
      repositoryManifest: manifest,
      template: template(),
    });
  }
  async function successful(expectedRevision = 0) {
    const result = await build(expectedRevision);
    expect((await service.claimNextBuild(1))?.build.id).toBe(result.build.id);
    expect(await finish(result.build.id)).toMatchObject({
      state: "succeeded",
      activated: true,
    });
    return result.build;
  }
  async function admin() {
    const other = await seedReadyCloudWorkspace(pool);
    await pool.query(
      "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'admin')",
      [fixture.organizationId, other.userId],
    );
    return other.userId;
  }
  async function proof(
    user = fixture.userId,
  ): Promise<CloudComputerV2Repository> {
    const installationId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        "INSERT INTO github_authorizations(owner_user_id,app_variant,github_login) VALUES($1,'github.com','fixture-user') ON CONFLICT DO NOTHING",
        [user],
      );
      await tx.query(
        `INSERT INTO github_installations(id,github_installation_id,app_variant,owner_user_id,account_login,account_type,target_type)
        VALUES($1,123,'github.com',$2,'fixture-org','Organization','Organization')`,
        [installationId, user],
      );
      await tx.query(
        "INSERT INTO cloud_github_connections(org_id,owner_user_id,installation_id) VALUES($1,$2,$3)",
        [fixture.organizationId, user, installationId],
      );
      await tx.query(
        `INSERT INTO cloud_github_source_access(org_id,owner_user_id,installation_id,repository_owner,repository_name,
        forge_repository_id,actor_fingerprint,expires_at) VALUES($1,$2,$3,'fixture-org','repo','123',cloud_github_actor_fingerprint($1,$2),now()+interval '10 minutes')`,
        [fixture.organizationId, user, installationId],
      );
    });
    return {
      id: "123",
      owner: "fixture-org",
      name: "repo",
      installationId,
      requestedRef: null,
    };
  }
  it("pins the runtime before repository SHAs exist and refuses to repin it", async () => {
    const repository = await proof();
    const request = await build(0, randomUUID(), { ...draft, repositories: [repository] });
    await service.claimNextBuild(1);
    expect(await service.markBuildStage(request.build.id, 1, "runtime", {
      baseImageId: pins.baseImageId, runtimeId: pins.runtimeId,
    })).toMatchObject({ applied: true });
    const row = (await pool.query("SELECT base_image_id,runtime_id,repository_manifest FROM cloud_computer_v2_builds WHERE id=$1", [request.build.id])).rows[0];
    expect(row).toEqual({ base_image_id: pins.baseImageId, runtime_id: pins.runtimeId, repository_manifest: null });
    await expect(service.markBuildStage(request.build.id, 1, "repositories", {
      baseImageId: pins.baseImageId, runtimeId: "other-runtime",
    })).rejects.toMatchObject({ code: "cloud_computer_build_pin_conflict" });
  });
  it("rejects completion after its deadline even before the expiry sweep", async () => {
    const request = await build();
    await service.claimNextBuild(1);
    await service.markBuildStage(request.build.id, 1, "capture_confirmed", pins);
    await pool.query("UPDATE cloud_computer_v2_builds SET deadline_at=now()-interval '1 second' WHERE id=$1", [request.build.id]);
    expect(await service.completeBuild(request.build.id, 1, { ...pins, template: template() }))
      .toMatchObject({ activated: false, state: "failed" });
    expect((await read()).active).toBeNull();
  });
  it("fences completion when its deadline expires while runtime eligibility is checked", async () => {
    const request = await build();
    await service.claimNextBuild(1);
    await service.markBuildStage(request.build.id, 1, "capture_confirmed", pins);
    const completed = await service.completeBuild(request.build.id, 1, { ...pins, template: template() }, async (tx) => {
      await tx.query("UPDATE cloud_computer_v2_builds SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [request.build.id]);
      return true;
    });
    expect(completed).toMatchObject({ activated: false, state: "failed" });
    expect((await read()).active).toBeNull();
  });
  it("reads virtual defaults and saves without creating builds or provider allocations", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No provider calls are authorized"));
    try {
      const before = (await pool.query("SELECT count(*) FROM cloud_workspaces"))
        .rows[0].count;
      expect(await read()).toMatchObject({
        state: "not_built",
        revision: 0,
        draft: { ...draft, configId: null, environment: [] },
        canManage: true,
      });
      expect((await pool.query("SELECT 1 FROM cloud_computers")).rowCount).toBe(
        0,
      );
      expect(await save()).toMatchObject({ revision: 1, unbuiltChanges: true });
      expect(
        (await pool.query("SELECT 1 FROM cloud_computer_v2_builds")).rowCount,
      ).toBe(0);
      expect(
        (await pool.query("SELECT count(*) FROM cloud_workspaces")).rows[0]
          .count,
      ).toBe(before);
      expect(
        (await pool.query("SELECT 1 FROM cloud_computer_images")).rowCount,
      ).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it("org creation remains metadata-only", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", {
        id: fixture.userId,
        staffRole: "developer",
      } as AuthedUser);
      await next();
    });
    app.route("/", createRoutes(pool));
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network allocation"));
    try {
      const before = (await pool.query("SELECT count(*) FROM cloud_workspaces"))
        .rows[0].count;
      const response = await app.request("/v1/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "C1 fixture organization" }),
      });
      expect(response.status).toBe(201);
      expect(
        (await pool.query("SELECT count(*) FROM cloud_workspaces")).rows[0]
          .count,
      ).toBe(before);
      expect((await pool.query("SELECT 1 FROM cloud_computers")).rowCount).toBe(
        0,
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it("serializes two admins and rejects stale draft/discard/build revisions", async () => {
    const other = await admin();
    const results = await Promise.allSettled([
      save(),
      save(0, { ...draft, installScript: "true" }, other),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: {
        code: "cloud_computer_changed",
        details: { currentRevision: 1 },
      },
    });
    await expect(
      service.discard(fixture.organizationId, fixture.userId, {
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(build()).rejects.toMatchObject({ status: 409 });
    expect(
      (await pool.query("SELECT 1 FROM cloud_computer_v2_configs")).rowCount,
    ).toBe(1);
  });
  it("first click atomically creates default config, head and version; replays survive intervening edits", async () => {
    const operation = randomUUID();
    const result = await build(0, operation);
    expect(result).toMatchObject({
      revision: 1,
      build: {
        version: 1,
        state: "queued",
        stage: "queued",
        acceptedRevision: 1,
      },
    });
    expect(await read()).toMatchObject({
      state: "building",
      revision: 1,
      latestBuild: { id: result.build.id },
    });
    await save(1, { ...draft, installScript: "true" });
    expect(await build(0, operation)).toMatchObject({
      revision: 1,
      build: { id: result.build.id },
      replayed: true,
    });
    await expect(build(0, operation, draft)).rejects.toMatchObject({
      code: "cloud_computer_operation_conflict",
    });
    expect(
      (await pool.query("SELECT next_version FROM cloud_computer_v2_heads"))
        .rows[0].next_version,
    ).toBe("2");
  });
  it("rolls back first-click drafts when repository proof fails", async () => {
    await expect(
      build(0, randomUUID(), {
        ...draft,
        repositories: [
          {
            id: "123",
            owner: "fixture-org",
            name: "repo",
            installationId: randomUUID(),
            requestedRef: null,
          },
        ],
        environment: [{ op: "set", name: "SETTING", value: "synthetic-value" }],
      }),
    ).rejects.toMatchObject({
      code: "github_cloud_source_authorization_required",
    });
    for (const table of [
      "cloud_computers",
      "cloud_computer_v2_heads",
      "cloud_computer_v2_configs",
      "secret_bindings",
      "cloud_computer_v2_builds",
    ])
      expect((await pool.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
  });
  it("rolls back encrypted environment writes if a later draft operation fails", async () => {
    await expect(
      build(0, randomUUID(), {
        ...draft,
        environment: [
          { op: "set", name: "SETTING", value: "synthetic-value" },
          { op: "preserve", name: "MISSING_SETTING" },
        ],
      }),
    ).rejects.toMatchObject({ code: "cloud_computer_environment_unavailable" });
    for (const table of [
      "cloud_computers",
      "cloud_computer_v2_heads",
      "cloud_computer_v2_configs",
      "secret_bindings",
      "secret_binding_versions",
    ])
      expect((await pool.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
  });
  it("enforces one pending build in service and database, with the conflicting build ID", async () => {
    const first = await build();
    await expect(build(1)).rejects.toMatchObject({
      code: "cloud_computer_build_active",
      details: { currentBuildId: first.build.id },
    });
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO cloud_computer_v2_builds(id,org_id,version,config_id,accepted_revision,requested_by,operation_id)
      VALUES($1,$2,2,$3,1,$4,$5)`,
          [
            randomUUID(),
            fixture.organizationId,
            first.build.configId,
            fixture.userId,
            randomUUID(),
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect(
      (await pool.query("SELECT next_version FROM cloud_computer_v2_heads"))
        .rows[0].next_version,
    ).toBe("2");
  });
  it("requires each adding admin's own proof, but preserves already configured org-shared repositories", async () => {
    const repository = await proof();
    const other = await admin();
    await expect(
      save(0, { ...draft, repositories: [repository] }, other),
    ).rejects.toMatchObject({
      code: "github_cloud_source_authorization_required",
    });
    await save(0, { ...draft, repositories: [repository] });
    await pool.query(
      "UPDATE cloud_github_source_access SET expires_at=now()-interval '1 minute'",
    );
    await expect(
      save(
        1,
        { ...draft, repositories: [repository], installScript: "true" },
        other,
      ),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(
      save(
        2,
        {
          ...draft,
          repositories: [{ ...repository, installationId: randomUUID() }],
        },
        other,
      ),
    ).rejects.toMatchObject({
      code: "github_cloud_source_authorization_required",
    });
  });
  it("pins encrypted environment versions, preserves omissions, and removes without revoking", async () => {
    const value = randomBytes(16).toString("hex");
    await save(0, {
      ...draft,
      environment: [{ op: "set", name: "SETTING", value }],
    });
    const first = await read();
    expect(first.draft.environment).toEqual([{ name: "SETTING", set: true }]);
    expect(JSON.stringify(first).includes(value)).toBe(false);
    const row = (
      await pool.query(`SELECT ref.*,version.key_version,version.nonce,version.ciphertext,version.auth_tag,version.verifier_scheme,version.value_verifier
      FROM cloud_computer_environment_refs ref JOIN secret_binding_versions version ON version.binding_id=ref.binding_id AND version.version=ref.binding_version`)
    ).rows[0];
    const opened = openCloudWorkspaceSecretBinding(
      {
        keyVersion: row.key_version,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
        authTag: row.auth_tag,
        verifierScheme: row.verifier_scheme,
        valueVerifier: row.value_verifier,
      },
      {
        bindingId: row.binding_id,
        organizationId: fixture.organizationId,
        version: 1,
        name: "SETTING",
      },
      config.settingsSecretKeyV1!,
    );
    expect(opened === value).toBe(true);
    await save(1);
    expect((await read()).draft.environment).toEqual([
      { name: "SETTING", set: true },
    ]);
    await save(2, {
      ...draft,
      environment: [
        { op: "set", name: "SETTING", value: "new-synthetic-value" },
      ],
    });
    expect(
      (
        await pool.query(
          "SELECT binding_version FROM cloud_computer_environment_refs ORDER BY binding_version",
        )
      ).rows.map((row) => row.binding_version),
    ).toEqual(["1", "1", "2"]);
    await save(3, {
      ...draft,
      environment: [{ op: "remove", name: "SETTING" }],
    });
    expect((await read()).draft.environment).toEqual([]);
    expect(
      (await pool.query("SELECT state FROM secret_bindings")).rows[0].state,
    ).toBe("active");
    expect(
      (
        await pool.query(
          "SELECT 1 FROM secret_binding_versions WHERE retired_at IS NOT NULL",
        )
      ).rowCount,
    ).toBe(0);
  });
  it("keeps draft Save and Discard isolated from published legacy environment settings", async () => {
    const management = new DatabaseCloudWorkspaceManagementService(
      pool,
      config,
      {
        workosEnabled: false,
      },
    );
    const bindingId = randomUUID();
    await management.createSecretBinding({
      id: bindingId,
      organizationId: fixture.organizationId,
      actorUserId: fixture.userId,
      name: "SETTING",
      purpose: "environment",
      placement: "cloud",
      value: "published-fixture-value",
    });
    await management.createEnvironmentProfile({
      id: randomUUID(),
      organizationId: fixture.organizationId,
      actorUserId: fixture.userId,
      name: "Legacy environment",
      placement: "cloud",
      isDefault: true,
      document: { secretRefs: [{ id: bindingId, name: "SETTING" }] },
    });
    const resolve = () =>
      withSystemTx(pool, async (tx) => {
        const settings = await resolveDatabaseCloudWorkspaceSettings(tx, {
          organizationId: fixture.organizationId,
          repositoryId: fixture.repositoryId,
          workspaceId: fixture.workspaceId,
          generation: 1,
          actorUserId: fixture.userId,
          isPersonal: false,
          setupSecretKeyV1: config.settingsSecretKeyV1,
        });
        return settings.sourceVersions.secretBindings;
      });
    const published = { SETTING: { id: bindingId, version: 1 } };
    expect(await resolve()).toEqual(published);
    await save(0, {
      ...draft,
      environment: [
        { op: "set", name: "SETTING", value: "draft-fixture-value" },
      ],
    });
    expect(await resolve()).toEqual(published);
    expect((await read()).draft.environment).toEqual([
      { name: "SETTING", set: true },
    ]);
    await service.discard(fixture.organizationId, fixture.userId, {
      expectedRevision: 1,
    });
    expect(await resolve()).toEqual(published);
    expect((await read()).draft.environment).toEqual([]);
    expect(
      (await pool.query("SELECT 1 FROM cloud_computer_v2_builds")).rowCount,
    ).toBe(0);

    // Rotation owns publication and must allocate past the unpublished draft version.
    expect(
      await management.rotateSecretBinding({
        id: bindingId,
        organizationId: fixture.organizationId,
        actorUserId: fixture.userId,
        expectedVersion: 1,
        value: "rotated-fixture-value",
      }),
    ).toMatchObject({ binding: { version: 3 } });
    expect(await resolve()).toEqual({ SETTING: { id: bindingId, version: 3 } });
    await save(2, {
      ...draft,
      environment: [
        { op: "set", name: "SETTING", value: "later-draft-fixture-value" },
      ],
    });
    expect(await resolve()).toEqual({ SETTING: { id: bindingId, version: 3 } });
    expect(
      (
        await pool.query(
          "SELECT version FROM secret_binding_versions WHERE binding_id=$1 ORDER BY version",
          [bindingId],
        )
      ).rows.map((row) => row.version),
    ).toEqual(["1", "2", "3", "4"]);
  });
  it.each(["active", "historical"])(
    "generic rotation preserves %s computer environment pins and explicit revocation still fences them",
    async (kind) => {
      const management = new DatabaseCloudWorkspaceManagementService(
        pool,
        config,
        {
          workosEnabled: false,
        },
      );
      await save(0, {
        ...draft,
        environment: [
          { op: "set", name: "SETTING", value: "computer-fixture-value" },
        ],
      });
      const first = await successful(1);
      expect((await read()).draft.environment).toEqual([
        { name: "SETTING", set: true },
      ]);
      const pin = (
        await pool.query(
          "SELECT binding_id,binding_version FROM cloud_computer_environment_refs WHERE config_id=$1",
          [first.configId],
        )
      ).rows[0];
      if (kind === "historical") {
        await save((await read()).revision, {
          ...draft,
          environment: [{ op: "remove", name: "SETTING" }],
        });
        await successful((await read()).revision);
        expect((await read()).previous?.version).toBe(first.version);
      }
      expect(
        await management.rotateSecretBinding({
          id: pin.binding_id,
          organizationId: fixture.organizationId,
          actorUserId: fixture.userId,
          expectedVersion: 1,
          value: "rotated-fixture-value",
        }),
      ).toMatchObject({
        binding: { version: 2 },
        generationsUsingPreviousVersion: 0,
      });
      expect(
        (
          await pool.query(
            "SELECT retired_at IS NOT NULL AS retired FROM secret_binding_versions WHERE binding_id=$1 AND version=$2",
            [pin.binding_id, pin.binding_version],
          )
        ).rows[0].retired,
      ).toBe(false);
      const activated = await service.activate(
        fixture.organizationId,
        fixture.userId,
        first.version,
        {
          expectedRevision: (await read()).revision,
          operationId: randomUUID(),
        },
      );
      const rebuilt = await service.rebuild(
        fixture.organizationId,
        fixture.userId,
        first.version,
        {
          expectedRevision: activated.revision,
          operationId: randomUUID(),
        },
      );
      expect(rebuilt.build.state).toBe("queued");
      expect((await read()).draft.environment).toEqual([
        { name: "SETTING", set: true },
      ]);
      await cancel(rebuilt.build.id, rebuilt.revision);
      await management.revokeSecretBinding({
        id: pin.binding_id,
        organizationId: fixture.organizationId,
        actorUserId: fixture.userId,
        expectedVersion: 2,
      });
      expect((await read()).draft.environment).toEqual([
        { name: "SETTING", set: false },
      ]);
      for (const operation of [
        service.activate.bind(service),
        service.rebuild.bind(service),
      ]) {
        await expect(
          operation(fixture.organizationId, fixture.userId, first.version, {
            expectedRevision: (await read()).revision,
            operationId: randomUUID(),
          }),
        ).rejects.toMatchObject({
          code: "cloud_computer_environment_unavailable",
        });
      }
    },
  );
  it("deduplicates secret-bearing builds privately and rejects changed values or actors", async () => {
    const operation = randomUUID(),
      input = {
        ...draft,
        environment: [
          {
            op: "set" as const,
            name: "SETTING",
            value: randomBytes(16).toString("hex"),
          },
        ],
      };
    const result = await build(0, operation, input);
    expect(await build(0, operation, input)).toMatchObject({
      replayed: true,
      build: { id: result.build.id },
    });
    await expect(
      build(0, operation, {
        ...input,
        environment: [{ op: "set", name: "SETTING", value: "different" }],
      }),
    ).rejects.toMatchObject({ code: "cloud_computer_operation_conflict" });
    const other = await admin();
    await expect(
      service.build(fixture.organizationId, other, {
        expectedRevision: 0,
        operationId: operation,
        draft: input,
      }),
    ).rejects.toMatchObject({ code: "cloud_computer_operation_conflict" });
    expect(
      JSON.stringify(
        await service.getBuild(
          fixture.organizationId,
          fixture.userId,
          result.build.id,
        ),
      ).includes(input.environment[0]!.value),
    ).toBe(false);
  });
  it("cancels queued builds immediately and running builds by request, without rolling back completed versions", async () => {
    const queued = await build();
    expect(await cancel(queued.build.id, queued.revision)).toMatchObject({
      cancelled: true,
      build: { state: "cancelled" },
    });
    expect(await service.claimNextBuild(1)).toBeNull();
    const running = await build((await read()).revision);
    await service.claimNextBuild(1);
    expect(await cancel(running.build.id, running.revision)).toMatchObject({
      cancelRequested: true,
      build: { state: "running" },
    });
    expect(await finish(running.build.id)).toMatchObject({
      state: "superseded",
      activated: false,
    });
    expect((await read()).active).toBeNull();
    const done = await successful((await read()).revision);
    expect(await cancel(done.id, done.acceptedRevision)).toMatchObject({
      alreadyCompleted: true,
      cancelled: false,
    });
    expect((await read()).active?.id).toBe(done.id);
  });
  it("serializes the cancel/completion race", async () => {
    const request = await build();
    await service.claimNextBuild(1);
    await service.markBuildStage(
      request.build.id,
      1,
      "capture_confirmed",
      pins,
    );
    const [completion, cancellation] = await Promise.all([
      service.completeBuild(request.build.id, 1, {
        ...pins,
        template: template(),
      }),
      cancel(request.build.id, request.revision),
    ]);
    const state = await read();
    expect(completion.state).toBe(state.active ? "succeeded" : "superseded");
    expect(cancellation.alreadyCompleted).toBe(Boolean(state.active));
  });
  it("supersedes a successful result after draft/discard changes and rejects stale worker fences", async () => {
    const request = await build();
    await service.claimNextBuild(7);
    expect(
      await service.markBuildStage(request.build.id, 6, "install"),
    ).toMatchObject({ applied: false });
    await save(request.revision, { ...draft, installScript: "true" });
    await service.markBuildStage(
      request.build.id,
      7,
      "capture_confirmed",
      pins,
    );
    expect(
      await service.completeBuild(request.build.id, 6, {
        ...pins,
        template: template(),
      }),
    ).toMatchObject({ applied: false });
    expect(
      await service.completeBuild(request.build.id, 7, {
        ...pins,
        template: template(),
      }),
    ).toMatchObject({ state: "superseded", activated: false });
    expect((await read()).active).toBeNull();
    const next = await build((await read()).revision);
    await service.claimNextBuild(8);
    await service.discard(fixture.organizationId, fixture.userId, {
      expectedRevision: next.revision,
    });
    expect(await finish(next.build.id, 8)).toMatchObject({
      state: "superseded",
    });
  });
  it("requires exact runtime/base pins and capture-confirmed evidence before automatic activation", async () => {
    const request = await build();
    await service.claimNextBuild(1);
    await expect(
      service.completeBuild(request.build.id, 1, {
        ...pins,
        template: template(),
      }),
    ).rejects.toMatchObject({ code: "cloud_computer_build_not_ready" });
    await service.markBuildStage(
      request.build.id,
      1,
      "capture_confirmed",
      pins,
    );
    expect(
      await service.completeBuild(request.build.id, 1, {
        ...pins,
        runtimeId: "different-runtime",
        template: template(),
      }),
    ).toMatchObject({ state: "superseded", activated: false });
  });
  it("checks draft identity and the latest request independently of the head revision", async () => {
    let request = await build();
    await service.claimNextBuild(1);
    await service.markBuildStage(
      request.build.id,
      1,
      "capture_confirmed",
      pins,
    );
    const newerId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      // Simulate another writer publishing a newer request while retaining
      // the older worker's result. Completion must check every CAS field.
      await tx.query(
        `INSERT INTO cloud_computer_v2_builds(id,org_id,version,config_id,accepted_revision,requested_by,operation_id,state,completed_at)
        VALUES($1,$2,2,$3,1,$4,$5,'cancelled',now())`,
        [
          newerId,
          fixture.organizationId,
          request.build.configId,
          fixture.userId,
          randomUUID(),
        ],
      );
      await tx.query(
        "UPDATE cloud_computer_v2_heads SET latest_build_id=$2,next_version=3 WHERE org_id=$1",
        [fixture.organizationId, newerId],
      );
    });
    expect(
      await service.completeBuild(request.build.id, 1, {
        ...pins,
        template: template(),
      }),
    ).toMatchObject({ state: "superseded", activated: false });
    request = await build((await read()).revision);
    await service.claimNextBuild(2);
    await service.markBuildStage(
      request.build.id,
      2,
      "capture_confirmed",
      pins,
    );
    await save(request.revision);
    await pool.query(
      "UPDATE cloud_computer_v2_heads SET revision=$2 WHERE org_id=$1",
      [fixture.organizationId, request.revision],
    );
    expect(
      await service.completeBuild(request.build.id, 2, {
        ...pins,
        template: template(),
      }),
    ).toMatchObject({ state: "superseded", activated: false });
    expect((await read()).active).toBeNull();
  });
  it("a cancelled worker cannot activate or fail a later request", async () => {
    const first = await build();
    await service.claimNextBuild(1);
    await cancel(first.build.id, first.revision);
    expect(
      await service.failBuild(first.build.id, 1, "build_failed"),
    ).toMatchObject({ state: "cancelled" });
    const second = await build((await read()).revision);
    await service.claimNextBuild(2);
    expect(
      await service.completeBuild(first.build.id, 1, {
        ...pins,
        template: template(),
      }),
    ).toMatchObject({ applied: false, state: "cancelled" });
    expect(await finish(second.build.id, 2)).toMatchObject({
      state: "succeeded",
      activated: true,
    });
    expect((await read()).active?.id).toBe(second.build.id);
  });
  it("activates only retained ready templates, preserves the draft, and replays after later edits", async () => {
    const first = await successful();
    const second = await successful((await read()).revision);
    let state = await read();
    expect(state).toMatchObject({
      active: { id: second.id },
      previous: { id: first.id },
      unbuiltChanges: false,
    });
    await save(state.revision, { ...draft, installScript: "true" });
    state = await read();
    const operationId = randomUUID(),
      request = { expectedRevision: state.revision, operationId };
    const result = await service.activate(
      fixture.organizationId,
      fixture.userId,
      first.version,
      request,
    );
    expect(await read()).toMatchObject({
      active: { id: first.id },
      previous: { id: second.id },
      draft: { installScript: "true" },
      unbuiltChanges: true,
    });
    await save(result.revision, { ...draft, installScript: "false" });
    expect(
      await service.activate(
        fixture.organizationId,
        fixture.userId,
        first.version,
        request,
      ),
    ).toMatchObject({ revision: result.revision, replayed: true });
    await expect(
      service.activate(
        fixture.organizationId,
        fixture.userId,
        second.version,
        request,
      ),
    ).rejects.toMatchObject({ code: "cloud_computer_operation_conflict" });
    await pool.query(
      "UPDATE cloud_computer_templates SET state='retired',retired_at=now() WHERE build_id=$1",
      [second.id],
    );
    await expect(
      service.activate(fixture.organizationId, fixture.userId, second.version, {
        expectedRevision: (await read()).revision,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "cloud_computer_not_built" });
  });
  it("rebuilds historical configurations using recorded SHAs and a new immutable version", async () => {
    const repository = await proof();
    const result = await build(0, randomUUID(), {
      ...draft,
      repositories: [repository],
    });
    await service.claimNextBuild(1);
    const manifest = [
      {
        id: repository.id,
        owner: repository.owner,
        name: repository.name,
        sha: "a".repeat(40),
      },
    ];
    await finish(result.build.id, 1, manifest);
    await pool.query(
      "UPDATE cloud_github_source_access SET expires_at=now()-interval '1 minute'",
    );
    const request = {
      expectedRevision: (await read()).revision,
      operationId: randomUUID(),
    };
    const rebuilt = await service.rebuild(
      fixture.organizationId,
      fixture.userId,
      1,
      request,
    );
    expect(rebuilt.build).toMatchObject({
      version: 2,
      rebuiltFromBuildId: result.build.id,
      state: "queued",
    });
    expect((await read()).draft.repositories[0]?.requestedRef).toBe(
      manifest[0]!.sha,
    );
    expect(
      await service.rebuild(fixture.organizationId, fixture.userId, 1, request),
    ).toMatchObject({ replayed: true, build: { id: rebuilt.build.id } });
    expect(rebuilt.build.configId).not.toBe(result.build.configId);
  });
  it("rejects every unavailable template state and preserves existing workspace generations on activation", async () => {
    const first = await successful(),
      second = await successful((await read()).revision);
    const before = (
      await pool.query(
        "SELECT generation,image_ref FROM cloud_workspace_generations WHERE workspace_id=$1 ORDER BY generation",
        [fixture.workspaceId],
      )
    ).rows;
    for (const state of ["pending", "retiring", "quarantined"]) {
      await pool.query(
        "UPDATE cloud_computer_templates SET state=$2 WHERE build_id=$1",
        [first.id, state],
      );
      await expect(
        service.activate(
          fixture.organizationId,
          fixture.userId,
          first.version,
          {
            expectedRevision: (await read()).revision,
            operationId: randomUUID(),
          },
        ),
      ).rejects.toMatchObject({ code: "cloud_computer_not_built" });
    }
    await pool.query(
      "UPDATE cloud_computer_templates SET state='ready' WHERE build_id=$1",
      [first.id],
    );
    await service.activate(
      fixture.organizationId,
      fixture.userId,
      first.version,
      { expectedRevision: (await read()).revision, operationId: randomUUID() },
    );
    expect(await read()).toMatchObject({
      active: { id: first.id },
      previous: { id: second.id },
    });
    expect(
      (
        await pool.query(
          "SELECT generation,image_ref FROM cloud_workspace_generations WHERE workspace_id=$1 ORDER BY generation",
          [fixture.workspaceId],
        )
      ).rows,
    ).toEqual(before);
  });
  it("discard restores the active configuration without revoking draft-only environment edits", async () => {
    const active = await successful();
    await save((await read()).revision, {
      ...draft,
      installScript: "true",
      environment: [{ op: "set", name: "SETTING", value: "synthetic-value" }],
    });
    expect(
      await service.discard(fixture.organizationId, fixture.userId, {
        expectedRevision: (await read()).revision,
      }),
    ).toMatchObject({ configId: active.configId, unbuiltChanges: false });
    expect((await read()).draft).toMatchObject({
      installScript: "",
      environment: [],
    });
    expect(
      (await pool.query("SELECT state FROM secret_bindings")).rows[0].state,
    ).toBe("active");
  });
  it("bounds history with an org-bound version cursor", async () => {
    for (let index = 0; index < 4; index++) {
      const request = await build((await read()).revision);
      await cancel(request.build.id, request.revision);
    }
    const first = await read({ limit: 2 });
    expect(first.history.builds.map((row) => row.version)).toEqual([4, 3]);
    const second = await read({ limit: 2, cursor: first.history.nextCursor! });
    expect(second.history.builds.map((row) => row.version)).toEqual([2, 1]);
    expect(second.history.nextCursor).toBeNull();
    await expect(read({ cursor: "invalid" })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
    const other = await seedReadyCloudWorkspace(pool);
    await expect(
      service.read(other.organizationId, other.userId, {
        cursor: first.history.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });
  it("keeps log rows/tails bounded, ordered and cursor-readable, with a retained truncation marker", async () => {
    // The worker supplies its streaming redactor in C3; the default withholds
    // arbitrary text. This identity callback is only for synthetic volume.
    service = new DatabaseCloudComputerV2Service(pool, config, {
      sanitizeLog: (value) => value,
    });
    const request = await build();
    await service.claimNextBuild(1);
    for (let index = 0; index < 6; index++)
      await service.appendBuildLog(request.build.id, 1, {
        stream: "stdout",
        stage: "install",
        text: "é".repeat(100_000),
      });
    const sizes = (
      await pool.query(
        "SELECT max(octet_length(text)) AS row_bytes,sum(octet_length(text)) AS total_bytes FROM cloud_computer_build_logs",
      )
    ).rows[0];
    expect(Number(sizes.row_bytes)).toBeLessThanOrEqual(8192);
    expect(Number(sizes.total_bytes)).toBeLessThanOrEqual(1_048_576);
    const first = await service.logs(
      fixture.organizationId,
      fixture.userId,
      request.build.id,
      { after: 0, limit: 3 },
    );
    expect(first.truncated).toBe(true);
    expect(first.entries[0]?.text).toContain("truncated");
    expect(first.entries).toHaveLength(3);
    const next = await service.logs(
      fixture.organizationId,
      fixture.userId,
      request.build.id,
      { after: first.nextAfter, limit: 3 },
    );
    expect(next.entries[0]!.seq).toBeGreaterThan(first.nextAfter);
    expect(
      await service.appendBuildLog(request.build.id, 2, {
        stream: "stderr",
        stage: "install",
        text: "stale",
      }),
    ).toMatchObject({ applied: false });
  });
  it("withholds untrusted log text by default and never returns private provider metadata", async () => {
    const request = await build();
    await service.claimNextBuild(1);
    const value = randomBytes(16).toString("hex");
    await service.appendBuildLog(request.build.id, 1, {
      stream: "stderr",
      stage: "install",
      text: value,
    });
    const logs = await service.logs(
      fixture.organizationId,
      fixture.userId,
      request.build.id,
    );
    expect(logs.entries[0]?.text).toBe(
      "[cloud workspace setup output withheld]",
    );
    expect(JSON.stringify(logs).includes(value)).toBe(false);
    expect(
      Object.keys(
        await service.getBuild(
          fixture.organizationId,
          fixture.userId,
          request.build.id,
        ),
      ),
    ).not.toContain("workerFence");
  });
  it("authorizes staff and organization roles independently for all services and reads", async () => {
    const request = await build();
    const other = await seedReadyCloudWorkspace(pool);
    await expect(
      service.getBuild(fixture.organizationId, other.userId, request.build.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.logs(other.organizationId, other.userId, request.build.id),
    ).rejects.toMatchObject({ status: 404 });
    await pool.query(
      "UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2",
      [fixture.organizationId, fixture.userId],
    );
    expect(await read()).toMatchObject({ canManage: false });
    for (const mutation of [
      () => save(1),
      () => cancel(request.build.id, 1),
      () => build(1),
      () =>
        service.discard(fixture.organizationId, fixture.userId, {
          expectedRevision: 1,
        }),
      () =>
        service.activate(fixture.organizationId, fixture.userId, 1, {
          expectedRevision: 1,
          operationId: randomUUID(),
        }),
      () =>
        service.rebuild(fixture.organizationId, fixture.userId, 1, {
          expectedRevision: 1,
          operationId: randomUUID(),
        }),
    ])
      await expect(mutation()).rejects.toMatchObject({ status: 403 });
    for (const role of [null, "support_admin"]) {
      await pool.query("UPDATE users SET staff_role=$2 WHERE id=$1", [
        fixture.userId,
        role,
      ]);
      await expect(read()).rejects.toMatchObject({ status: 404 });
      await expect(
        service.getBuild(
          fixture.organizationId,
          fixture.userId,
          request.build.id,
        ),
      ).rejects.toMatchObject({ status: 404 });
    }
  });
  it("denies an admin demoted before the membership row is locked", async () => {
    const other = await admin();
    await expect(
      withSystemTx(pool, async (tx) => {
        const query = tx.query.bind(tx);
        const guarded = Object.create(tx) as typeof tx;
        guarded.query = (async (text: string, values: unknown[]) => {
          const result = await query(text, values);
          if (text.includes("SELECT om.role"))
            await pool.query(
              "UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2",
              [fixture.organizationId, other],
            );
          return result;
        }) as typeof tx.query;
        return requireCloudComputerAuthority(
          guarded,
          fixture.organizationId,
          other,
          true,
        );
      }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
  it("forces system-only RLS and immutable config grants; wrong-org heads cannot reference builds", async () => {
    const request = await build();
    await expect(
      withUserTx(pool, fixture.userId, (tx) =>
        tx.query("SELECT 1 FROM cloud_computer_v2_configs"),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query("UPDATE cloud_computer_v2_configs SET install_script='other'"),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const other = await seedReadyCloudWorkspace(pool);
    await service.saveDraft(other.organizationId, other.userId, {
      expectedRevision: 0,
      ...draft,
    });
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          "UPDATE cloud_computer_v2_heads SET active_build_id=$2 WHERE org_id=$1",
          [other.organizationId, request.build.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("does not allow a system writer to remove the v2 enrollment fence", async () => {
    await save();
    await expect(
      withSystemTx(pool, async (tx) => {
        expect(
          (
            await tx.query(
              "SELECT current_user AS role,app_is_system() AS system",
            )
          ).rows[0],
        ).toEqual({ role: "zeros_app", system: true });
        return tx.query("DELETE FROM cloud_computer_v2_heads WHERE org_id=$1", [
          fixture.organizationId,
        ]);
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await read()).revision).toBe(1);
  });
  it.each([
    "DELETE FROM cloud_computer_v2_builds WHERE org_id=$1",
    "DELETE FROM cloud_computer_templates WHERE org_id=$1",
    "UPDATE cloud_computer_build_logs SET text='rewritten' WHERE org_id=$1",
  ])("denies restricted system writes: %s", async (statement) => {
    const request = await build();
    await service.claimNextBuild(1);
    expect(
      await service.appendBuildLog(request.build.id, 1, {
        stream: "system",
        stage: "install",
        text: "fixture output",
      }),
    ).toMatchObject({ applied: true });
    await finish(request.build.id);
    await expect(
      withSystemTx(pool, (tx) => tx.query(statement, [fixture.organizationId])),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("cannot extend a published config or rewrite a build's accepted identity", async () => {
    const request = await build();
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO cloud_computer_v2_config_repositories
      (config_id,org_id,position,repository_id,repository_owner,repository_name,installation_id)
      VALUES($1,$2,0,'123','fixture-org','repo',$3)`,
          [request.build.configId, fixture.organizationId, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          "UPDATE cloud_computer_v2_builds SET accepted_revision=accepted_revision+1 WHERE id=$1",
          [request.build.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await service.claimNextBuild(1);
    await service.markBuildStage(request.build.id, 1, "runtime", pins);
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          "UPDATE cloud_computer_v2_builds SET runtime_id='other-runtime' WHERE id=$1",
          [request.build.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("enforces a database-wide worker cap and settles failures without activation", async () => {
    await build();
    const other = await seedReadyCloudWorkspace(pool),
      third = await seedReadyCloudWorkspace(pool);
    await service.build(other.organizationId, other.userId, {
      expectedRevision: 0,
      operationId: randomUUID(),
    });
    await service.build(third.organizationId, third.userId, {
      expectedRevision: 0,
      operationId: randomUUID(),
    });
    const first = await service.claimNextBuild(1);
    expect(await service.claimNextBuild(2)).not.toBeNull();
    expect(await service.claimNextBuild(3)).toBeNull();
    expect(
      await service.failBuild(first!.build.id, 9, "build_failed"),
    ).toMatchObject({ applied: false });
    expect(
      await service.failBuild(first!.build.id, 1, "build_failed"),
    ).toMatchObject({ state: "failed" });
    expect(await service.claimNextBuild(3)).not.toBeNull();
    expect((await read()).state).toBe("failed");
  });
  it("enrollment cannot race or coexist with an active legacy build", async () => {
    const { DatabaseCloudComputerService } = await import("./computer.js");
    const legacy = new DatabaseCloudComputerService(pool, config);
    await legacy.save(fixture.organizationId, fixture.userId, {
      expectedRevision: 0,
      operationId: randomUUID(),
      document: draft,
      sources: [],
    });
    await pool.query(
      `INSERT INTO cloud_computer_builds(id,org_id,profile_id,version,requested_by,repository_owner,repository_name)
      SELECT $1,org_id,profile_id,1,$2,'','' FROM cloud_computers WHERE org_id=$3`,
      [randomUUID(), fixture.userId, fixture.organizationId],
    );
    await expect(save()).rejects.toMatchObject({
      code: "cloud_computer_build_active",
    });
    expect(
      (await pool.query("SELECT 1 FROM cloud_computer_v2_heads")).rowCount,
    ).toBe(0);
  });
  it("fences direct legacy build inserts after enrollment", async () => {
    await save();
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO cloud_computer_builds(id,org_id,profile_id,version,requested_by,repository_owner,repository_name)
      SELECT $1,org_id,profile_id,1,$2,'','' FROM cloud_computers WHERE org_id=$3`,
          [randomUUID(), fixture.userId, fixture.organizationId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (await pool.query("SELECT 1 FROM cloud_computer_builds")).rowCount,
    ).toBe(0);
  });
  it("mounts the v2 staff API with no-store and rejects an outsider's build ID", async () => {
    const request = await build();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", {
        id: fixture.userId,
        staffRole: "developer",
      } as AuthedUser);
      await next();
    });
    app.route("/", createCloudComputerV2Routes(pool, config));
    app.onError((error, c) => {
      if (error instanceof HttpError)
        return c.json({ error: error.code }, error.status);
      throw error;
    });
    const root = `/v1/organizations/${fixture.organizationId}/cloud-computer/v2`;
    const response = await app.request(root);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      (await app.request(`${root}/builds/${request.build.id}`)).status,
    ).toBe(200);
    expect((await app.request(`${root}/builds/${randomUUID()}`)).status).toBe(
      404,
    );
  });
});

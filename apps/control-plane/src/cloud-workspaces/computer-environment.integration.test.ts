import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudWorkspaceManagementService } from "./management.js";
import { resolveDatabaseCloudWorkspaceSettings } from "./settings.js";
import { openCloudWorkspaceSetupSecret } from "./setup-materials.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { resolveCloudComputerExecutionEnvironment } from "./computer-environment.js";
import {
  consentTestPersonalEnvironment,
  persistTestComputerSettings,
  pinTestComputerEnvironment,
} from "./computer-environment-test-fixtures.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("generation-pinned computer environment", () => {
  let pool: pg.Pool,
    fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,
    management: DatabaseCloudWorkspaceManagementService;
  const key = randomBytes(32).toString("base64url");
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    management = new DatabaseCloudWorkspaceManagementService(
      pool,
      { settingsSecretKeyV1: key } as CloudWorkspaceBackendConfig,
      { workosEnabled: false },
    );
  });
  const resolve = (actorUserId = fixture.userId) =>
    withSystemTx(pool, (tx) =>
      resolveDatabaseCloudWorkspaceSettings(tx, {
        ...fixture,
        generation: 1,
        actorUserId,
        isPersonal: false,
        setupSecretKeyV1: key,
      }),
    );
  async function environment(actorUserId = fixture.userId) {
    const settings = await resolve(actorUserId);
    const values = Object.fromEntries(
      settings.setupSecrets.map((secret) => [
        secret.name,
        openCloudWorkspaceSetupSecret(
          {
            ...secret,
            key_version: secret.keyVersion,
            auth_tag: secret.authTag,
          },
          { ...fixture, generation: 1 },
          { 1: key },
        ),
      ]),
    );
    return { settings, values };
  }
  const repository = (
    scope: "shared" | "cloud",
    env: Record<string, string>,
    setup = "repo-hook",
  ) =>
    management.putRepositorySettings({
      ...fixture,
      actorUserId: fixture.userId,
      scope,
      expectedVersion: 0,
      document: {
        values: { env, editor: { fontSize: 17 } },
        setupCommands: [{ command: setup, timeoutSeconds: 30 }],
      },
    });

  it("merges org < repository shared < repository cloud < consented personal < managed values without plaintext snapshots", async () => {
    const org = {
      ORG_ONLY: "org-only-value",
      REPO_WINS: "org-repo",
      PERSONAL_WINS: "org-personal",
      ALL_LAYERS: "org-all",
      CLOUD_WINS: "org-cloud",
      POLICY_WINS: "org-policy",
    };
    await pinTestComputerEnvironment(pool, fixture, key, org);
    await repository(
      "shared",
      {
        REPO_WINS: "shared-repo",
        ALL_LAYERS: "shared-all",
        CLOUD_WINS: "shared-cloud",
      },
      "never-shared-hook",
    );
    await repository("cloud", {
      REPO_WINS: "cloud-repo",
      ALL_LAYERS: "cloud-all",
      CLOUD_WINS: "cloud-value",
      POLICY_WINS: "repo-policy",
    });
    await consentTestPersonalEnvironment(
      pool,
      fixture.organizationId,
      fixture.userId,
      {
        PERSONAL_WINS: "personal-value",
        ALL_LAYERS: "personal-all",
        POLICY_WINS: "personal-policy",
        UNCONSENTED: "private-not-consented",
      },
      [
        "/values/env/PERSONAL_WINS",
        "/values/env/ALL_LAYERS",
        "/values/env/POLICY_WINS",
        "/values/editor",
      ],
    );
    await pool.query(
      "INSERT INTO organization_cloud_policy_versions(org_id,version,document,created_by) VALUES($1,1,$2::jsonb,$3)",
      [
        fixture.organizationId,
        JSON.stringify({ values: { env: { POLICY_WINS: "managed-value" } } }),
        fixture.userId,
      ],
    );
    await pool.query(
      "INSERT INTO organization_cloud_policy_heads(org_id,current_version) VALUES($1,1)",
      [fixture.organizationId],
    );
    const { values, settings } = await environment();
    expect(values).toEqual({
      ORG_ONLY: org.ORG_ONLY,
      REPO_WINS: "cloud-repo",
      PERSONAL_WINS: "personal-value",
      ALL_LAYERS: "personal-all",
      CLOUD_WINS: "cloud-value",
      POLICY_WINS: "managed-value",
    });
    expect(settings.resolved.snapshot.values).toEqual({
      editor: { fontSize: 17 },
    });
    expect(settings.resolved.snapshot.setupCommands).toEqual([
      { command: "repo-hook", timeoutSeconds: 30 },
    ]);
    const publicSnapshot = JSON.stringify({
      document: settings.resolved.snapshot,
      sources: settings.sourceVersions,
      provenance: settings.resolved.provenance,
    });
    for (const value of Object.values(values))
      expect(publicSnapshot.includes(value)).toBe(false);
    expect(publicSnapshot.includes("private-not-consented")).toBe(false);
  });

  it("keeps unbuilt drafts, later binding current versions, removals and other generations out of the pinned config", async () => {
    const { service } = await pinTestComputerEnvironment(pool, fixture, key, {
      SETTING: "active-value",
    });
    const active = await service.read(fixture.organizationId, fixture.userId);
    await service.saveDraft(fixture.organizationId, fixture.userId, {
      expectedRevision: active.revision,
      repositories: [],
      installScript: "",
      timeoutSeconds: 900,
      environment: [
        { op: "set", name: "SETTING", value: "unbuilt-value" },
        { op: "set", name: "DRAFT_ONLY", value: "draft-only-value" },
      ],
    });
    const bindingId = (
      await pool.query(
        "SELECT binding_id FROM cloud_computer_environment_refs WHERE name='SETTING' ORDER BY binding_version LIMIT 1",
      )
    ).rows[0].binding_id;
    await management.rotateSecretBinding({
      ...fixture,
      id: bindingId,
      actorUserId: fixture.userId,
      expectedVersion: 1,
      value: "generic-current-value",
    });
    expect((await environment()).values).toEqual({ SETTING: "active-value" });
    const next = await service.read(fixture.organizationId, fixture.userId);
    await service.saveDraft(fixture.organizationId, fixture.userId, {
      expectedRevision: next.revision,
      repositories: [],
      installScript: "",
      timeoutSeconds: 900,
      environment: [{ op: "remove", name: "SETTING" }],
    });
    expect((await environment()).values).toEqual({ SETTING: "active-value" });
    await expect(withSystemTx(pool, (tx) =>
      resolveDatabaseCloudWorkspaceSettings(tx, {
        ...fixture,
        generation: 2,
        actorUserId: fixture.userId,
        isPersonal: false,
        setupSecretKeyV1: key,
      }),
    )).rejects.toMatchObject({ code: "cloud_workspace_v2_required" });
  });

  it.each(["revoked", "retired", "wrong-purpose", "missing"])(
    "fails closed for a %s pinned version even when personal overrides it",
    async (change) => {
      await pinTestComputerEnvironment(pool, fixture, key, {
        SETTING: "authorized-value",
      });
      await consentTestPersonalEnvironment(
        pool,
        fixture.organizationId,
        fixture.userId,
        { SETTING: "personal-value" },
      );
      if (change === "revoked")
        await pool.query(
          "UPDATE secret_bindings SET state='revoked',revoked_at=now()",
        );
      if (change === "retired")
        await pool.query("UPDATE secret_binding_versions SET retired_at=now()");
      if (change === "wrong-purpose")
        await pool.query("UPDATE secret_bindings SET purpose='mcp'");
      // PostgreSQL prevents ordinary deletion of a referenced version. Simulate
      // damaged storage as the disposable database owner to test a LEFT JOIN.
      if (change === "missing") {
        const tx = await pool.connect();
        try {
          await tx.query("BEGIN");
          await tx.query("SET LOCAL session_replication_role=replica");
          await tx.query("DELETE FROM secret_binding_versions");
          await tx.query("COMMIT");
        } finally {
          tx.release();
        }
      }
      await expect(resolve()).rejects.toMatchObject({
        status: 409,
        code: "computer_environment_revoked",
      });
    },
  );

  it("uses only the admitting actor's explicit personal overlay", async () => {
    await pinTestComputerEnvironment(pool, fixture, key, {
      COLLISION: "org-value",
    });
    await repository("cloud", { COLLISION: "repo-value" });
    await consentTestPersonalEnvironment(
      pool,
      fixture.organizationId,
      fixture.userId,
      {
        COLLISION: "creator-private-value",
        CREATOR_ONLY: "creator-only-value",
      },
    );
    const other = await seedReadyCloudWorkspace(pool);
    await pool.query(
      "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",
      [fixture.organizationId, other.userId],
    );
    const before = (await environment(other.userId)).values;
    expect(before).toEqual({ COLLISION: "repo-value" });
    const consent = await consentTestPersonalEnvironment(
      pool,
      fixture.organizationId,
      other.userId,
      { COLLISION: "other-personal-value" },
    );
    expect((await environment(other.userId)).values).toEqual({
      COLLISION: "other-personal-value",
    });
    expect((await environment()).values).toEqual({
      COLLISION: "creator-private-value",
      CREATOR_ONLY: "creator-only-value",
    });
    await pool.query(
      "UPDATE personal_profile_inheritance_consents SET state='revoked',revoked_at=now() WHERE id=$1",
      [consent],
    );
    expect((await environment(other.userId)).values).toEqual(before);
  });

  it("freezes repository env and secret versions while each later admission resolves its own personal consent", async () => {
    await pinTestComputerEnvironment(pool, fixture, key, {
      ORG_ONLY: "org-pinned-value",
      SETTING: "org-setting",
    });
    const bindingId = randomUUID();
    await management.createSecretBinding({
      ...fixture,
      actorUserId: fixture.userId,
      id: bindingId,
      name: "REPO_SECRET",
      purpose: "environment",
      placement: "cloud",
      value: "repo-secret-original",
    });
    await management.putRepositorySettings({
      ...fixture,
      actorUserId: fixture.userId,
      scope: "cloud",
      expectedVersion: 0,
      document: {
        values: { env: { SETTING: "repo-original" } },
        secretRefs: [{ id: bindingId, name: "REPO_SECRET" }],
      },
    });
    await consentTestPersonalEnvironment(
      pool,
      fixture.organizationId,
      fixture.userId,
      { SETTING: "creator-only-value" },
    );
    await persistTestComputerSettings(pool, fixture, await resolve());
    await management.rotateSecretBinding({
      ...fixture,
      actorUserId: fixture.userId,
      id: bindingId,
      expectedVersion: 1,
      value: "repo-secret-new",
    });
    await management.putRepositorySettings({
      ...fixture,
      actorUserId: fixture.userId,
      scope: "cloud",
      expectedVersion: 1,
      document: {
        values: { env: { SETTING: "repo-new", NEW_ONLY: "new-value" } },
      },
    });
    const other = await seedReadyCloudWorkspace(pool);
    const read = (user: string) =>
      withSystemTx(pool, (tx) =>
        resolveCloudComputerExecutionEnvironment(
          tx,
          { ...fixture, generation: 1 },
          user,
          { setupSecretKeyV1: key },
        ),
      );
    expect(await read(other.userId)).toEqual({
      ORG_ONLY: "org-pinned-value",
      SETTING: "repo-original",
      REPO_SECRET: "repo-secret-original",
    });
    expect(await read(fixture.userId)).toEqual({
      ORG_ONLY: "org-pinned-value",
      SETTING: "creator-only-value",
      REPO_SECRET: "repo-secret-original",
    });
    await consentTestPersonalEnvironment(
      pool,
      fixture.organizationId,
      other.userId,
      { SETTING: "other-only-value" },
    );
    expect(await read(other.userId)).toEqual({
      ORG_ONLY: "org-pinned-value",
      SETTING: "other-only-value",
      REPO_SECRET: "repo-secret-original",
    });
  });

  it("security revocation stops a pinned generation even when its org binding was overridden at setup", async () => {
    await pinTestComputerEnvironment(pool, fixture, key, {
      SETTING: "org-sensitive-value",
    });
    await repository("cloud", { SETTING: "repo-override" });
    await persistTestComputerSettings(pool, fixture, await resolve());
    const id = (
      await pool.query(
        "SELECT binding_id FROM cloud_computer_environment_refs WHERE name='SETTING'",
      )
    ).rows[0].binding_id;
    const revoked = await management.revokeSecretBinding({
      ...fixture,
      actorUserId: fixture.userId,
      id,
      expectedVersion: 1,
    });
    expect(revoked.stoppedWorkspaceIds).toEqual([fixture.workspaceId]);
  });

  it("preserves explicitly empty repository and personal overrides without plaintext snapshot values", async () => {
    await pinTestComputerEnvironment(pool, fixture, key, {
      REPO_EMPTY: "org-repo",
      PERSONAL_EMPTY: "org-personal",
    });
    await repository("cloud", {
      REPO_EMPTY: "",
      PERSONAL_EMPTY: "repo-personal",
    });
    await consentTestPersonalEnvironment(
      pool,
      fixture.organizationId,
      fixture.userId,
      { PERSONAL_EMPTY: "" },
    );
    const settings = await resolve();
    expect(settings.resolved.snapshot.values).not.toHaveProperty("env");
    await persistTestComputerSettings(pool, fixture, settings);
    await expect(
      withSystemTx(pool, (tx) =>
        resolveCloudComputerExecutionEnvironment(
          tx,
          { ...fixture, generation: 1 },
          fixture.userId,
          { setupSecretKeyV1: key },
        ),
      ),
    ).resolves.toEqual({ REPO_EMPTY: "", PERSONAL_EMPTY: "" });
  });

  it("refuses delivery while a pinned binding is being revoked, without waiting behind workspace locks", async () => {
    await pinTestComputerEnvironment(pool, fixture, key, {
      SETTING: "org-sensitive-value",
    });
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM secret_bindings FOR UPDATE");
      await expect(resolve()).rejects.toMatchObject({
        status: 503,
        code: "computer_environment_busy",
      });
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  });

  it.each([
    "ZEROS_WORKSPACE_ID",
    "ZEROS_INTERNAL_TOKEN",
    "ZEROS_GIT_AUTH_TOKEN",
    "CONDUCTOR_PORT",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "GIT_CONFIG_COUNT",
    "NODE_OPTIONS",
    "BASH_ENV",
    "HTTP_PROXY",
  ])("rejects reserved %s from v2 repository values", async (name) => {
    await pinTestComputerEnvironment(pool, fixture, key, {});
    await repository("cloud", { [name]: "not-delivered" });
    await expect(resolve()).rejects.toMatchObject({
      status: 422,
      code: "cloud_settings_invalid",
    });
  });
});

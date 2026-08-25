import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import pg from "pg";

import { ensureUser, type AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, withUserTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { createCloudWorkspaceRoutes } from "./routes.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const cloudConfig: CloudWorkspaceBackendConfig = {
  provider: "daytona",
  apiKey: "daytona-api-key-for-integration-tests",
  apiUrl: "https://api.example.test",
  target: "eu",
  snapshotId: "snap-pinned",
  imageRef: "snap-pinned",
  architecture: "linux/amd64",
  cpuMillicores: 2_000,
  memoryMiB: 4_096,
  storageMiB: 20_480,
  sourceCommit: "a".repeat(40),
  operationTimeoutSeconds: 30,
  autoArchiveMinutes: 10_080,
  reconcileIntervalMs: 1_000,
};

d("cloud workspace API contracts", () => {
  let pool: pg.Pool;
  let actor: AuthedUser;
  let owner: AuthedUser;
  let outsider: AuthedUser;
  let orgId: string;
  let teamId: string;
  let installationId: string;
  let app: Hono;

  const signup = (name: string) => {
    const sub = randomUUID();
    return ensureUser(pool, {
      provider: "auth0",
      providerSubject: sub,
      email: `${name.toLowerCase()}-${sub}@example.com`,
      displayName: name,
    });
  };

  const request = (
    path: string,
    init?: {
      method?: string;
      key?: string;
      body?: Record<string, unknown>;
    },
  ) =>
    app.request(path, {
      method: init?.method ?? "GET",
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.key ? { "idempotency-key": init.key } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });

  const createBody = (overrides: Record<string, unknown> = {}) => ({
    name: "Compiler Work",
    repository: {
      forge: "github.com",
      owner: "withso",
      name: "zeros",
      revision: "main",
      githubInstallationId: installationId,
    },
    ...overrides,
  });

  const createWorkspace = async (key = randomUUID()) => {
    const response = await request(
      `/v1/organizations/${orgId}/cloud-workspaces`,
      { method: "POST", key, body: createBody() },
    );
    const body = (await response.json()) as {
      workspace: { id: string; status: string; desiredState: string };
      intent: { id: string; state: string };
    };
    return { response, body, key };
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 6 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    owner = await signup("Owner");
    outsider = await signup("Outsider");
    actor = owner;

    const seeded = await withSystemTx(pool, async (tx) => {
      const organization = await tx.query<{ id: string }>(
        `INSERT INTO organizations (
           slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, 'Cloud Org', $2, false, true) RETURNING id`,
        [`cloud-${randomUUID()}`, owner.id],
      );
      const organizationId = organization.rows[0]!.id;
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [organizationId, owner.id],
      );
      const team = await tx.query<{ id: string }>(
        `INSERT INTO teams (
           org_id, slug, name, is_default, created_by
         ) VALUES ($1, 'default', 'Default', true, $2) RETURNING id`,
        [organizationId, owner.id],
      );
      const defaultTeamId = team.rows[0]!.id;
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [defaultTeamId, organizationId, owner.id],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_quotas (
           org_id, max_workspaces, max_running_workspaces,
           max_cpu_millicores, max_memory_mib, max_storage_mib
         ) VALUES ($1, 5, 5, 10000, 20480, 102400)`,
        [organizationId],
      );
      await tx.query(
        `INSERT INTO github_authorizations (
           owner_user_id, app_variant, github_login
         ) VALUES ($1, 'github.com', 'owner')`,
        [owner.id],
      );
      const installation = await tx.query<{ id: string }>(
        `INSERT INTO github_installations (
           github_installation_id, app_variant, owner_user_id,
           account_login, account_type, target_type
         ) VALUES (123456, 'github.com', $1, 'owner', 'User', 'User')
         RETURNING id`,
        [owner.id],
      );
      return {
        organizationId,
        defaultTeamId,
        installationId: installation.rows[0]!.id,
      };
    });
    orgId = seeded.organizationId;
    teamId = seeded.defaultTeamId;
    installationId = seeded.installationId;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", actor);
      await next();
    });
    app.route("/", createCloudWorkspaceRoutes(pool, cloudConfig));
    app.onError((error, c) => {
      if (error instanceof HttpError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }
      throw error;
    });
  });

  it("creates one stable workspace + generation + intent and never exposes the provider id", async () => {
    const created = await createWorkspace();
    expect(created.response.status, JSON.stringify(created.body)).toBe(202);
    expect(created.body).toMatchObject({
      workspace: {
        status: "requested",
        desiredState: "running",
        generation: {
          number: 1,
          provider: "daytona",
          imageRef: "snap-pinned",
          observedState: "absent",
        },
      },
      intent: { state: "queued" },
    });
    expect(JSON.stringify(created.body)).not.toContain("providerResourceId");

    const records = await pool.query(
      `SELECT cw.id, g.generation, i.operation, a.action
       FROM cloud_workspaces cw
       JOIN cloud_workspace_generations g ON g.workspace_id = cw.id
       JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
       JOIN audit_log a ON a.org_id = cw.org_id
       WHERE cw.id = $1 AND a.action = 'cloud_workspace.create_requested'`,
      [created.body.workspace.id],
    );
    expect(records.rows).toEqual([
      expect.objectContaining({
        id: created.body.workspace.id,
        generation: 1,
        operation: "create",
        action: "cloud_workspace.create_requested",
      }),
    ]);
  });

  it("replays an identical request and rejects parameter reuse", async () => {
    const key = randomUUID();
    const first = await createWorkspace(key);
    const replay = await createWorkspace(key);
    expect([first.response.status, replay.response.status]).toEqual([202, 200]);
    expect(replay.response.headers.get("idempotency-replayed")).toBe("true");
    expect(replay.body.workspace.id).toBe(first.body.workspace.id);

    const mismatch = await request(
      `/v1/organizations/${orgId}/cloud-workspaces`,
      {
        method: "POST",
        key,
        body: createBody({ name: "Different parameters" }),
      },
    );
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: { code: "idempotency_key_reused" },
    });
  });

  it("serializes concurrent duplicate creates into exactly one provider intent", async () => {
    const key = randomUUID();
    const [first, second] = await Promise.all([
      request(`/v1/organizations/${orgId}/cloud-workspaces`, {
        method: "POST",
        key,
        body: createBody(),
      }),
      request(`/v1/organizations/${orgId}/cloud-workspaces`, {
        method: "POST",
        key,
        body: createBody(),
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 202]);
    const count = await pool.query(
      `SELECT count(DISTINCT cw.id)::int AS workspaces,
              count(DISTINCT i.id)::int AS intents
       FROM cloud_workspaces cw
       JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
       WHERE cw.org_id = $1`,
      [orgId],
    );
    expect(count.rows[0]).toEqual({ workspaces: 1, intents: 1 });
  });

  it("fails closed on Personal, missing quota, foreign repository grants, and exhausted quota", async () => {
    const personal = await pool.query<{ id: string }>(
      `SELECT id FROM organizations
       WHERE created_by = $1 AND is_personal AND deleted_at IS NULL`,
      [owner.id],
    );
    const personalResponse = await request(
      `/v1/organizations/${personal.rows[0]!.id}/cloud-workspaces`,
      { method: "POST", key: randomUUID(), body: createBody() },
    );
    expect(personalResponse.status).toBe(409);
    await expect(personalResponse.json()).resolves.toMatchObject({
      error: { code: "personal_organization" },
    });

    await pool.query(`DELETE FROM cloud_workspace_quotas WHERE org_id = $1`, [
      orgId,
    ]);
    const noQuota = await createWorkspace();
    expect(noQuota.response.status).toBe(409);
    expect(noQuota.body).toMatchObject({
      error: { code: "cloud_quota_not_configured" },
    });

    await pool.query(
      `INSERT INTO cloud_workspace_quotas (
         org_id, max_workspaces, max_running_workspaces,
         max_cpu_millicores, max_memory_mib, max_storage_mib
       ) VALUES ($1, 1, 1, 2000, 4096, 20480)`,
      [orgId],
    );
    const foreign = await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO github_authorizations (
           owner_user_id, app_variant, github_login
         ) VALUES ($1, 'github.com', 'outsider')`,
        [outsider.id],
      );
      return (
        await tx.query<{ id: string }>(
          `INSERT INTO github_installations (
             github_installation_id, app_variant, owner_user_id,
             account_login, account_type, target_type
           ) VALUES (654321, 'github.com', $1, 'outsider', 'User', 'User')
           RETURNING id`,
          [outsider.id],
        )
      ).rows[0]!.id;
    });
    const foreignGrant = await request(
      `/v1/organizations/${orgId}/cloud-workspaces`,
      {
        method: "POST",
        key: randomUUID(),
        body: createBody({
          repository: {
            forge: "github.com",
            owner: "other",
            name: "repo",
            revision: "main",
            githubInstallationId: foreign,
          },
        }),
      },
    );
    expect(foreignGrant.status).toBe(404);

    expect((await createWorkspace()).response.status).toBe(202);
    const exhausted = await createWorkspace();
    expect(exhausted.response.status).toBe(409);
    expect(exhausted.body).toMatchObject({
      error: { code: "cloud_quota_exceeded" },
    });
  });

  it("records lifecycle intent, supersedes queued work, and revokes grants before delete", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    await pool.query(
      `INSERT INTO cloud_workspace_endpoint_grants (
         workspace_id, generation, org_id, account_user_id, purpose,
         audience, token_hash, expires_at
       ) VALUES ($1, 1, $2, $3, 'engine-connect', 'engine', $4, now() + interval '5 minutes')`,
      [
        workspaceId,
        orgId,
        owner.id,
        createHash("sha256").update(randomUUID()).digest(),
      ],
    );

    const stopped = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/stop`,
      { method: "POST", key: randomUUID() },
    );
    expect(stopped.status).toBe(202);
    await expect(stopped.json()).resolves.toMatchObject({
      workspace: { status: "stopping", desiredState: "stopped" },
      intent: { operation: "stop", state: "queued" },
    });
    expect(
      (
        await pool.query<{ revoked: boolean }>(
          `SELECT revoked_at IS NOT NULL AS revoked
           FROM cloud_workspace_endpoint_grants WHERE workspace_id = $1`,
          [workspaceId],
        )
      ).rows[0],
    ).toEqual({ revoked: true });

    const deleted = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}`,
      { method: "DELETE", key: randomUUID() },
    );
    expect(deleted.status).toBe(202);
    await expect(deleted.json()).resolves.toMatchObject({
      workspace: { status: "deleting", desiredState: "deleted" },
      intent: { operation: "delete", state: "queued" },
    });
    const state = await pool.query(
      `SELECT i.operation, i.state, eg.revoked_at IS NOT NULL AS revoked
       FROM cloud_workspace_lifecycle_intents i
       LEFT JOIN cloud_workspace_endpoint_grants eg
         ON eg.workspace_id = i.workspace_id
       WHERE i.workspace_id = $1 ORDER BY i.created_at`,
      [workspaceId],
    );
    expect(state.rows).toEqual([
      { operation: "create", state: "superseded", revoked: true },
      { operation: "stop", state: "superseded", revoked: true },
      { operation: "delete", state: "queued", revoked: true },
    ]);
  });

  it("rechecks membership on every call and RLS hides a foreign tenant", async () => {
    const created = await createWorkspace();
    actor = outsider;
    const invisible = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${created.body.workspace.id}`,
    );
    expect(invisible.status).toBe(404);

    const rows = await withUserTx(pool, outsider.id, (tx) =>
      tx.query(`SELECT id FROM cloud_workspaces WHERE org_id = $1`, [orgId]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("keeps lifecycle, entitlement, setup, and grant mutation system-only while allowing GitHub disconnect", async () => {
    const created = await createWorkspace();
    await pool.query(
      `INSERT INTO cloud_workspace_setup_runs (
         workspace_id, generation, org_id, attempt
       ) VALUES ($1, 1, $2, 1)`,
      [created.body.workspace.id, orgId],
    );
    await pool.query(
      `INSERT INTO cloud_workspace_endpoint_grants (
         workspace_id, generation, org_id, account_user_id, purpose,
         audience, token_hash, expires_at
       ) VALUES ($1, 1, $2, $3, 'engine-connect', 'engine', $4,
                 now() + interval '5 minutes')`,
      [
        created.body.workspace.id,
        orgId,
        owner.id,
        createHash("sha256").update(randomUUID()).digest(),
      ],
    );

    await withUserTx(pool, owner.id, async (tx) => {
      expect(
        (
          await tx.query(
            `UPDATE cloud_workspaces SET display_name = 'tampered'
             WHERE id = $1`,
            [created.body.workspace.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await tx.query(`DELETE FROM cloud_workspace_quotas WHERE org_id = $1`, [
            orgId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await tx.query(
            `DELETE FROM cloud_workspace_setup_runs WHERE workspace_id = $1`,
            [created.body.workspace.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await tx.query(
            `DELETE FROM cloud_workspace_endpoint_grants
             WHERE workspace_id = $1`,
            [created.body.workspace.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await tx.query(
            `SELECT id FROM cloud_workspace_endpoint_grants
             WHERE workspace_id = $1`,
            [created.body.workspace.id],
          )
        ).rowCount,
      ).toBe(0);
    });
    expect(
      (
        await pool.query(`SELECT 1 FROM cloud_workspace_quotas WHERE org_id = $1`, [
          orgId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM cloud_workspace_endpoint_grants WHERE workspace_id = $1`,
          [created.body.workspace.id],
        )
      ).rowCount,
    ).toBe(1);

    await withSystemTx(pool, (tx) =>
      tx.query(`DELETE FROM github_installations WHERE id = $1`, [installationId]),
    );
    const workspace = await pool.query(
      `SELECT id, github_installation_id FROM cloud_workspaces WHERE id = $1`,
      [created.body.workspace.id],
    );
    expect(workspace.rows[0]).toEqual({
      id: created.body.workspace.id,
      github_installation_id: null,
    });
  });

  it("allows stop/archive/delete cleanup after cloud eligibility is revoked but refuses wake", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    await pool.query(
      `UPDATE organizations SET cloud_workspaces_allowed = false WHERE id = $1`,
      [orgId],
    );

    const stopped = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/stop`,
      { method: "POST", key: randomUUID() },
    );
    expect(stopped.status).toBe(202);
    const wake = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/wake`,
      { method: "POST", key: randomUUID() },
    );
    expect(wake.status).toBe(403);
    await expect(wake.json()).resolves.toMatchObject({
      error: { code: "cloud_workspaces_not_allowed" },
    });
    const deleted = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}`,
      { method: "DELETE", key: randomUUID() },
    );
    expect(deleted.status).toBe(202);
  });

  it("paginates exact team-authorized records with an opaque bounded cursor", async () => {
    const first = await createWorkspace();
    await pool.query(
      `UPDATE cloud_workspaces SET desired_state = 'stopped', status = 'stopped'
       WHERE id = $1`,
      [first.body.workspace.id],
    );
    const second = await createWorkspace();
    expect(second.response.status).toBe(202);

    const pageOne = await request(
      `/v1/organizations/${orgId}/cloud-workspaces?limit=1`,
    );
    const firstPage = (await pageOne.json()) as {
      workspaces: Array<{ id: string; teamId: string }>;
      nextCursor: string;
    };
    expect(firstPage.workspaces).toHaveLength(1);
    expect(firstPage.workspaces[0]!.teamId).toBe(teamId);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const pageTwo = await request(
      `/v1/organizations/${orgId}/cloud-workspaces?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    );
    const secondPage = (await pageTwo.json()) as {
      workspaces: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(secondPage.workspaces).toHaveLength(1);
    expect(secondPage.workspaces[0]!.id).not.toBe(firstPage.workspaces[0]!.id);
    expect(secondPage.nextCursor).toBeNull();
  });
});

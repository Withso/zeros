import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";
import pg from "pg";

import { ensureUser, type AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, withUserTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import type { CloudWorkspaceAccessService } from "./access.js";
import type { CloudWorkspaceRepositoryResolver } from "./github-repositories.js";
import { createCloudWorkspaceRoutes } from "./routes.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const TUNNEL_SESSION_ID = "22222222-2222-4222-8222-222222222222";

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
  providerCredentialKeys: {},
  settingsSecretEncryptionKeys: {},
  currentSettingsSecretEncryptionKeyVersion: null,
  settingsSecretKeyV1: null,
  access: {
    allowedSshHosts: ["ssh.app.daytona.io"],
    allowedPreviewHostSuffixes: ["proxy.daytona.work"],
    previewBaseDomain: "cloud-preview.example.test",
  },
  durability: null,
  outbox: null,
  setupExecution: null,
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
  let accessService: CloudWorkspaceAccessService;
  let repositoryResolver: CloudWorkspaceRepositoryResolver;

  const configureApp = (workosEnabled = false) => {
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", actor);
      await next();
    });
    app.route(
      "/",
      createCloudWorkspaceRoutes(pool, cloudConfig, {
        accessService,
        repositoryResolver,
        workosEnabled,
      }),
    );
    app.onError((error, c) => {
      if (error instanceof HttpError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }
      throw error;
    });
  };

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
      accessCredential?: string;
    },
  ) =>
    app.request(path, {
      method: init?.method ?? "GET",
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.key ? { "idempotency-key": init.key } : {}),
        ...(init?.accessCredential
          ? { "x-zeros-access-credential": init.accessCredential }
          : {}),
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
        `INSERT INTO organization_entitlements (
           org_id, plan, status, cloud_workspaces_allowed, seat_limit, source
         ) VALUES ($1, 'business', 'active', true, 1, 'operator')`,
        [organizationId],
      );
      await tx.query(
        `INSERT INTO organization_seat_assignments (org_id, user_id, state)
         VALUES ($1, $2, 'active')`,
        [organizationId, owner.id],
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
         ) VALUES (123456, 'github.com', $1, 'withso', 'User', 'User')
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

    accessService = {
      issue: vi.fn(async (input) => ({
        grant: {
          id: randomUUID(),
          kind: input.kind,
          workspaceId: input.workspaceId,
          generation: 1,
          remotePort: input.remotePort ?? null,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        },
        ...(input.kind === "ssh"
          ? {
              ssh: {
                username: "ssh-token-abcdefghijklmnopqrstuvwxyz",
                host: "ssh.app.daytona.io",
                command:
                  "ssh ssh-token-abcdefghijklmnopqrstuvwxyz@ssh.app.daytona.io",
              },
            }
          : input.kind === "tunnel"
            ? {
                tunnel: {
                  sshUsername: "ssh-token-abcdefghijklmnopqrstuvwxyz",
                  sshHost: "ssh.app.daytona.io",
                  remoteHost: "127.0.0.1" as const,
                  remotePort: input.remotePort!,
                  session: {
                    id: TUNNEL_SESSION_ID,
                    deviceId: input.deviceId!,
                    state: "starting" as const,
                  },
                },
              }
            : {
                preview: {
                  logicalUrl: `http://localhost:${input.remotePort}/`,
                  origin:
                    "https://0123456789abcdef0123456789abcdef.cloud-preview.example.test",
                  capability: `zwp_${"a".repeat(43)}`,
                  headerName: "x-zeros-preview-capability" as const,
                },
              }),
      })),
      activateTunnel: vi.fn(async (input) => ({
        id: input.sessionId,
        deviceId: input.deviceId,
        state: "active" as const,
        bindAddress: "127.0.0.1" as const,
        observedLocalPort: input.observedLocalPort,
      })),
      revoke: vi.fn(async () => undefined),
      recognizesPreviewRequest: vi.fn(() => false),
      handlePreviewRequest: vi.fn(async () => null),
    };
    repositoryResolver = {
      resolve: vi.fn(async (input) => {
        if (
          input.installationId !== 123456 ||
          input.owner.toLowerCase() !== "withso" ||
          input.repository.toLowerCase() !== "zeros"
        ) {
          throw new Error("repository unavailable");
        }
        return {
          forge: "github.com" as const,
          forgeRepositoryId: "123456789",
          owner: "withso",
          name: "zeros",
          cloneUrl: "https://github.com/withso/zeros.git",
          webUrl: "https://github.com/withso/zeros",
          defaultBranch: "main",
          visibility: "private" as const,
        };
      }),
    };
    configureApp();
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
      `SELECT cw.id, cw.owner_user_id, cw.repository_id,
              repository.forge_repository_id,
              g.generation, i.operation, a.action,
              ss.repository_revision, ss.github_installation_id,
              ss.settings_snapshot,
              (SELECT count(*)::integer
               FROM workspace_retention_policies retention
               WHERE retention.workspace_id = cw.id
                 AND retention.org_id = cw.org_id) AS retention_policies,
              ss.settings_snapshot_sha256 =
                digest(ss.settings_snapshot::text, 'sha256') AS valid_hash
       FROM cloud_workspaces cw
       JOIN repositories repository ON repository.id = cw.repository_id
       JOIN cloud_workspace_generations g ON g.workspace_id = cw.id
       JOIN cloud_workspace_setup_specs ss
         ON ss.workspace_id = g.workspace_id AND ss.generation = g.generation
       JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
       JOIN audit_log a ON a.org_id = cw.org_id
       WHERE cw.id = $1 AND a.action = 'cloud_workspace.create_requested'`,
      [created.body.workspace.id],
    );
    expect(records.rows).toEqual([
      expect.objectContaining({
        id: created.body.workspace.id,
        owner_user_id: owner.id,
        repository_id: expect.any(String),
        forge_repository_id: "123456789",
        generation: 1,
        operation: "create",
        action: "cloud_workspace.create_requested",
        repository_revision: "main",
        github_installation_id: installationId,
        settings_snapshot: { schemaVersion: 1, values: {} },
        retention_policies: 1,
        valid_hash: true,
      }),
    ]);
  });

  it("reauthorizes an idempotent create replay instead of lending it to another admin", async () => {
    const key = randomUUID();
    expect((await createWorkspace(key)).response.status).toBe(202);
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [orgId, outsider.id],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [teamId, orgId, outsider.id],
      );
    });
    actor = outsider;

    const replay = await request(
      `/v1/organizations/${orgId}/cloud-workspaces`,
      { method: "POST", key, body: createBody() },
    );
    expect(replay.status).toBe(403);
    await expect(replay.json()).resolves.toMatchObject({
      error: { code: "cloud_workspace_owner_required" },
    });
  });

  it("does not list or return an owner's workspace to another same-team member", async () => {
    const created = await createWorkspace();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [orgId, outsider.id],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [teamId, orgId, outsider.id],
      );
    });
    actor = outsider;

    const listed = await request(
      `/v1/organizations/${orgId}/cloud-workspaces?includeDeleted=true`,
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      workspaces: [],
      nextCursor: null,
    });

    const direct = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${created.body.workspace.id}`,
    );
    expect(direct.status).toBe(404);
    await expect(direct.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("exposes owner-only Phase 5 management APIs without returning secret or provider material", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    const repository = await withSystemTx(pool, (tx) =>
      tx.query<{ repository_id: string }>(
        `SELECT repository_id FROM cloud_workspaces WHERE id = $1`,
        [workspaceId],
      ),
    );
    const repositoryId = repository.rows[0]!.repository_id;
    const saved = await request(
      `/v1/organizations/${orgId}/cloud-workspace-management/repositories/${repositoryId}/settings/cloud`,
      {
        method: "PUT",
        body: {
          expectedVersion: 0,
          document: { values: { RUNTIME_MODE: "cloud" } },
        },
      },
    );
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      version: 1,
      replayed: false,
    });

    const overview = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/management`,
    );
    expect(overview.status).toBe(200);
    const overviewBody = await overview.json();
    expect(overviewBody).toMatchObject({
      workspace: { id: workspaceId, repositoryId },
      settings: { effective: { secretNames: [] } },
      provider: { credentialSource: "hosted" },
    });
    expect(JSON.stringify(overviewBody)).not.toContain("providerResourceId");
    expect(JSON.stringify(overviewBody)).not.toContain(cloudConfig.apiKey);

    actor = outsider;
    const hidden = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/management`,
    );
    expect(hidden.status).toBe(404);
  });

  it("issues SSH, preview, and localhost-tunnel access through the coordinator", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    const sshKey = randomUUID();
    const ssh = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/access/ssh`,
      {
        method: "POST",
        key: sshKey,
        body: { expiresInMinutes: 15 },
      },
    );
    expect(ssh.status).toBe(201);
    expect(ssh.headers.get("cache-control")).toBe("no-store");
    await expect(ssh.json()).resolves.toMatchObject({
      grant: { kind: "ssh", workspaceId },
      ssh: { host: "ssh.app.daytona.io" },
    });
    expect(accessService.issue).toHaveBeenCalledWith({
      organizationId: orgId,
      workspaceId,
      accountUserId: owner.id,
      kind: "ssh",
      expiresInMinutes: 15,
      idempotencyKey: sshKey,
    });

    const tunnel = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/access/tunnels`,
      {
        method: "POST",
        key: randomUUID(),
        body: {
          remotePort: 4_173,
          deviceId: DEVICE_ID,
          requestedLocalPort: 54_173,
          expiresInMinutes: 20,
        },
      },
    );
    expect(tunnel.status).toBe(201);
    const tunnelBody = await tunnel.json();
    expect(tunnelBody).toMatchObject({
      grant: { kind: "tunnel", remotePort: 4_173 },
      tunnel: {
        remoteHost: "127.0.0.1",
        remotePort: 4_173,
        session: { id: TUNNEL_SESSION_ID, deviceId: DEVICE_ID },
      },
    });
    const activated = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/access/tunnels/${TUNNEL_SESSION_ID}`,
      {
        method: "PATCH",
        body: { deviceId: DEVICE_ID, observedLocalPort: 54_173 },
      },
    );
    expect(activated.status).toBe(200);
    await expect(activated.json()).resolves.toMatchObject({
      id: TUNNEL_SESSION_ID,
      deviceId: DEVICE_ID,
      state: "active",
      observedLocalPort: 54_173,
    });

    const preview = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/access/previews`,
      {
        method: "POST",
        key: randomUUID(),
        body: { port: 3_000, expiresInMinutes: 10 },
      },
    );
    expect(preview.status).toBe(201);
    await expect(preview.json()).resolves.toMatchObject({
      grant: { kind: "preview", remotePort: 3_000 },
      preview: {
        logicalUrl: "http://localhost:3000/",
        headerName: "x-zeros-preview-capability",
      },
    });
  });

  it("requires an exact one-time credential when revoking client access", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    const grantId = randomUUID();
    const credential = "ssh-token-abcdefghijklmnopqrstuvwxyz";
    const response = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/access/${grantId}`,
      {
        method: "DELETE",
        accessCredential: credential,
      },
    );
    expect(response.status).toBe(204);
    expect(accessService.revoke).toHaveBeenCalledWith({
      organizationId: orgId,
      workspaceId,
      accountUserId: owner.id,
      grantId,
      credential,
    });

    const missing = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/access/${randomUUID()}`,
      { method: "DELETE" },
    );
    expect(missing.status).toBe(422);
    expect(accessService.revoke).toHaveBeenCalledTimes(1);
  });

  it("rejects revision expressions and option-like refs before persistence", async () => {
    for (const revision of [
      "--upload-pack=/workspace/owned",
      "main~1",
      "refs/heads/main:refs/heads/owned",
      "feature..other",
      ".hidden",
    ]) {
      const response = await request(
        `/v1/organizations/${orgId}/cloud-workspaces`,
        {
          method: "POST",
          key: randomUUID(),
          body: createBody({
            repository: {
              forge: "github.com",
              owner: "withso",
              name: "zeros",
              revision,
              githubInstallationId: installationId,
            },
          }),
        },
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_input",
          message: "Invalid repository revision",
        },
      });
    }

    const persisted = await pool.query(
      `SELECT count(*)::integer AS count
       FROM cloud_workspaces
       WHERE org_id = $1`,
      [orgId],
    );
    expect(persisted.rows).toEqual([{ count: 0 }]);
  });

  it("binds the requested repository owner to the GitHub installation account", async () => {
    const response = await request(
      `/v1/organizations/${orgId}/cloud-workspaces`,
      {
        method: "POST",
        key: randomUUID(),
        body: createBody({
          repository: {
            forge: "github.com",
            owner: "different-owner",
            name: "zeros",
            revision: "main",
            githubInstallationId: installationId,
          },
        }),
      },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "github_installation_not_found" },
    });
    const persisted = await pool.query(
      `SELECT count(*)::integer AS count
       FROM cloud_workspaces
       WHERE org_id = $1`,
      [orgId],
    );
    expect(persisted.rows).toEqual([{ count: 0 }]);
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

  it("fails closed on Personal ownership, missing quota, foreign repository grants, and exhausted quota", async () => {
    const personal = await pool.query<{ id: string }>(
      `SELECT id FROM organizations
       WHERE created_by = $1 AND is_personal AND deleted_at IS NULL`,
      [owner.id],
    );
    const personalResponse = await request(
      `/v1/organizations/${personal.rows[0]!.id}/cloud-workspaces`,
      { method: "POST", key: randomUUID(), body: createBody() },
    );
    expect(personalResponse.status).toBe(403);
    await expect(personalResponse.json()).resolves.toMatchObject({
      error: { code: "cloud_workspaces_not_allowed" },
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

  it("records lifecycle intent and retires active setup and grants before leaving running", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    await withSystemTx(pool, async (tx) => {
      const setupRun = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt, state, started_at,
           claim_count, execution_fence, lease_owner, lease_expires_at,
           last_heartbeat_at
         ) VALUES ($1, 1, $2, 1, 'running', now(), 1, 1,
                   'fixture-worker', now() + interval '5 minutes', now())
         RETURNING id`,
        [workspaceId, orgId],
      );
      for (const purpose of [
        "engine-connect",
        "repository-read",
        "repository-write",
        "setup",
      ]) {
        await tx.query(
          `INSERT INTO cloud_workspace_endpoint_grants (
             workspace_id, generation, org_id, account_user_id, purpose,
             audience, token_hash, account_revision, authorization_revision,
             expires_at, setup_run_id, setup_execution_fence
           ) VALUES ($1, 1, $2, $3, $4, 'https://engine.example.test/', $5, 1, 1,
                     now() + interval '5 minutes',
                     CASE WHEN $4 = 'setup' THEN $6::uuid ELSE NULL END,
                     CASE WHEN $4 = 'setup' THEN 1 ELSE NULL END)`,
          [
            workspaceId,
            orgId,
            owner.id,
            purpose,
            createHash("sha256").update(randomUUID()).digest(),
            setupRun.rows[0]!.id,
          ],
        );
      }
    });

    const stopped = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/stop`,
      { method: "POST", key: randomUUID() },
    );
    expect(stopped.status).toBe(202);
    await expect(stopped.json()).resolves.toMatchObject({
      workspace: { status: "stopping", desiredState: "stopped" },
      intent: { operation: "stop", state: "queued" },
    });
    const retired = await pool.query(
      `SELECT
         (SELECT bool_and(revoked_at IS NOT NULL)
          FROM cloud_workspace_endpoint_grants
          WHERE workspace_id = $1) AS all_grants_revoked,
         (SELECT state FROM cloud_workspace_setup_runs
          WHERE workspace_id = $1 AND attempt = 1) AS setup_state,
         (SELECT completed_at IS NOT NULL FROM cloud_workspace_setup_runs
          WHERE workspace_id = $1 AND attempt = 1) AS setup_completed`,
      [workspaceId],
    );
    expect(retired.rows[0]).toEqual({
      all_grants_revoked: true,
      setup_state: "cancelled",
      setup_completed: true,
    });

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
      `SELECT i.operation, i.state,
              (SELECT state FROM workspace_deletion_jobs deletion
               WHERE deletion.workspace_id = i.workspace_id) AS deletion_state,
              (SELECT bool_and(eg.revoked_at IS NOT NULL)
               FROM cloud_workspace_endpoint_grants eg
               WHERE eg.workspace_id = i.workspace_id) AS revoked
       FROM cloud_workspace_lifecycle_intents i
       WHERE i.workspace_id = $1 ORDER BY i.created_at`,
      [workspaceId],
    );
    expect(state.rows).toEqual([
      {
        operation: "create",
        state: "superseded",
        deletion_state: "waiting_for_provider",
        revoked: true,
      },
      {
        operation: "stop",
        state: "superseded",
        deletion_state: "waiting_for_provider",
        revoked: true,
      },
      {
        operation: "delete",
        state: "queued",
        deletion_state: "waiting_for_provider",
        revoked: true,
      },
    ]);
  });

  it("does not let another Organization admin stop, archive, or delete an owner-only workspace", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [orgId, outsider.id],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [teamId, orgId, outsider.id],
      );
    });
    actor = outsider;

    for (const action of [
      { method: "POST", suffix: "/stop" },
      { method: "POST", suffix: "/archive" },
      { method: "DELETE", suffix: "" },
    ]) {
      const response = await request(
        `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}${action.suffix}`,
        { method: action.method, key: randomUUID() },
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "cloud_workspace_owner_required" },
      });
    }
  });

  it("lets a downgraded workspace owner stop and delete existing paid compute without granting creation", async () => {
    const stoppedWorkspace = await createWorkspace();
    const deletedWorkspace = await createWorkspace();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `UPDATE organization_members SET role = 'member'
         WHERE org_id = $1 AND user_id = $2`,
        [orgId, owner.id],
      );
      await tx.query(
        `UPDATE team_members SET role = 'member'
         WHERE team_id = $1 AND org_id = $2 AND user_id = $3`,
        [teamId, orgId, owner.id],
      );
    });

    const create = await createWorkspace();
    expect(create.response.status).toBe(403);
    expect(create.body).toMatchObject({
      error: { code: "forbidden" },
    });

    const stopped = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${stoppedWorkspace.body.workspace.id}/stop`,
      { method: "POST", key: randomUUID() },
    );
    expect(stopped.status).toBe(202);

    const deleted = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${deletedWorkspace.body.workspace.id}`,
      { method: "DELETE", key: randomUUID() },
    );
    expect(deleted.status).toBe(202);
  });

  it("rebinds a renewed entitlement before waking a stopped generation", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET state = 'succeeded', completed_at = now()
         WHERE workspace_id = $1 AND operation = 'create'`,
        [workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET desired_state = 'stopped', status = 'stopped',
             authority_epoch = authority_epoch + 1
         WHERE id = $1`,
        [workspaceId],
      );
      await tx.query(
        `UPDATE organization_entitlements
         SET revision = revision + 1, updated_at = now()
         WHERE org_id = $1`,
        [orgId],
      );
    });

    const response = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/wake`,
      { method: "POST", key: randomUUID() },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      workspace: { status: "waking", desiredState: "running" },
      intent: { operation: "wake", state: "queued" },
    });
    const authority = (
      await pool.query<{
        current_billing_epoch: string;
        paid: boolean;
        live_epoch_count: number;
      }>(
        `SELECT workspace.current_billing_epoch::text,
                cloud_workspace_paid_authority_live(
                  workspace.id, workspace.owner_user_id, false
                ) AS paid,
                (SELECT count(*)::integer
                 FROM workspace_billing_epochs billing
                 WHERE billing.workspace_id = workspace.id
                   AND billing.ended_at IS NULL) AS live_epoch_count
         FROM cloud_workspaces workspace WHERE workspace.id = $1`,
        [workspaceId],
      )
    ).rows[0];
    expect(authority).toEqual({
      current_billing_epoch: "2",
      paid: true,
      live_epoch_count: 1,
    });
  });

  it("starts an idempotent generation replacement without mutating its source generation", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `UPDATE cloud_workspaces
         SET status = 'ready', updated_at = now()
         WHERE id = $1`,
        [workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET provider_resource_id = $2, observed_state = 'running',
             last_observed_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId, `sandbox-${workspaceId}-1`],
      );
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET state = 'succeeded', completed_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND operation = 'create'`,
        [workspaceId],
      );
    });

    const key = randomUUID();
    const first = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/generations`,
      {
        method: "POST",
        key,
        body: { operation: "upgrade" },
      },
    );
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      workspace: { generation: { number: number }; status: string };
      transition: {
        operation: string;
        sourceGeneration: number;
        candidateGeneration: number;
        state: string;
      };
      intent: { operation: string; state: string };
    };
    expect(firstBody).toMatchObject({
      workspace: { generation: { number: 1 }, status: "ready" },
      transition: {
        operation: "upgrade",
        sourceGeneration: 1,
        candidateGeneration: 2,
        state: "draining",
      },
      intent: { operation: "stop", state: "queued" },
    });

    const replay = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/generations`,
      {
        method: "POST",
        key,
        body: { operation: "upgrade" },
      },
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    await expect(replay.json()).resolves.toMatchObject(firstBody);

    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [orgId, outsider.id],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [teamId, orgId, outsider.id],
      );
    });
    actor = outsider;
    const foreignReplay = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/generations`,
      {
        method: "POST",
        key,
        body: { operation: "upgrade" },
      },
    );
    expect(foreignReplay.status).toBe(403);
    await expect(foreignReplay.json()).resolves.toMatchObject({
      error: { code: "cloud_workspace_owner_required" },
    });
    actor = owner;

    const stored = await pool.query(
      `SELECT cw.current_generation, source.retired_at AS source_retired_at,
              candidate.image_ref AS candidate_image_ref,
              source_spec.settings_snapshot = candidate_spec.settings_snapshot
                AS settings_copied,
              i.generation AS intent_generation,
              i.affects_workspace,
              gt.state AS transition_state,
              checkpoint_request.reason AS checkpoint_reason,
              checkpoint_request.state AS checkpoint_state
       FROM cloud_workspaces cw
       JOIN cloud_workspace_generations source
         ON source.workspace_id = cw.id AND source.generation = 1
       JOIN cloud_workspace_generations candidate
         ON candidate.workspace_id = cw.id AND candidate.generation = 2
       JOIN cloud_workspace_setup_specs source_spec
         ON source_spec.workspace_id = source.workspace_id
        AND source_spec.generation = source.generation
       JOIN cloud_workspace_setup_specs candidate_spec
         ON candidate_spec.workspace_id = candidate.workspace_id
        AND candidate_spec.generation = candidate.generation
       JOIN cloud_workspace_generation_transitions gt
         ON gt.workspace_id = cw.id AND gt.candidate_generation = 2
       JOIN cloud_workspace_lifecycle_intents i
         ON i.id = gt.drain_intent_id
       JOIN workspace_checkpoint_requests checkpoint_request
         ON checkpoint_request.lifecycle_intent_id = i.id
       WHERE cw.id = $1`,
      [workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      current_generation: 1,
      source_retired_at: null,
      candidate_image_ref: "snap-pinned",
      settings_copied: true,
      intent_generation: 1,
      affects_workspace: false,
      transition_state: "draining",
      checkpoint_reason: "before_rebuild",
      checkpoint_state: "queued",
    });
  });

  it("reserves replacement headroom against later replacements and creates", async () => {
    const first = await createWorkspace();
    const second = await createWorkspace();
    const workspaceIds = [first.body.workspace.id, second.body.workspace.id];
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `UPDATE cloud_workspaces
         SET status = 'ready', updated_at = now()
         WHERE id = ANY($1::uuid[])`,
        [workspaceIds],
      );
      await tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET provider_resource_id = 'sandbox-' || workspace_id::text || '-1',
             observed_state = 'running', last_observed_at = now(),
             updated_at = now()
         WHERE workspace_id = ANY($1::uuid[]) AND generation = 1`,
        [workspaceIds],
      );
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET state = 'succeeded', completed_at = now(), updated_at = now()
         WHERE workspace_id = ANY($1::uuid[]) AND operation = 'create'`,
        [workspaceIds],
      );
      // Two live generations plus exactly one replacement generation fit.
      await tx.query(
        `UPDATE cloud_workspace_quotas
         SET max_cpu_millicores = 6000, max_memory_mib = 12288,
             max_storage_mib = 61440
         WHERE org_id = $1`,
        [orgId],
      );
    });

    const replacement = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceIds[0]}/generations`,
      {
        method: "POST",
        key: randomUUID(),
        body: { operation: "upgrade" },
      },
    );
    expect(replacement.status).toBe(202);

    // The first transaction durably reserved its immutable candidate inputs.
    // A different workspace cannot reuse that same Organization headroom.
    const secondReplacement = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceIds[1]}/generations`,
      {
        method: "POST",
        key: randomUUID(),
        body: { operation: "upgrade" },
      },
    );
    const create = await request(
      `/v1/organizations/${orgId}/cloud-workspaces`,
      { method: "POST", key: randomUUID(), body: createBody() },
    );

    expect(secondReplacement.status).toBe(409);
    await expect(secondReplacement.json()).resolves.toMatchObject({
      error: { code: "cloud_replacement_headroom_exceeded" },
    });
    expect(create.status).toBe(409);
    await expect(create.json()).resolves.toMatchObject({
      error: { code: "cloud_quota_exceeded" },
    });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM cloud_workspace_generations
         WHERE workspace_id = ANY($1::uuid[]) AND generation = 2`,
        [workspaceIds],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("retains retired provider storage in create admission until deletion is verified", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET provider_resource_id = $2, observed_state = 'stopped',
             last_observed_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId, `sandbox-${workspaceId}-1`],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) SELECT workspace_id, 2, org_id, provider, image_ref,
                  architecture, cpu_millicores, memory_mib, storage_mib,
                  source_commit, created_by, provider_connection_id
           FROM cloud_workspace_generations
           WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider,
           provider_resource_id, observed_state, last_observed_at
         ) VALUES ($1, 2, $2, 'daytona', $3, 'running', now())`,
        [workspaceId, orgId, `sandbox-${workspaceId}-2`],
      );
      await tx.query(
        `UPDATE cloud_workspace_generations SET retired_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET current_generation = 2, status = 'ready', updated_at = now()
         WHERE id = $1`,
        [workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET state = 'succeeded', completed_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND operation = 'create'`,
        [workspaceId],
      );
      // Current + one new workspace fit exactly, but the retired provider disk
      // still makes that allocation unsafe until deletion is observed.
      await tx.query(
        `UPDATE cloud_workspace_quotas
         SET max_cpu_millicores = 4000, max_memory_mib = 8192,
             max_storage_mib = 40960
         WHERE org_id = $1`,
        [orgId],
      );
    });

    const beforeDeletion = await request(
      `/v1/organizations/${orgId}/cloud-workspaces`,
      { method: "POST", key: randomUUID(), body: createBody() },
    );
    expect(beforeDeletion.status).toBe(409);
    await expect(beforeDeletion.json()).resolves.toMatchObject({
      error: { code: "cloud_quota_exceeded" },
    });

    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET observed_state = 'deleted', deletion_verified_at = now(),
             last_observed_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId],
      ),
    );
    const afterDeletion = await request(
      `/v1/organizations/${orgId}/cloud-workspaces`,
      { method: "POST", key: randomUUID(), body: createBody() },
    );
    expect(afterDeletion.status).toBe(202);
  });

  it("cancels a generation replacement before stopping the restored source", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `UPDATE cloud_workspaces SET status = 'ready', updated_at = now()
         WHERE id = $1`,
        [workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET provider_resource_id = $2, observed_state = 'running',
             last_observed_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId, `sandbox-${workspaceId}-1`],
      );
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET state = 'succeeded', completed_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND operation = 'create'`,
        [workspaceId],
      );
    });
    const replacing = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/generations`,
      {
        method: "POST",
        key: randomUUID(),
        body: { operation: "upgrade" },
      },
    );
    expect(replacing.status).toBe(202);

    const stopped = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/stop`,
      { method: "POST", key: randomUUID() },
    );
    expect(stopped.status).toBe(202);
    await expect(stopped.json()).resolves.toMatchObject({
      workspace: {
        generation: { number: 1 },
        // The source remains authoritative until its final checkpoint is
        // durable; the queued intent records the accepted stop request.
        status: "ready",
        desiredState: "running",
      },
      intent: { operation: "stop", state: "queued" },
    });
    const stored = await pool.query(
      `SELECT cw.current_generation, gt.state AS transition_state,
              gt.completed_at IS NOT NULL AS transition_completed,
              candidate.retired_at IS NOT NULL AS candidate_retired,
              array_agg(
                jsonb_build_object(
                  'operation', i.operation,
                  'generation', i.generation,
                  'affectsWorkspace', i.affects_workspace,
                  'state', i.state
                ) ORDER BY i.generation, i.affects_workspace DESC, i.operation
              ) FILTER (WHERE i.generation_transition_id = gt.id
                         OR i.operation = 'stop') AS transition_intents
       FROM cloud_workspaces cw
       JOIN cloud_workspace_generation_transitions gt
         ON gt.workspace_id = cw.id
       JOIN cloud_workspace_generations candidate
         ON candidate.workspace_id = cw.id AND candidate.generation = 2
       LEFT JOIN cloud_workspace_lifecycle_intents i
         ON i.workspace_id = cw.id
       WHERE cw.id = $1
       GROUP BY cw.current_generation, gt.state, gt.completed_at,
                candidate.retired_at`,
      [workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      current_generation: 1,
      transition_state: "cancelled",
      transition_completed: true,
      candidate_retired: true,
      transition_intents: [
        {
          operation: "stop",
          generation: 1,
          affectsWorkspace: true,
          state: "queued",
        },
        {
          operation: "stop",
          generation: 1,
          affectsWorkspace: false,
          state: "superseded",
        },
        {
          operation: "delete",
          generation: 2,
          affectsWorkspace: false,
          state: "queued",
        },
      ],
    });
  });

  it("rolls back by creating a fresh generation from qualified historical inputs", async () => {
    const created = await createWorkspace();
    const workspaceId = created.body.workspace.id;
    await withSystemTx(pool, async (tx) => {
      const sourceRun = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt, state, claim_count,
           execution_fence, lease_owner, lease_expires_at,
           last_heartbeat_at, started_at
         ) VALUES ($1, 1, $2, 1, 'running', 1, 1, 'qualified-source',
                   now() + interval '5 minutes', now(), now())
         RETURNING id`,
        [workspaceId, orgId],
      );
      const sourceGrant = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_endpoint_grants (
           workspace_id, generation, org_id, account_user_id, purpose,
           audience, token_hash, account_revision, authorization_revision,
           expires_at, consumed_at, setup_run_id,
           setup_execution_fence
         ) VALUES ($1, 1, $2, $3, 'setup', 'qualified-source', $4,
                   1, 1, now() + interval '5 minutes', now(), $5, 1)
         RETURNING id`,
        [
          workspaceId,
          orgId,
          owner.id,
          createHash("sha256").update(randomUUID()).digest(),
          sourceRun.rows[0]!.id,
        ],
      );
      const engineId = randomUUID();
      await tx.query(
        `INSERT INTO cloud_workspace_engine_instances (
           id, workspace_id, generation, org_id, account_user_id,
           setup_run_id, setup_execution_fence, registration_grant_id,
           protocol_version, state, bridge_token_hash,
           heartbeat_token_hash, registered_at, last_heartbeat_at,
           lease_expires_at
         ) VALUES ($1, $2, 1, $3, $4, $5, 1, $6, 11, 'ready', $7, $8,
                   now(), now(), now() + interval '2 minutes')`,
        [
          engineId,
          workspaceId,
          orgId,
          owner.id,
          sourceRun.rows[0]!.id,
          sourceGrant.rows[0]!.id,
          createHash("sha256").update(randomUUID()).digest(),
          createHash("sha256").update(randomUUID()).digest(),
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_attestations (
           setup_run_id, workspace_id, generation, org_id, execution_fence,
           image_ref, image_source_commit, repository_revision,
           repository_commit, settings_version, settings_snapshot_sha256,
           engine_instance_id, engine_protocol_version, engine_health,
           durable_record_connected
         ) SELECT $1, $2, 1, $3, 1, g.image_ref, g.source_commit,
                  ss.repository_revision, $4, ss.spec_version,
                  ss.settings_snapshot_sha256, $5, 11, 'ready', true
           FROM cloud_workspace_generations g
           JOIN cloud_workspace_setup_specs ss
             ON ss.workspace_id = g.workspace_id
            AND ss.generation = g.generation
           WHERE g.workspace_id = $2 AND g.generation = 1`,
        [sourceRun.rows[0]!.id, workspaceId, orgId, "c".repeat(40), engineId],
      );
      await tx.query(
        `UPDATE cloud_workspace_setup_runs
         SET state = 'succeeded', completed_at = now(), lease_owner = NULL,
             lease_expires_at = NULL, updated_at = now()
         WHERE id = $1`,
        [sourceRun.rows[0]!.id],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) SELECT $1, 2, $2, 'daytona', 'snap-newer', 'linux/amd64',
                  2000, 4096, 20480, $3, $4, provider_connection_id
           FROM cloud_workspace_generations
           WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId, orgId, "b".repeat(40), owner.id],
      );
      const generationSettings = await tx.query<{ id: string }>(
        `INSERT INTO workspace_settings_versions (
           workspace_id, generation, org_id, schema_version,
           effective_document, provenance, source_versions,
           environment_profile_id, environment_profile_version,
           managed_policy_version, created_by
         ) SELECT workspace_id, 2, org_id, schema_version,
                  effective_document, provenance,
                  source_versions || '{"testCopy":true}'::jsonb,
                  environment_profile_id, environment_profile_version,
                  managed_policy_version, $2
           FROM workspace_settings_versions
           WHERE workspace_id = $1 AND generation = 1
         RETURNING id`,
        [workspaceId, owner.id],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, repository_forge,
           repository_owner, repository_name, repository_revision,
           github_installation_id, settings_snapshot,
           settings_snapshot_sha256, workspace_settings_version_id
         ) SELECT workspace_id, 2, org_id, repository_forge,
                  repository_owner, repository_name, repository_revision,
                  github_installation_id, settings_snapshot,
                  settings_snapshot_sha256, $2
           FROM cloud_workspace_setup_specs
           WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId, generationSettings.rows[0]!.id],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider,
           provider_resource_id, observed_state, last_observed_at
         ) VALUES ($1, 2, $2, 'daytona', $3, 'running', now())`,
        [workspaceId, orgId, `sandbox-${workspaceId}-2`],
      );
      await tx.query(
        `UPDATE cloud_workspace_generations SET retired_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET state = 'succeeded', completed_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND operation = 'create'`,
        [workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET current_generation = 2, status = 'ready', version = version + 1,
             updated_at = now()
         WHERE id = $1`,
        [workspaceId],
      );
    });

    const response = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/generations`,
      {
        method: "POST",
        key: randomUUID(),
        body: { operation: "rollback", sourceGeneration: 1 },
      },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      workspace: {
        generation: {
          // Rollback is a fresh candidate, but the current source remains
          // authoritative throughout the checkpoint + drain barrier.
          number: 2,
          imageRef: "snap-newer",
          sourceCommit: "b".repeat(40),
        },
        status: "ready",
      },
      transition: {
        operation: "rollback",
        sourceGeneration: 2,
        templateGeneration: 1,
        candidateGeneration: 3,
        state: "draining",
      },
    });
  });

  it.each([
    {
      operation: "stop",
      method: "POST",
      suffix: "/stop",
      status: "stopped",
      desiredState: "stopped",
      reason: "workspace_stop_requested",
    },
    {
      operation: "archive",
      method: "POST",
      suffix: "/archive",
      status: "archived",
      desiredState: "archived",
      reason: "workspace_archive_requested",
    },
    {
      operation: "delete",
      method: "DELETE",
      suffix: "",
      status: "deleted",
      desiredState: "deleted",
      reason: "workspace_delete_requested",
    },
  ])(
    "re-enforces runtime retirement when $operation is already satisfied",
    async ({ method, suffix, status, desiredState, reason }) => {
      const created = await createWorkspace();
      const workspaceId = created.body.workspace.id;
      await withSystemTx(pool, async (tx) => {
        await tx.query(
          `UPDATE cloud_workspaces
           SET status = $2::cloud_workspace_status,
               desired_state = $3::cloud_workspace_desired_state,
               deleted_at = CASE WHEN $2 = 'deleted' THEN now() ELSE NULL END
           WHERE id = $1`,
          [workspaceId, status, desiredState],
        );
        const setupRun = await tx.query<{ id: string }>(
          `INSERT INTO cloud_workspace_setup_runs (
             workspace_id, generation, org_id, attempt, state, started_at,
             claim_count, execution_fence, lease_owner, lease_expires_at,
             last_heartbeat_at
           ) VALUES ($1, 1, $2, 1, 'running', now(), 1, 1,
                     'fixture-worker', now() + interval '5 minutes', now())
           RETURNING id`,
          [workspaceId, orgId],
        );
        await tx.query(
          `INSERT INTO cloud_workspace_endpoint_grants (
             workspace_id, generation, org_id, account_user_id, purpose,
             audience, token_hash, account_revision, authorization_revision,
             expires_at, setup_run_id,
             setup_execution_fence
           ) VALUES ($1, 1, $2, $3, 'setup', 'https://engine.example.test/', $4,
                     1, 1, now() + interval '5 minutes', $5, 1)`,
          [
            workspaceId,
            orgId,
            owner.id,
            createHash("sha256").update(randomUUID()).digest(),
            setupRun.rows[0]!.id,
          ],
        );
      });

      const response = await request(
        `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}${suffix}`,
        { method, key: randomUUID() },
      );
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        workspace: { status, desiredState },
        intent: { state: "succeeded" },
      });
      const retired = await pool.query(
        `SELECT sr.state AS setup_state, sr.error_code,
                sr.completed_at IS NOT NULL AS setup_completed,
                eg.revoked_at IS NOT NULL AS grant_revoked
         FROM cloud_workspace_setup_runs sr
         JOIN cloud_workspace_endpoint_grants eg
           ON eg.workspace_id = sr.workspace_id AND eg.generation = sr.generation
         WHERE sr.workspace_id = $1`,
        [workspaceId],
      );
      expect(retired.rows[0]).toEqual({
        setup_state: "cancelled",
        error_code: reason,
        setup_completed: true,
        grant_revoked: true,
      });
    },
  );

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
         audience, token_hash, account_revision, authorization_revision,
         expires_at
       ) VALUES ($1, 1, $2, $3, 'engine-connect', 'engine', $4, 1, 1,
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
          await tx.query(
            `DELETE FROM cloud_workspace_quotas WHERE org_id = $1`,
            [orgId],
          )
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
            `UPDATE cloud_workspace_setup_specs
             SET repository_revision = 'tampered'
             WHERE workspace_id = $1`,
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
        await pool.query(
          `SELECT 1 FROM cloud_workspace_quotas WHERE org_id = $1`,
          [orgId],
        )
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
      tx.query(`DELETE FROM github_installations WHERE id = $1`, [
        installationId,
      ]),
    );
    const workspace = await pool.query(
      `SELECT cw.id, cw.github_installation_id,
              ss.github_installation_id AS setup_installation_id
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_specs ss ON ss.workspace_id = cw.id
       WHERE cw.id = $1`,
      [created.body.workspace.id],
    );
    expect(workspace.rows[0]).toEqual({
      id: created.body.workspace.id,
      github_installation_id: null,
      setup_installation_id: installationId,
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

  it("requires an active WorkOS organization link for create/wake while preserving cleanup", async () => {
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, external_id, state
       ) VALUES ($1::uuid, $1::uuid::text, 'provisioning')`,
      [orgId],
    );
    configureApp(true);

    const pendingCreate = await createWorkspace();
    expect(pendingCreate.response.status).toBe(409);
    expect(pendingCreate.body).toMatchObject({
      error: { code: "organization_identity_not_ready" },
    });

    await pool.query(
      `UPDATE workos_organization_links
       SET state = 'active', workos_organization_id = 'org_workos_example'
       WHERE organization_id = $1`,
      [orgId],
    );
    const created = await createWorkspace();
    expect(created.response.status).toBe(202);
    const workspaceId = created.body.workspace.id;

    const stopped = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/stop`,
      { method: "POST", key: randomUUID() },
    );
    expect(stopped.status).toBe(202);
    await pool.query(
      `UPDATE workos_organization_links SET state = 'conflict'
       WHERE organization_id = $1`,
      [orgId],
    );

    const wake = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/wake`,
      { method: "POST", key: randomUUID() },
    );
    expect(wake.status).toBe(409);
    await expect(wake.json()).resolves.toMatchObject({
      error: { code: "organization_identity_not_ready" },
    });

    const replacement = await request(
      `/v1/organizations/${orgId}/cloud-workspaces/${workspaceId}/generations`,
      {
        method: "POST",
        key: randomUUID(),
        body: { operation: "upgrade" },
      },
    );
    expect(replacement.status).toBe(409);
    await expect(replacement.json()).resolves.toMatchObject({
      error: { code: "organization_identity_not_ready" },
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

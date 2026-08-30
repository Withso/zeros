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
import pg from "pg";

import { ensureUser, type AuthedUser } from "../auth.js";
import { withSystemTx, withUserTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import type {
  CloudProviderPreviewEndpoint,
  CloudProviderSshAccess,
  CloudWorkspaceAccessProvider,
} from "./provider.js";
import {
  CloudWorkspaceAccessRevocationWorker,
  DatabaseCloudWorkspaceAccessService,
} from "./access.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

function fakeAccessProvider() {
  const sshCredential = "ssh-token-abcdefghijklmnopqrstuvwxyz";
  let sshIssueCount = 0;
  const provider: CloudWorkspaceAccessProvider = {
    createSshAccess: vi.fn(
      async (
        _resourceId: string,
        expiresInMinutes: number,
      ): Promise<CloudProviderSshAccess> => {
        const credential =
          sshIssueCount++ === 0
            ? sshCredential
            : `ssh-token-${randomUUID().replaceAll("-", "")}`;
        return {
          providerAccessId: randomUUID(),
          credential,
          host: "ssh.app.daytona.io",
          command: `ssh ${credential}@ssh.app.daytona.io`,
          expiresAt: new Date(Date.now() + expiresInMinutes * 60_000),
        };
      },
    ),
    revokeSshAccess: vi.fn(async () => undefined),
    getPreviewEndpoint: vi.fn(
      async (
        resourceId: string,
        port: number,
      ): Promise<CloudProviderPreviewEndpoint> => ({
        url: `https://${port}-${resourceId}.proxy.daytona.work/`,
        headerName: "x-daytona-preview-token",
        headerValue: "preview-token-abcdefghijklmnopqrstuvwxyz",
      }),
    ),
  };
  return { provider, sshCredential };
}

describe("cloud preview endpoint cache", () => {
  it("coalesces concurrent exact-key provider lookups", async () => {
    const { provider } = fakeAccessProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(provider.getPreviewEndpoint).mockImplementation(
      async (resourceId, port) => {
        await gate;
        return {
          url: `https://${port}-${resourceId}.proxy.daytona.work/`,
          headerName: "x-daytona-preview-token",
          headerValue: "preview-token-abcdefghijklmnopqrstuvwxyz",
        };
      },
    );
    const service = new DatabaseCloudWorkspaceAccessService({
      pool: {} as pg.Pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });
    const cache = service as unknown as {
      cachedPreviewEndpoint(
        resourceId: string,
        port: number,
        bindingVersion: string,
      ): Promise<CloudProviderPreviewEndpoint>;
    };

    const first = cache.cachedPreviewEndpoint("sandbox-1", 3_000, "v1");
    const second = cache.cachedPreviewEndpoint("sandbox-1", 3_000, "v1");
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(provider.getPreviewEndpoint).toHaveBeenCalledOnce();
  });
});

d("cloud workspace client access", () => {
  let pool: pg.Pool;
  let actor: AuthedUser;
  let orgId: string;
  let teamId: string;
  let workspaceId: string;
  let providerResourceId: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    actor = await ensureUser(pool, {
      provider: "auth0",
      providerSubject: randomUUID(),
      email: `access-${randomUUID()}@example.test`,
      displayName: "Access Actor",
    });
    const seeded = await withSystemTx(pool, async (tx) => {
      const organization = await tx.query<{ id: string }>(
        `INSERT INTO organizations (
           slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, 'Access Org', $2, false, true) RETURNING id`,
        [`access-${randomUUID()}`, actor.id],
      );
      const organizationId = organization.rows[0]!.id;
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [organizationId, actor.id],
      );
      const team = await tx.query<{ id: string }>(
        `INSERT INTO teams (
           org_id, slug, name, is_default, created_by
         ) VALUES ($1, 'default', 'Default', true, $2) RETURNING id`,
        [organizationId, actor.id],
      );
      const childTeamId = team.rows[0]!.id;
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'member')`,
        [childTeamId, organizationId, actor.id],
      );
      const workspace = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspaces (
           org_id, team_id, created_by, display_name, repository_forge,
           repository_owner, repository_name, repository_revision,
           status, desired_state
         ) VALUES ($1, $2, $3, 'Access', 'github.com', 'withso', 'zeros',
                   'main', 'ready', 'running') RETURNING id`,
        [organizationId, childTeamId, actor.id],
      );
      const childWorkspaceId = workspace.rows[0]!.id;
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib, created_by
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3)`,
        [childWorkspaceId, organizationId, actor.id],
      );
      const resourceId = `sandbox-${childWorkspaceId}`;
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider, provider_resource_id,
           observed_state, last_observed_at
         ) VALUES ($1, 1, $2, 'daytona', $3, 'running', now())`,
        [childWorkspaceId, organizationId, resourceId],
      );
      return {
        organizationId,
        childTeamId,
        childWorkspaceId,
        resourceId,
      };
    });
    orgId = seeded.organizationId;
    teamId = seeded.childTeamId;
    workspaceId = seeded.childWorkspaceId;
    providerResourceId = seeded.resourceId;
  });

  it("returns an SSH bearer once and persists only its verifier", async () => {
    const { provider, sshCredential } = fakeAccessProvider();
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });
    const key = randomUUID();
    const issued = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "ssh",
      expiresInMinutes: 15,
      idempotencyKey: key,
    });

    expect(issued).toMatchObject({
      grant: { kind: "ssh", generation: 1 },
      ssh: {
        username: sshCredential,
        host: "ssh.app.daytona.io",
        command: `ssh ${sshCredential}@ssh.app.daytona.io`,
      },
    });
    const stored = await withSystemTx(pool, (tx) =>
      tx.query<{
        state: string;
        token_matches: boolean;
        provider_access_id: string | null;
      }>(
        `SELECT state, token_hash = $2 AS token_matches, provider_access_id
         FROM cloud_workspace_client_access_grants WHERE id = $1`,
        [issued.grant.id, createHash("sha256").update(sshCredential).digest()],
      ),
    );
    expect(stored.rows[0]).toMatchObject({
      state: "active",
      token_matches: true,
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain(sshCredential);

    await expect(
      service.issue({
        organizationId: orgId,
        workspaceId,
        accountUserId: actor.id,
        kind: "ssh",
        expiresInMinutes: 15,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: "cloud_access_response_not_replayable" });
  });

  it("serializes one account idempotency key across different workspaces", async () => {
    const second = await withSystemTx(pool, async (tx) => {
      const workspace = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspaces (
           org_id, team_id, created_by, display_name, repository_forge,
           repository_owner, repository_name, repository_revision,
           status, desired_state
         ) VALUES ($1, $2, $3, 'Second access', 'github.com', 'withso',
                   'zeros-two', 'main', 'ready', 'running') RETURNING id`,
        [orgId, teamId, actor.id],
      );
      const id = workspace.rows[0]!.id;
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib, created_by
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3)`,
        [id, orgId, actor.id],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider, provider_resource_id,
           observed_state, last_observed_at
         ) VALUES ($1, 1, $2, 'daytona', $3, 'running', now())`,
        [id, orgId, `sandbox-${id}`],
      );
      return id;
    });
    const { provider } = fakeAccessProvider();
    let releaseIdempotencyReads!: () => void;
    const bothIdempotencyReads = new Promise<void>((resolve) => {
      releaseIdempotencyReads = resolve;
    });
    let idempotencyReads = 0;
    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query") {
              return async (...args: unknown[]) => {
                const result = await (
                  target.query as (...queryArgs: unknown[]) => Promise<unknown>
                ).apply(target, args);
                const sql = typeof args[0] === "string" ? args[0] : "";
                if (
                  sql.includes("SELECT workspace_id, request_sha256") &&
                  !sql.includes("idempotency-conflict")
                ) {
                  idempotencyReads += 1;
                  if (idempotencyReads === 2) releaseIdempotencyReads();
                  await bothIdempotencyReads;
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as pg.Pool;
    const service = new DatabaseCloudWorkspaceAccessService({
      pool: racingPool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });
    const idempotencyKey = randomUUID();
    const request = (targetWorkspaceId: string) =>
      service.issue({
        organizationId: orgId,
        workspaceId: targetWorkspaceId,
        accountUserId: actor.id,
        kind: "ssh" as const,
        expiresInMinutes: 15,
        idempotencyKey,
      });

    const results = await Promise.allSettled([
      request(workspaceId),
      request(second),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "idempotency_key_reused", status: 409 },
    });
    expect(provider.createSshAccess).toHaveBeenCalledOnce();
  });

  it("returns a structured localhost-only tunnel and rejects reserved ports", async () => {
    const { provider, sshCredential } = fakeAccessProvider();
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });
    const issued = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "tunnel",
      remotePort: 4_173,
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });
    expect(issued).toMatchObject({
      grant: { kind: "tunnel", remotePort: 4_173 },
      tunnel: {
        sshUsername: sshCredential,
        sshHost: "ssh.app.daytona.io",
        remoteHost: "127.0.0.1",
        remotePort: 4_173,
      },
    });
    expect(JSON.stringify(issued)).not.toContain("0.0.0.0");

    await expect(
      service.issue({
        organizationId: orgId,
        workspaceId,
        accountUserId: actor.id,
        kind: "tunnel",
        remotePort: 22_222,
        expiresInMinutes: 15,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "cloud_access_port_forbidden" });
  });

  it("proxies preview HTTP with a Zeros verifier and keeps Daytona's token server-side", async () => {
    const { provider } = fakeAccessProvider();
    const upstream = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("x-daytona-preview-token")).toBe(
          "preview-token-abcdefghijklmnopqrstuvwxyz",
        );
        return new Response("preview-ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    );
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
      fetcher: upstream,
    });
    const issued = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "preview",
      remotePort: 3_000,
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });
    expect(issued).toMatchObject({
      grant: { kind: "preview", remotePort: 3_000 },
      preview: {
        logicalUrl: "http://localhost:3000/",
        headerName: "x-zeros-preview-capability",
      },
    });
    expect(issued.preview?.origin).toMatch(
      /^https:\/\/[a-f0-9]{32}\.cloud-preview\.example\.test$/,
    );
    expect(
      service.recognizesPreviewRequest(
        new Request(`${issued.preview!.origin}/app`),
      ),
    ).toBe(true);
    expect(
      service.recognizesPreviewRequest(
        new Request(`${issued.preview!.origin}.evil.test/app`),
      ),
    ).toBe(false);

    const websocket = await service.handlePreviewRequest(
      new Request(`${issued.preview!.origin}/socket`, {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(websocket?.status).toBe(426);
    expect(upstream).not.toHaveBeenCalled();

    const [proxied, concurrent] = await Promise.all([
      service.handlePreviewRequest(
        new Request(`${issued.preview!.origin}/nested?q=1`, {
          headers: {
            "x-zeros-preview-capability": issued.preview!.capability,
          },
        }),
      ),
      service.handlePreviewRequest(
        new Request(`${issued.preview!.origin}/asset.js`, {
          headers: {
            "x-zeros-preview-capability": issued.preview!.capability,
          },
        }),
      ),
    ]);
    expect(proxied).not.toBeNull();
    expect(concurrent).not.toBeNull();
    await expect(proxied!.text()).resolves.toBe("preview-ok");
    await expect(concurrent!.text()).resolves.toBe("preview-ok");
    // One qualification lookup during issuance plus one shared proxy refresh.
    expect(provider.getPreviewEndpoint).toHaveBeenCalledTimes(2);
    expect(upstream).toHaveBeenCalledWith(
      `https://3000-${providerResourceId}.proxy.daytona.work/nested?q=1`,
      expect.objectContaining({ redirect: "manual" }),
    );
    const stored = await withSystemTx(pool, (tx) =>
      tx.query(
        `SELECT token_hash = $2 AS token_matches
         FROM cloud_workspace_client_access_grants WHERE id = $1`,
        [
          issued.grant.id,
          createHash("sha256").update(issued.preview!.capability).digest(),
        ],
      ),
    );
    expect(stored.rows[0]).toEqual({ token_matches: true });
    expect(JSON.stringify(stored.rows[0])).not.toContain(
      issued.preview!.capability,
    );

    await service.revoke({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      grantId: issued.grant.id,
      credential: issued.preview!.capability,
    });
    expect(provider.revokeSshAccess).not.toHaveBeenCalled();
    const denied = await service.handlePreviewRequest(
      new Request(`${issued.preview!.origin}/nested`, {
        headers: {
          "x-zeros-preview-capability": issued.preview!.capability,
        },
      }),
    );
    expect(denied?.status).toBe(401);
  });

  it("bounds concurrent streaming preview requests per grant", async () => {
    const { provider } = fakeAccessProvider();
    const upstream = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Intentionally remain open until the proxy response is cancelled.
            },
          }),
          { status: 200 },
        ),
    );
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
      fetcher: upstream,
    });
    const issued = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "preview",
      remotePort: 3_000,
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });
    const request = () =>
      service.handlePreviewRequest(
        new Request(`${issued.preview!.origin}/stream`, {
          headers: {
            "x-zeros-preview-capability": issued.preview!.capability,
          },
        }),
      );

    const active: Response[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await request();
      expect(response?.status).toBe(200);
      active.push(response!);
    }
    const limited = await request();
    expect(limited?.status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(4);

    await Promise.all(active.map((response) => response.body?.cancel()));
    const retried = await request();
    expect(retried?.status).toBe(200);
    await retried?.body?.cancel();
  });

  it("forwards preview mutation bodies byte-for-byte", async () => {
    const { provider } = fakeAccessProvider();
    const payload = Buffer.from('{"message":"exact preview bytes"}', "utf8");
    let forwarded = Buffer.alloc(0);
    const upstream = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        forwarded = Buffer.from(await new Response(init?.body).arrayBuffer());
        return new Response("accepted", { status: 202 });
      },
    );
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
      fetcher: upstream,
    });
    const issued = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "preview",
      remotePort: 3_000,
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });

    const response = await service.handlePreviewRequest(
      new Request(`${issued.preview!.origin}/api/save`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zeros-preview-capability": issued.preview!.capability,
        },
        body: payload,
      }),
    );

    expect(response?.status).toBe(202);
    expect(forwarded).toEqual(payload);
  });

  it("rejects oversized preview mutations before contacting the dev server", async () => {
    const { provider } = fakeAccessProvider();
    const upstream = vi.fn(async () => new Response("must-not-run"));
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
      fetcher: upstream,
    });
    const issued = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "preview",
      remotePort: 3_000,
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });

    const response = await service.handlePreviewRequest(
      new Request(`${issued.preview!.origin}/upload`, {
        method: "POST",
        headers: {
          "content-length": String(4 * 1024 * 1024 + 1),
          "content-type": "application/octet-stream",
          "x-zeros-preview-capability": issued.preview!.capability,
        },
        body: "x",
      }),
    );

    expect(response?.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses credential proof to revoke every sandbox SSH grant and drains again after membership loss", async () => {
    const { provider, sshCredential } = fakeAccessProvider();
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });
    const first = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "ssh",
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });
    const peer = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "tunnel",
      remotePort: 4_173,
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });
    await service.revoke({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      grantId: first.grant.id,
      credential: sshCredential,
    });
    expect(provider.revokeSshAccess).toHaveBeenCalledWith(providerResourceId);
    const explicitlyRevoked = await withSystemTx(pool, (tx) =>
      tx.query<{ id: string; state: string }>(
        `SELECT id, state FROM cloud_workspace_client_access_grants
         WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[first.grant.id, peer.grant.id]],
      ),
    );
    expect(explicitlyRevoked.rows).toHaveLength(2);
    expect(explicitlyRevoked.rows.every((row) => row.state === "revoked")).toBe(
      true,
    );

    const second = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "ssh",
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });
    await withSystemTx(pool, (tx) =>
      tx.query(
        `DELETE FROM team_members
         WHERE team_id = $1 AND org_id = $2 AND user_id = $3`,
        [teamId, orgId, actor.id],
      ),
    );
    const pending = await withSystemTx(pool, (tx) =>
      tx.query<{ state: string }>(
        `SELECT state FROM cloud_workspace_client_access_grants WHERE id = $1`,
        [second.grant.id],
      ),
    );
    expect(pending.rows[0]).toEqual({ state: "revocation_pending" });

    const worker = new CloudWorkspaceAccessRevocationWorker({
      pool,
      provider,
      leaseMs: 30_000,
    });
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(provider.revokeSshAccess).toHaveBeenLastCalledWith(
      providerResourceId,
    );
    const revoked = await withSystemTx(pool, (tx) =>
      tx.query<{ state: string }>(
        `SELECT state FROM cloud_workspace_client_access_grants WHERE id = $1`,
        [second.grant.id],
      ),
    );
    expect(revoked.rows[0]).toEqual({ state: "revoked" });
  });

  it("fences SSH issuance already in flight when a provider-wide revoke completes", async () => {
    const { provider, sshCredential } = fakeAccessProvider();
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });
    const active = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "ssh",
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    vi.mocked(provider.createSshAccess).mockImplementationOnce(
      async (_resourceId, expiresInMinutes) => {
        await providerGate;
        const credential =
          "ssh-token-provider-revocation-race-abcdefghijklmnopqrstuvwxyz";
        return {
          providerAccessId: randomUUID(),
          credential,
          host: "ssh.app.daytona.io",
          command: `ssh ${credential}@ssh.app.daytona.io`,
          expiresAt: new Date(Date.now() + expiresInMinutes * 60_000),
        };
      },
    );
    const issuing = service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "tunnel",
      remotePort: 4_173,
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });
    await vi.waitFor(() => {
      expect(provider.createSshAccess).toHaveBeenCalledTimes(2);
    });

    await service.revoke({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      grantId: active.grant.id,
      credential: sshCredential,
    });
    releaseProvider();

    await expect(issuing).rejects.toMatchObject({
      code: "cloud_workspace_access_superseded",
    });
    expect(provider.revokeSshAccess).toHaveBeenCalledTimes(2);
    const states = await withSystemTx(pool, (tx) =>
      tx.query<{ state: string }>(
        `SELECT state FROM cloud_workspace_client_access_grants
         ORDER BY created_at, id`,
      ),
    );
    expect(states.rows.every((row) => row.state === "revoked")).toBe(true);
  });

  it("fences SSH issuance before the remote provider-wide revoke returns", async () => {
    const { provider, sshCredential } = fakeAccessProvider();
    const bootstrap = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });
    const active = await bootstrap.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "ssh",
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });

    let releaseProviderIssuance!: () => void;
    const providerIssuanceGate = new Promise<void>((resolve) => {
      releaseProviderIssuance = resolve;
    });
    vi.mocked(provider.createSshAccess).mockImplementationOnce(
      async (_resourceId, expiresInMinutes) => {
        await providerIssuanceGate;
        const credential =
          "ssh-token-post-provider-revoke-race-abcdefghijklmnopqrstuvwxyz";
        return {
          providerAccessId: randomUUID(),
          credential,
          host: "ssh.app.daytona.io",
          command: `ssh ${credential}@ssh.app.daytona.io`,
          expiresAt: new Date(Date.now() + expiresInMinutes * 60_000),
        };
      },
    );

    let reportFinalization!: () => void;
    let releaseFinalization!: () => void;
    const finalizationReached = new Promise<void>((resolve) => {
      reportFinalization = resolve;
    });
    const finalizationGate = new Promise<void>((resolve) => {
      releaseFinalization = resolve;
    });
    let intercepted = false;
    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query") {
              return async (...args: unknown[]) => {
                const sql = typeof args[0] === "string" ? args[0] : "";
                if (
                  !intercepted &&
                  sql.includes("SET state = 'revoked'") &&
                  sql.includes("WHERE provider_resource_id = $1")
                ) {
                  intercepted = true;
                  reportFinalization();
                  await finalizationGate;
                }
                return (
                  target.query as (...queryArgs: unknown[]) => Promise<unknown>
                ).apply(target, args);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as pg.Pool;
    const service = new DatabaseCloudWorkspaceAccessService({
      pool: racingPool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });
    const issuing = service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "tunnel",
      remotePort: 4_173,
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });
    await vi.waitFor(() => {
      expect(provider.createSshAccess).toHaveBeenCalledTimes(2);
    });
    const revocation = service.revoke({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      grantId: active.grant.id,
      credential: sshCredential,
    });

    try {
      await finalizationReached;
      releaseProviderIssuance();
      await expect(issuing).rejects.toMatchObject({
        code: "cloud_workspace_access_superseded",
      });
    } finally {
      releaseProviderIssuance();
      releaseFinalization();
      await Promise.allSettled([issuing, revocation]);
    }
    await expect(revocation).resolves.toBeUndefined();
    expect(provider.revokeSshAccess).toHaveBeenCalledTimes(2);
  });

  it("cannot publish SSH access that races Team membership removal", async () => {
    const { provider } = fakeAccessProvider();
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    vi.mocked(provider.createSshAccess).mockImplementation(
      async (_resourceId, expiresInMinutes) => {
        await providerGate;
        const credential = "ssh-token-membership-race-abcdefghijklmnopqrstuvwxyz";
        return {
          providerAccessId: randomUUID(),
          credential,
          host: "ssh.app.daytona.io",
          command: `ssh ${credential}@ssh.app.daytona.io`,
          expiresAt: new Date(Date.now() + expiresInMinutes * 60_000),
        };
      },
    );
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });

    const issuing = service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "ssh",
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });
    await vi.waitFor(() => {
      expect(provider.createSshAccess).toHaveBeenCalledOnce();
    });
    await withSystemTx(pool, (tx) =>
      tx.query(
        `DELETE FROM team_members
         WHERE team_id = $1 AND org_id = $2 AND user_id = $3`,
        [teamId, orgId, actor.id],
      ),
    );
    const fenced = await withSystemTx(pool, (tx) =>
      tx.query<{ state: string; reason: string | null }>(
        `SELECT state, revocation_reason AS reason
         FROM cloud_workspace_client_access_grants
         ORDER BY created_at DESC LIMIT 1`,
      ),
    );
    expect(fenced.rows[0]).toEqual({
      state: "revocation_pending",
      reason: "team_membership_removed",
    });
    releaseProvider();

    await expect(issuing).rejects.toMatchObject({
      code: "not_found",
    });
    expect(provider.revokeSshAccess).toHaveBeenCalledWith(providerResourceId);
    const persisted = await withSystemTx(pool, (tx) =>
      tx.query<{ state: string; reason: string | null }>(
        `SELECT state, revocation_reason AS reason
         FROM cloud_workspace_client_access_grants
         ORDER BY created_at DESC LIMIT 1`,
      ),
    );
    expect(persisted.rows[0]).toEqual({
      state: "revoked",
      reason: "access_issue_superseded",
    });
  });

  it("queues provider revocation when a member leaves through user-context RLS", async () => {
    const { provider } = fakeAccessProvider();
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });
    const issued = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "ssh",
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });

    // This is the transaction context used by DELETE /members/:user. The
    // membership disappears from app_user_org_ids() during the statement, so
    // credential retirement must not depend on the caller retaining tenant
    // RLS visibility after the delete.
    await withUserTx(pool, actor.id, (tx) =>
      tx.query(
        `DELETE FROM organization_members
         WHERE org_id = $1 AND user_id = $2`,
        [orgId, actor.id],
      ),
    );

    const persisted = await withSystemTx(pool, (tx) =>
      tx.query<{ state: string; reason: string | null }>(
        `SELECT state, revocation_reason AS reason
         FROM cloud_workspace_client_access_grants WHERE id = $1`,
        [issued.grant.id],
      ),
    );
    expect(persisted.rows[0]).toEqual({
      state: "revocation_pending",
      reason: expect.stringMatching(/membership_removed$/),
    });
  });

  it.each(["organization", "owner account"] as const)(
    "keeps %s retirement in workspace-before-grant lock order",
    async (scope) => {
      const { provider } = fakeAccessProvider();
      const service = new DatabaseCloudWorkspaceAccessService({
        pool,
        provider,
        previewBaseDomain: "cloud-preview.example.test",
      });
      const issued = await service.issue({
        organizationId: orgId,
        workspaceId,
        accountUserId: actor.id,
        kind: "ssh",
        expiresInMinutes: 15,
        idempotencyKey: randomUUID(),
      });
      const workspaceOwner = await pool.connect();
      const scopeOwner = await pool.connect();
      let deletion: ReturnType<typeof scopeOwner.query> | null = null;
      try {
        await workspaceOwner.query("BEGIN");
        await workspaceOwner.query("SET LOCAL statement_timeout = '750ms'");
        await workspaceOwner.query(
          `SELECT 1 FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
          [workspaceId],
        );

        await scopeOwner.query("BEGIN");
        const backend = await scopeOwner.query<{ pid: number }>(
          `SELECT pg_backend_pid() AS pid`,
        );
        deletion = scopeOwner.query(
          scope === "organization"
            ? `UPDATE organizations SET deleted_at = now() WHERE id = $1`
            : `UPDATE users SET deleted_at = now() WHERE id = $1`,
          [scope === "organization" ? orgId : actor.id],
        );
        await vi.waitFor(
          async () => {
            const waiting = await pool.query<{ wait_event_type: string | null }>(
              `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
              [backend.rows[0]!.pid],
            );
            expect(waiting.rows[0]?.wait_event_type).toBe("Lock");
          },
          { timeout: 2_000, interval: 20 },
        );

        // A retirement function that already locked the grant while waiting
        // for this workspace creates the inverse edge and this statement times
        // out or deadlocks. Workspace-first retirement leaves it immediately
        // free.
        await expect(
          workspaceOwner.query(
            `UPDATE cloud_workspace_client_access_grants
             SET updated_at = now() WHERE id = $1`,
            [issued.grant.id],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });
        await workspaceOwner.query("COMMIT");
        await deletion;
        await scopeOwner.query("COMMIT");
      } finally {
        await workspaceOwner.query("ROLLBACK").catch(() => undefined);
        if (deletion) await deletion.catch(() => undefined);
        await scopeOwner.query("ROLLBACK").catch(() => undefined);
        workspaceOwner.release();
        scopeOwner.release();
      }
    },
  );

  it("retires lifecycle access without deadlocking membership retirement", async () => {
    const { provider } = fakeAccessProvider();
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });
    const issued = await service.issue({
      organizationId: orgId,
      workspaceId,
      accountUserId: actor.id,
      kind: "ssh",
      expiresInMinutes: 15,
      idempotencyKey: randomUUID(),
    });
    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO cloud_workspace_endpoint_grants (
           workspace_id, generation, org_id, account_user_id, purpose,
           audience, token_hash, account_revision, authorization_revision,
           expires_at
         ) VALUES ($1, 1, $2, $3, 'engine-connect', $4,
                   digest($5, 'sha256'), 1, 1,
                   now() + interval '5 minutes')`,
        [
          workspaceId,
          orgId,
          actor.id,
          "https://engine.example.test",
          randomUUID(),
        ],
      ),
    );

    let releaseEndpointLock!: () => void;
    let reportEndpointLock!: () => void;
    const endpointLockHeld = new Promise<void>((resolve) => {
      reportEndpointLock = resolve;
    });
    const allowRetirementToContinue = new Promise<void>((resolve) => {
      releaseEndpointLock = resolve;
    });
    let intercepted = false;
    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query") {
              return async (...args: unknown[]) => {
                const result = await (
                  target.query as (...queryArgs: unknown[]) => Promise<unknown>
                ).apply(target, args);
                const sql = typeof args[0] === "string" ? args[0] : "";
                if (sql === "BEGIN") {
                  await target.query("SET LOCAL statement_timeout = '750ms'");
                }
                if (
                  !intercepted &&
                  sql.includes("UPDATE cloud_workspace_endpoint_grants") &&
                  sql.includes("revoked_at")
                ) {
                  intercepted = true;
                  reportEndpointLock();
                  await allowRetirementToContinue;
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as pg.Pool;
    const retirement = withSystemTx(racingPool, (tx) =>
      retireCloudWorkspaceRuntimeAccess(tx, {
        workspaceId,
        organizationId: orgId,
        generation: 1,
        reason: "workspace_stop_requested",
      }),
    );
    const membershipOwner = await pool.connect();
    let removal: ReturnType<typeof membershipOwner.query> | null = null;
    try {
      await endpointLockHeld;
      const backend = await membershipOwner.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      removal = membershipOwner.query(
        `DELETE FROM team_members
         WHERE team_id = $1 AND org_id = $2 AND user_id = $3`,
        [teamId, orgId, actor.id],
      );
      await vi.waitFor(
        async () => {
          const waiting = await pool.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [backend.rows[0]!.pid],
          );
          expect(waiting.rows[0]?.wait_event_type).toBe("Lock");
        },
        { timeout: 2_000, interval: 20 },
      );
      releaseEndpointLock();

      await expect(retirement).resolves.toMatchObject({
        revokedGrantCount: 1,
        revocationPendingClientAccessCount: 1,
      });
      await removal;
    } finally {
      releaseEndpointLock();
      if (removal) await removal.catch(() => undefined);
      membershipOwner.release();
    }

    await expect(
      withSystemTx(pool, (tx) =>
        tx.query<{ access_state: string; endpoint_revoked: boolean }>(
          `SELECT access.state AS access_state,
                  endpoint.revoked_at IS NOT NULL AS endpoint_revoked
           FROM cloud_workspace_client_access_grants access
           CROSS JOIN cloud_workspace_endpoint_grants endpoint
           WHERE access.id = $1 AND endpoint.workspace_id = $2`,
          [issued.grant.id, workspaceId],
        ),
      ),
    ).resolves.toMatchObject({
      rows: [{ access_state: "revocation_pending", endpoint_revoked: true }],
    });
  });

  it("durably revokes provider-wide access when SSH issuance has an unknown outcome", async () => {
    const { provider } = fakeAccessProvider();
    provider.createSshAccess = vi.fn(async () => {
      throw new Error("response lost after provider commit");
    });
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });

    await expect(
      service.issue({
        organizationId: orgId,
        workspaceId,
        accountUserId: actor.id,
        kind: "ssh",
        expiresInMinutes: 15,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "cloud_access_provider_unavailable" });

    const pending = await withSystemTx(pool, (tx) =>
      tx.query<{ state: string; revocation_reason: string | null }>(
        `SELECT state, revocation_reason
         FROM cloud_workspace_client_access_grants
         ORDER BY created_at DESC LIMIT 1`,
      ),
    );
    expect(pending.rows[0]).toEqual({
      state: "revocation_pending",
      revocation_reason: "access_issue_unknown",
    });

    const worker = new CloudWorkspaceAccessRevocationWorker({
      pool,
      provider,
      leaseMs: 30_000,
    });
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(provider.revokeSshAccess).toHaveBeenCalledWith(providerResourceId);
    const revoked = await withSystemTx(pool, (tx) =>
      tx.query<{ state: string }>(
        `SELECT state FROM cloud_workspace_client_access_grants
         ORDER BY created_at DESC LIMIT 1`,
      ),
    );
    expect(revoked.rows[0]).toEqual({ state: "revoked" });
  });

  it("does not mask a safe provider error when failure recording is temporarily unavailable", async () => {
    const { provider } = fakeAccessProvider();
    provider.createSshAccess = vi.fn(async () => {
      throw new Error("response lost after provider commit");
    });
    let connections = 0;
    const recordingFailurePool = {
      connect: async () => {
        connections += 1;
        if (connections > 1) {
          throw new Error("database unavailable during failure recording");
        }
        return pool.connect();
      },
    } as unknown as pg.Pool;
    const service = new DatabaseCloudWorkspaceAccessService({
      pool: recordingFailurePool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });

    await expect(
      service.issue({
        organizationId: orgId,
        workspaceId,
        accountUserId: actor.id,
        kind: "ssh",
        expiresInMinutes: 15,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "cloud_access_provider_unavailable" });
  });

  it("bounds each background revocation drain and stops between batches", async () => {
    const { provider } = fakeAccessProvider();
    const service = new DatabaseCloudWorkspaceAccessService({
      pool,
      provider,
      previewBaseDomain: "cloud-preview.example.test",
    });
    const grants = await Promise.all(
      [3_000, 3_001, 3_002].map((remotePort) =>
        service.issue({
          organizationId: orgId,
          workspaceId,
          accountUserId: actor.id,
          kind: "preview",
          remotePort,
          expiresInMinutes: 15,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE cloud_workspace_client_access_grants
         SET state = 'revocation_pending', next_revocation_at = now()
         WHERE id = ANY($1::uuid[])`,
        [grants.map((grant) => grant.grant.id)],
      ),
    );
    const worker = new CloudWorkspaceAccessRevocationWorker({
      pool,
      provider,
      leaseMs: 30_000,
      intervalMs: 60_000,
      maxBatch: 1,
    });

    const stop = worker.start();
    await vi.waitFor(async () => {
      const result = await withSystemTx(pool, (tx) =>
        tx.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM cloud_workspace_client_access_grants
           WHERE id = ANY($1::uuid[]) AND state = 'revoked'`,
          [grants.map((grant) => grant.grant.id)],
        ),
      );
      expect(Number(result.rows[0]!.count)).toBeGreaterThan(0);
    });
    await stop();

    const states = await withSystemTx(pool, (tx) =>
      tx.query<{ state: string; count: string }>(
        `SELECT state, count(*)::text AS count
         FROM cloud_workspace_client_access_grants
         WHERE id = ANY($1::uuid[])
         GROUP BY state ORDER BY state`,
        [grants.map((grant) => grant.grant.id)],
      ),
    );
    expect(states.rows).toEqual([
      { state: "revocation_pending", count: "2" },
      { state: "revoked", count: "1" },
    ]);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { ensureUser } from "../auth.js";
import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  CloudProviderError,
  type CloudProviderCreateInput,
  type CloudProviderIdentity,
  type CloudProviderResource,
  type CloudWorkspaceProvider,
} from "./provider.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

class Deferred {
  readonly promise: Promise<void>;
  private resolvePromise!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(): void {
    this.resolvePromise();
  }
}

class FakeProvider implements CloudWorkspaceProvider {
  readonly name = "daytona";
  readonly resources = new Map<string, CloudProviderResource>();
  createCount = 0;
  lastCreateInput: CloudProviderCreateInput | null = null;
  startCount = 0;
  stopCount = 0;
  archiveCount = 0;
  deleteCount = 0;
  createFailure: CloudProviderError | null = null;
  createEntered: Deferred | null = null;
  createRelease: Deferred | null = null;

  private id(identity: CloudProviderIdentity): string {
    return `resource-${identity.workspaceId}-${identity.generation}`;
  }

  make(
    identity: CloudProviderIdentity,
    state: CloudProviderResource["state"] = "running",
    resourceId = this.id(identity),
  ): CloudProviderResource {
    return {
      resourceId,
      state,
      target: "test-region",
      ...identity,
      metadata: { cpu: 2, memoryGiB: 4 },
    };
  }

  async find(identity: CloudProviderIdentity): Promise<CloudProviderResource[]> {
    return [...this.resources.values()].filter(
      (resource) =>
        resource.workspaceId === identity.workspaceId &&
        resource.generation === identity.generation,
    );
  }

  async create(input: CloudProviderCreateInput): Promise<CloudProviderResource> {
    this.createCount += 1;
    this.lastCreateInput = input;
    const resource = this.make(input);
    this.resources.set(resource.resourceId, resource);
    this.createEntered?.resolve();
    if (this.createRelease) await this.createRelease.promise;
    if (this.createFailure) throw this.createFailure;
    return resource;
  }

  async inspect(resourceId: string): Promise<CloudProviderResource | null> {
    return this.resources.get(resourceId) ?? null;
  }

  async start(resourceId: string): Promise<CloudProviderResource> {
    this.startCount += 1;
    const current = this.resources.get(resourceId)!;
    const next = { ...current, state: "running" as const };
    this.resources.set(resourceId, next);
    return next;
  }

  async stop(resourceId: string): Promise<CloudProviderResource> {
    this.stopCount += 1;
    const current = this.resources.get(resourceId)!;
    const next = { ...current, state: "stopped" as const };
    this.resources.set(resourceId, next);
    return next;
  }

  async archive(resourceId: string): Promise<CloudProviderResource> {
    this.archiveCount += 1;
    const current = this.resources.get(resourceId)!;
    const next = { ...current, state: "archived" as const };
    this.resources.set(resourceId, next);
    return next;
  }

  async delete(resourceId: string): Promise<void> {
    this.deleteCount += 1;
    this.resources.delete(resourceId);
  }

  async *listManaged(): AsyncIterable<CloudProviderResource> {
    yield* this.resources.values();
  }
}

d("cloud workspace reconciliation", () => {
  let pool: pg.Pool;
  let orgId: string;
  let teamId: string;
  let ownerId: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 8 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    const sub = randomUUID();
    const owner = await ensureUser(pool, {
      provider: "auth0",
      providerSubject: sub,
      email: `owner-${sub}@example.com`,
      displayName: "Owner",
    });
    ownerId = owner.id;
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
      return { organizationId, defaultTeamId };
    });
    orgId = seeded.organizationId;
    teamId = seeded.defaultTeamId;
  });

  const seedWorkspace = async (input?: {
    desiredState?: "running" | "stopped" | "archived" | "deleted";
    status?: string;
    operation?: "create" | "stop" | "wake" | "archive" | "delete";
    intentState?: string;
    providerResourceId?: string | null;
    observedState?: string;
  }) => {
    const workspaceId = randomUUID();
    const intentId = randomUUID();
    const desiredState = input?.desiredState ?? "running";
    const status = input?.status ?? "requested";
    const operation = input?.operation ?? "create";
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, status, desired_state
         ) VALUES ($1, $2, $3, $4, 'Test', 'github.com', 'withso',
                   'zeros', 'main', $5::cloud_workspace_status,
                   $6::cloud_workspace_desired_state)`,
        [workspaceId, orgId, teamId, ownerId, status, desiredState],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3, $4)`,
        [workspaceId, orgId, "a".repeat(40), ownerId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider,
           provider_resource_id, observed_state, last_observed_at
         ) VALUES ($1, 1, $2, 'daytona', $3, $4, now() - interval '1 hour')`,
        [
          workspaceId,
          orgId,
          input?.providerResourceId ?? null,
          input?.observedState ?? "absent",
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, org_id, requested_by, operation,
           idempotency_key, request_sha256, state, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7,
                   $8::cloud_workspace_intent_state,
                   CASE WHEN $8 IN ('succeeded', 'failed', 'superseded')
                        THEN now() ELSE NULL END)`,
        [
          intentId,
          workspaceId,
          orgId,
          ownerId,
          operation,
          randomUUID(),
          createHash("sha256").update(randomUUID()).digest(),
          input?.intentState ?? "queued",
        ],
      );
    });
    return { workspaceId, intentId };
  };

  const reconciler = (provider: FakeProvider, options: Record<string, unknown> = {}) =>
    new CloudWorkspaceReconciler({
      pool,
      provider,
      intervalMs: 1_000,
      workerId: `worker-${randomUUID()}`,
      logger: { info() {}, warn() {}, error() {} },
      ...options,
    });

  it("creates once, binds the provider resource, and queues setup without claiming readiness", async () => {
    const seeded = await seedWorkspace();
    const provider = new FakeProvider();
    expect(await reconciler(provider).runOnce()).toBe(true);
    expect(provider.createCount).toBe(1);
    expect(provider.lastCreateInput).toMatchObject({
      imageRef: "snap-pinned",
      architecture: "linux/amd64",
      cpuMillicores: 2_000,
      memoryMiB: 4_096,
      storageMiB: 20_480,
    });

    const result = await pool.query(
      `SELECT cw.status, i.state AS intent_state, pb.provider_resource_id,
              pb.observed_state, sr.state AS setup_state
       FROM cloud_workspaces cw
       JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
       JOIN cloud_workspace_provider_bindings pb ON pb.workspace_id = cw.id
       LEFT JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(result.rows[0]).toMatchObject({
      status: "setting_up",
      intent_state: "succeeded",
      provider_resource_id: `resource-${seeded.workspaceId}-1`,
      observed_state: "running",
      setup_state: "queued",
    });
  });

  it("recovers a timeout after provider dispatch without creating a duplicate", async () => {
    const seeded = await seedWorkspace();
    const provider = new FakeProvider();
    provider.createFailure = new CloudProviderError(
      "provider_temporarily_unavailable",
      "response contained secret-provider-detail",
      true,
    );
    const worker = reconciler(provider);
    await worker.runOnce();
    expect(provider.createCount).toBe(1);
    let state = await pool.query(
      `SELECT state, error_message FROM cloud_workspace_lifecycle_intents
       WHERE id = $1`,
      [seeded.intentId],
    );
    expect(state.rows[0]).toEqual({
      state: "observing",
      error_message: "Cloud provider operation is temporarily unavailable",
    });
    expect(JSON.stringify(state.rows[0])).not.toContain("secret-provider-detail");

    provider.createFailure = null;
    await pool.query(
      `UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at = now()
       WHERE id = $1`,
      [seeded.intentId],
    );
    await worker.runOnce();
    expect(provider.createCount).toBe(1);
    state = await pool.query(
      `SELECT state FROM cloud_workspace_lifecycle_intents WHERE id = $1`,
      [seeded.intentId],
    );
    expect(state.rows[0]).toEqual({ state: "succeeded" });
  });

  it("leases a workspace so two control-plane replicas cannot dispatch it concurrently", async () => {
    await seedWorkspace();
    const provider = new FakeProvider();
    provider.createEntered = new Deferred();
    provider.createRelease = new Deferred();
    const first = reconciler(provider);
    const second = reconciler(provider);

    const firstRun = first.runOnce();
    await provider.createEntered.promise;
    await expect(second.runOnce()).resolves.toBe(false);
    provider.createRelease.resolve();
    await expect(firstRun).resolves.toBe(true);
    expect(provider.createCount).toBe(1);
  });

  it("detects provider drift and converges stopped back to the desired running state", async () => {
    const seeded = await seedWorkspace({
      status: "ready",
      intentState: "succeeded",
      providerResourceId: "bound-resource",
      observedState: "running",
    });
    const provider = new FakeProvider();
    provider.resources.set(
      "bound-resource",
      provider.make({ workspaceId: seeded.workspaceId, generation: 1 }, "stopped", "bound-resource"),
    );
    const worker = reconciler(provider);
    expect(await worker.reconcileDriftOnce()).toBe(true);
    const queued = await pool.query(
      `SELECT operation, state FROM cloud_workspace_lifecycle_intents
       WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [seeded.workspaceId],
    );
    expect(queued.rows[0]).toEqual({ operation: "wake", state: "queued" });

    await worker.runOnce();
    expect(provider.startCount).toBe(1);
    const workspace = await pool.query(
      `SELECT status FROM cloud_workspaces WHERE id = $1`,
      [seeded.workspaceId],
    );
    expect(workspace.rows[0]).toEqual({ status: "setting_up" });
  });

  it("does not dispatch a stale create after delete wins, but still discovers and deletes an unknown result", async () => {
    const seeded = await seedWorkspace({ desiredState: "deleted", status: "deleting" });
    const provider = new FakeProvider();
    const unknown = provider.make({ workspaceId: seeded.workspaceId, generation: 1 });
    provider.resources.set(unknown.resourceId, unknown);
    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           workspace_id, org_id, requested_by, operation, idempotency_key,
           request_sha256
         ) VALUES ($1, $2, $3, 'delete', $4, $5)`,
        [
          seeded.workspaceId,
          orgId,
          ownerId,
          randomUUID(),
          createHash("sha256").update(randomUUID()).digest(),
        ],
      ),
    );
    const worker = reconciler(provider);
    await worker.runOnce();
    expect(provider.createCount).toBe(0);
    const first = await pool.query(
      `SELECT state FROM cloud_workspace_lifecycle_intents WHERE id = $1`,
      [seeded.intentId],
    );
    expect(first.rows[0]).toEqual({ state: "superseded" });

    await worker.runOnce();
    expect(provider.deleteCount).toBe(1);
    const workspace = await pool.query(
      `SELECT status, deleted_at IS NOT NULL AS deleted
       FROM cloud_workspaces WHERE id = $1`,
      [seeded.workspaceId],
    );
    expect(workspace.rows[0]).toEqual({ status: "deleted", deleted: true });
  });

  it("recovers an unbound known generation and deletes only twice-observed aged true orphans", async () => {
    const seeded = await seedWorkspace({ intentState: "succeeded" });
    const provider = new FakeProvider();
    const recovered = provider.make({ workspaceId: seeded.workspaceId, generation: 1 });
    provider.resources.set(recovered.resourceId, recovered);
    const worker = reconciler(provider, {
      orphanGraceMs: 60_000,
    });

    await worker.reconcileOrphansOnce();
    expect(provider.deleteCount).toBe(0);
    const binding = await pool.query(
      `SELECT provider_resource_id FROM cloud_workspace_provider_bindings
       WHERE workspace_id = $1`,
      [seeded.workspaceId],
    );
    expect(binding.rows[0]).toEqual({ provider_resource_id: recovered.resourceId });

    const orphanWorkspace = randomUUID();
    const orphan = provider.make({ workspaceId: orphanWorkspace, generation: 1 });
    provider.resources.set(orphan.resourceId, orphan);
    await worker.reconcileOrphansOnce();
    expect(provider.deleteCount).toBe(0);
    await pool.query(
      `UPDATE cloud_workspace_provider_orphans
       SET first_seen_at = now() - interval '2 minutes'
       WHERE provider_resource_id = $1`,
      [orphan.resourceId],
    );
    await worker.reconcileOrphansOnce();
    expect(provider.deleteCount).toBe(1);
    expect(provider.resources.has(orphan.resourceId)).toBe(false);
    expect(provider.resources.has(recovered.resourceId)).toBe(true);

    const record = await pool.query(
      `SELECT observation_count, deletion_verified_at IS NOT NULL AS verified
       FROM cloud_workspace_provider_orphans
       WHERE provider_resource_id = $1`,
      [orphan.resourceId],
    );
    expect(record.rows[0]).toMatchObject({ verified: true });
    expect(record.rows[0].observation_count).toBeGreaterThanOrEqual(2);
  });

  it("fails permanently with a sanitized record when the provider rejects identity", async () => {
    const seeded = await seedWorkspace();
    const provider = new FakeProvider();
    provider.createFailure = new CloudProviderError(
      "provider_authorization_failed",
      "secret API key was rejected",
      false,
    );
    await reconciler(provider).runOnce();
    const result = await pool.query(
      `SELECT i.state, i.error_code, i.error_message, cw.status,
              cw.last_error_message
       FROM cloud_workspace_lifecycle_intents i
       JOIN cloud_workspaces cw ON cw.id = i.workspace_id
       WHERE i.id = $1`,
      [seeded.intentId],
    );
    expect(result.rows[0]).toMatchObject({
      state: "failed",
      error_code: "provider_authorization_failed",
      error_message: "Cloud provider rejected the lifecycle operation",
      status: "failed",
      last_error_message: "Cloud provider rejected the lifecycle operation",
    });
    expect(JSON.stringify(result.rows[0])).not.toContain("secret API key");
  });
});

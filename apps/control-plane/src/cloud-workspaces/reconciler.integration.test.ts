import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { ensureCloudPilotUser as ensureUser } from "./test-fixtures.js";
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
import { DatabaseCloudWorkspacePaidAuthorityReconciler } from "./paid-authority.js";
import { CloudWorkspaceCheckpointRequestWorker, enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import {assertDatabaseLockOrder} from "./lock-order-test-utils.js";
import {
  seedCanonicalCloudWorkspaceAuthority,
  seedCanonicalCloudWorkspacePrerequisites,
  seedCanonicalWorkspaceSettingsVersion,
} from "./test-fixtures.js";

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
  verifyAbsence?: (identity: CloudProviderIdentity) => Promise<boolean>;
  readonly resources = new Map<string, CloudProviderResource>();
  createCount = 0;
  lastCreateInput: CloudProviderCreateInput | null = null;
  startCount = 0;
  stopCount = 0;
  archiveCount = 0;
  deleteCount = 0;
  createFailure: CloudProviderError | null = null;
  stopFailure: CloudProviderError | null = null;
  createEntered: Deferred | null = null;
  createRelease: Deferred | null = null;
  deleteObservedState: CloudProviderResource["state"] | null = null;
  durableOwnership = true;

  async verifyManagedResourceOwnership(_resource: CloudProviderResource): Promise<boolean> {
    return this.durableOwnership;
  }

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

  async find(
    identity: CloudProviderIdentity,
  ): Promise<CloudProviderResource[]> {
    return [...this.resources.values()].filter(
      (resource) =>
        resource.workspaceId === identity.workspaceId &&
        resource.generation === identity.generation,
    );
  }

  async create(
    input: CloudProviderCreateInput,
  ): Promise<CloudProviderResource> {
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
    if (this.stopFailure) throw this.stopFailure;
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
    if (this.deleteObservedState) {
      const current = this.resources.get(resourceId)!;
      this.resources.set(resourceId, {
        ...current,
        state: this.deleteObservedState,
      });
    } else {
      this.resources.delete(resourceId);
    }
  }

  async *listManaged(): AsyncIterable<CloudProviderResource> {
    yield* this.resources.values();
  }
}

describe("cloud workspace reconciler configuration", () => {
  const construct = (overrides: Record<string, unknown>) =>
    new CloudWorkspaceReconciler({
      pool: {} as pg.Pool,
      provider: new FakeProvider(),
      intervalMs: 1_000,
      ...overrides,
    });

  it("rejects unsafe timing and lease-owner values before starting", () => {
    expect(() => construct({ intervalMs: 0 })).toThrow(/timing/i);
    expect(() => construct({ leaseMs: 999 })).toThrow(/timing/i);
    expect(() => construct({ orphanGraceMs: 999 })).toThrow(/timing/i);
    expect(() => construct({ workerId: "worker\nforged" })).toThrow(/worker/i);
  });
});

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
    let providerConnectionId = "";
    await withSystemTx(pool, async (tx) => {
      const canonical = await seedCanonicalCloudWorkspacePrerequisites(tx, {
        organizationId: orgId,
        ownerUserId: ownerId,
      });
      providerConnectionId = canonical.providerConnectionId;
      await tx.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, repository_id, owner_user_id,
           assignee_user_id, status, desired_state
         ) VALUES ($1, $2, $3, $4, 'Test', 'github.com', 'withso',
                   'zeros', 'main', $5, $4, $4,
                   $6::cloud_workspace_status,
                   $7::cloud_workspace_desired_state)`,
        [
          workspaceId,
          orgId,
          teamId,
          ownerId,
          canonical.repositoryId,
          status,
          desiredState,
        ],
      );
      await seedCanonicalCloudWorkspaceAuthority(tx, {
        workspaceId,
        organizationId: orgId,
        ownerUserId: ownerId,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3, $4, $5)`,
        [workspaceId, orgId, "a".repeat(40), ownerId, providerConnectionId],
      );
      const settingsDocument = { schemaVersion: 1, values: {} };
      const settingsVersionId = await seedCanonicalWorkspaceSettingsVersion(
        tx,
        {
          workspaceId,
          organizationId: orgId,
          generation: 1,
          createdBy: ownerId,
          effectiveDocument: settingsDocument,
        },
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, repository_forge,
           repository_owner, repository_name, repository_revision,
           settings_snapshot, settings_snapshot_sha256,
           workspace_settings_version_id
         ) VALUES ($1, 1, $2, 'github.com', 'withso', 'zeros', 'main',
                   $3::jsonb, digest($3::jsonb::text, 'sha256'), $4)`,
        [
          workspaceId,
          orgId,
          JSON.stringify(settingsDocument),
          settingsVersionId,
        ],
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
    return { workspaceId, intentId, providerConnectionId };
  };

  it.each(["stop", "archive"] as const)(
    "does not dispatch %s for a provider resource already observed as deleted",
    async (operation) => {
      const resourceId = `deleted-${operation}`;
      const seeded = await seedWorkspace({
        desiredState: operation === "stop" ? "stopped" : "archived",
        status: operation === "stop" ? "stopping" : "archiving",
        operation,
        providerResourceId: resourceId,
        observedState: "deleted",
      });
      const provider = new FakeProvider();
      provider.resources.set(
        resourceId,
        provider.make(
          { workspaceId: seeded.workspaceId, generation: 1 },
          "deleted",
          resourceId,
        ),
      );
      const reconciler = new CloudWorkspaceReconciler({
        pool,
        provider,
        intervalMs: 1_000,
      });

      await expect(reconciler.runOnce()).resolves.toBe(true);
      expect(provider.stopCount).toBe(0);
      expect(provider.archiveCount).toBe(0);
    },
  );

  it("completes portable VM archive using verified offloaded cold storage",async()=>{
    const resourceId="stopped-vm";
    const seeded=await seedWorkspace({desiredState:"archived",status:"archiving",operation:"archive",providerResourceId:resourceId,observedState:"stopped"});
    const provider=new FakeProvider();
    const resource={...provider.make({workspaceId:seeded.workspaceId,generation:1},"stopped",resourceId),storageOffloaded:true};
    provider.resources.set(resourceId,resource);
    provider.archive=async()=>{provider.archiveCount++;return resource;};
    const worker=new CloudWorkspaceReconciler({pool,provider,intervalMs:1000});
    await worker.runOnce();
    expect(provider.archiveCount).toBe(1);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[seeded.intentId])).rows[0].state).toBe("succeeded");
    expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1",[seeded.workspaceId])).rows[0].status).toBe("archived");
    await pool.query("UPDATE cloud_workspace_provider_bindings SET last_observed_at=NULL WHERE workspace_id=$1",[seeded.workspaceId]);
    await worker.reconcileDriftOnce();
    expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1",[seeded.workspaceId])).rows[0].status).toBe("archived");
  });

  const seedGenerationTransition = async () => {
    const seeded = await seedWorkspace({
      status: "ready",
      intentState: "succeeded",
      providerResourceId: "source-resource",
      observedState: "running",
    });
    const transitionId = randomUUID();
    const candidateIntentId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) VALUES ($1, 2, $2, 'daytona', 'snap-next', 'linux/amd64',
                   2000, 4096, 20480, $3, $4, $5)`,
        [
          seeded.workspaceId,
          orgId,
          "b".repeat(40),
          ownerId,
          seeded.providerConnectionId,
        ],
      );
      const settingsDocument = { schemaVersion: 1, values: {} };
      const settingsVersionId = await seedCanonicalWorkspaceSettingsVersion(
        tx,
        {
          workspaceId: seeded.workspaceId,
          organizationId: orgId,
          generation: 2,
          createdBy: ownerId,
          effectiveDocument: settingsDocument,
        },
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, repository_forge,
           repository_owner, repository_name, repository_revision,
           settings_snapshot, settings_snapshot_sha256,
           workspace_settings_version_id
         ) VALUES ($1, 2, $2, 'github.com', 'withso', 'zeros', 'main',
                   $3::jsonb, digest($3::jsonb::text, 'sha256'), $4)`,
        [
          seeded.workspaceId,
          orgId,
          JSON.stringify(settingsDocument),
          settingsVersionId,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider
         ) VALUES ($1, 2, $2, 'daytona')`,
        [seeded.workspaceId, orgId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, generation, org_id, requested_by, operation,
           idempotency_key, request_sha256
         ) VALUES ($1, $2, 2, $3, $4, 'create', $5, $6)`,
        [
          candidateIntentId,
          seeded.workspaceId,
          orgId,
          ownerId,
          randomUUID(),
          createHash("sha256").update(randomUUID()).digest(),
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generation_transitions (
           id, workspace_id, org_id, requested_by, operation,
           source_generation, template_generation, candidate_generation,
           state, provision_intent_id
         ) VALUES ($1, $2, $3, $4, 'upgrade', 1, 1, 2,
                   'provisioning', $5)`,
        [transitionId, seeded.workspaceId, orgId, ownerId, candidateIntentId],
      );
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET generation_transition_id = $2 WHERE id = $1`,
        [candidateIntentId, transitionId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET current_generation = 2, status = 'provisioning',
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [seeded.workspaceId],
      );
    });
    return { ...seeded, transitionId, candidateIntentId };
  };

  const seedDrainingGenerationTransition = async () => {
    const seeded = await seedWorkspace({
      status: "ready",
      intentState: "succeeded",
      providerResourceId: "source-resource",
      observedState: "running",
    });
    const transitionId = randomUUID();
    const drainIntentId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      const setupRunId = randomUUID();
      const registrationGrantId = randomUUID();
      const engineInstanceId = randomUUID();
      const checkpointId = randomUUID();
      const manifestBlobId = randomUUID();
      const contentDigest = createHash("sha256")
        .update(`checkpoint:${checkpointId}`)
        .digest();
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) VALUES ($1, 2, $2, 'daytona', 'snap-next', 'linux/amd64',
                   2000, 4096, 20480, $3, $4, $5)`,
        [
          seeded.workspaceId,
          orgId,
          "b".repeat(40),
          ownerId,
          seeded.providerConnectionId,
        ],
      );
      const settingsDocument = { schemaVersion: 1, values: {} };
      const settingsVersionId = await seedCanonicalWorkspaceSettingsVersion(
        tx,
        {
          workspaceId: seeded.workspaceId,
          organizationId: orgId,
          generation: 2,
          createdBy: ownerId,
          effectiveDocument: settingsDocument,
        },
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, repository_forge,
           repository_owner, repository_name, repository_revision,
           settings_snapshot, settings_snapshot_sha256,
           workspace_settings_version_id
         ) VALUES ($1, 2, $2, 'github.com', 'withso', 'zeros', 'main',
                   $3::jsonb, digest($3::jsonb::text, 'sha256'), $4)`,
        [
          seeded.workspaceId,
          orgId,
          JSON.stringify(settingsDocument),
          settingsVersionId,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider
         ) VALUES ($1, 2, $2, 'daytona')`,
        [seeded.workspaceId, orgId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, generation, org_id, requested_by, operation,
           idempotency_key, request_sha256, affects_workspace
         ) VALUES ($1, $2, 1, $3, $4, 'stop', $5, $6, false)`,
        [
          drainIntentId,
          seeded.workspaceId,
          orgId,
          ownerId,
          randomUUID(),
          createHash("sha256").update(randomUUID()).digest(),
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generation_transitions (
           id, workspace_id, org_id, requested_by, operation,
           source_generation, template_generation, candidate_generation,
           state, drain_intent_id
         ) VALUES ($1, $2, $3, $4, 'upgrade', 1, 1, 2,
                   'draining', $5)`,
        [transitionId, seeded.workspaceId, orgId, ownerId, drainIntentId],
      );
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET generation_transition_id = $2 WHERE id = $1`,
        [drainIntentId, transitionId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_runs (
           id, workspace_id, generation, org_id, attempt, state, claim_count,
           execution_fence, lease_owner, lease_expires_at, last_heartbeat_at,
           started_at
         ) VALUES ($1, $2, 1, $3, 1, 'running', 1, 1, 'fixture',
                   now() + interval '10 minutes', now(), now())`,
        [setupRunId, seeded.workspaceId, orgId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_endpoint_grants (
           id, workspace_id, generation, org_id, account_user_id, purpose,
           audience, token_hash, account_revision, authorization_revision,
           expires_at, consumed_at
         ) VALUES ($1, $2, 1, $3, $4, 'engine-connect', 'fixture', $5,
                   1, 1, now() + interval '10 minutes', now())`,
        [
          registrationGrantId,
          seeded.workspaceId,
          orgId,
          ownerId,
          randomBytes(32),
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_engine_instances (
           id, workspace_id, generation, org_id, account_user_id, setup_run_id,
           setup_execution_fence, registration_grant_id, protocol_version,
           state, bridge_token_hash, heartbeat_token_hash, registered_at,
           last_heartbeat_at, lease_expires_at
         ) VALUES ($1, $2, 1, $3, $4, $5, 1, $6, 11, 'ready', $7, $8,
                   now(), now(), now() + interval '10 minutes')`,
        [
          engineInstanceId,
          seeded.workspaceId,
          orgId,
          ownerId,
          setupRunId,
          registrationGrantId,
          randomBytes(32),
          randomBytes(32),
        ],
      );
      await tx.query(
        `INSERT INTO workspace_content_heads (
           workspace_id, org_id, current_revision, durable_revision,
           last_durable_at
         ) VALUES ($1, $2, 1, 1, now())`,
        [seeded.workspaceId, orgId],
      );
      await tx.query(
        `INSERT INTO workspace_content_revisions (
           workspace_id, org_id, revision, parent_revision, authority_epoch,
           generation, engine_instance_id, idempotency_key, request_sha256,
           changed_entry_count
         ) VALUES ($1, $2, 1, 0, 1, 1, $3, $4, $5, 1)`,
        [
          seeded.workspaceId,
          orgId,
          engineInstanceId,
          `checkpoint-content-${randomUUID()}`,
          contentDigest,
        ],
      );
      await tx.query(
        `INSERT INTO workspace_blobs (
           id, org_id, plaintext_sha256, ciphertext_sha256,
           plaintext_bytes, ciphertext_bytes, object_key,
           encryption_key_version, nonce, auth_tag, state, available_at
         ) VALUES ($1, $2, $3, $3, 2, 2, $4, 1, $5, $6,
                   'available', now())`,
        [
          manifestBlobId,
          orgId,
          contentDigest,
          `fixture/checkpoint/${checkpointId}`,
          randomBytes(12),
          randomBytes(16),
        ],
      );
      await tx.query(
        `INSERT INTO workspace_checkpoints (
           id, workspace_id, org_id, idempotency_key, request_sha256,
           content_revision, record_revision, authority_epoch, generation,
           reason, manifest_blob_id, inclusion_policy, file_count, total_bytes,
           state, integrity_sha256, durable_at
         ) VALUES ($1, $2, $3, $4, $5, 1, 0, 1, 1, 'before_rebuild',
                   $6, '{}', 0, 0, 'durable', $5, now())`,
        [
          checkpointId,
          seeded.workspaceId,
          orgId,
          `checkpoint-${randomUUID()}`,
          contentDigest,
          manifestBlobId,
        ],
      );
      await tx.query(
        `UPDATE workspace_content_heads
         SET current_checkpoint_id = $2
         WHERE workspace_id = $1`,
        [seeded.workspaceId, checkpointId],
      );
      await tx.query(
        `INSERT INTO workspace_checkpoint_requests (
           workspace_id, generation, org_id, requested_by,
           lifecycle_intent_id, reason, state, idempotency_key,
           checkpoint_id, deadline_at, completed_at
         ) VALUES ($1, 1, $2, $3, $4, 'before_rebuild', 'succeeded', $5,
                   $6, now() + interval '10 minutes', now())`,
        [
          seeded.workspaceId,
          orgId,
          ownerId,
          drainIntentId,
          `generation.${transitionId}`,
          checkpointId,
        ],
      );
    });
    return { ...seeded, transitionId, drainIntentId };
  };

  const reconciler = (
    provider: FakeProvider,
    options: Record<string, unknown> = {},
  ) =>
    new CloudWorkspaceReconciler({
      pool,
      provider,
      intervalMs: 1_000,
      workerId: `worker-${randomUUID()}`,
      logger: { info() {}, warn() {}, error() {} },
      ...options,
    });

  it.each(["identity", "entitlement", "provider"])("stops a checkpoint-gated delete after %s authority is revoked without discarding data", async (revoked) => {
    const seeded = await seedWorkspace({desiredState:"running",status:"ready",operation:"delete",providerResourceId:"bound-resource",observedState:"running"});
    await withSystemTx(pool,async tx=>{
      await enqueueWorkspaceCheckpointRequest(tx,{workspaceId:seeded.workspaceId,organizationId:orgId,generation:1,requestedBy:ownerId,lifecycleIntentId:seeded.intentId,reason:"before_delete",idempotencyKey:randomUUID()});
      if(revoked==="identity")await tx.query("UPDATE users SET auth_status='identity_disabled' WHERE id=$1",[ownerId]);
      else if(revoked==="entitlement")await tx.query("UPDATE organization_entitlements SET status='expired',revision=revision+1 WHERE org_id=$1",[orgId]);
      else await tx.query("UPDATE provider_connections SET state='revoked',revoked_at=now() WHERE id=$1",[seeded.providerConnectionId]);
    });
    const provider = new FakeProvider();
    provider.resources.set("bound-resource",provider.make({workspaceId:seeded.workspaceId,generation:1},"running","bound-resource"));
    await expect(new DatabaseCloudWorkspacePaidAuthorityReconciler(pool,{workosEnabled:false}).runOnce()).resolves.toMatchObject({action:"stopped"});
    await new CloudWorkspaceCheckpointRequestWorker(pool).expireOnce();
    const worker = reconciler(provider);
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(provider.stopCount).toBe(1);
    expect(provider.deleteCount).toBe(0);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[seeded.intentId])).rows[0]).toEqual({state:"superseded"});
    expect((await pool.query("SELECT desired_state,status FROM cloud_workspaces WHERE id=$1",[seeded.workspaceId])).rows[0]).toEqual({desired_state:"stopped",status:"stopped"});
    await worker.reconcileDriftOnce();
    expect(provider.deleteCount).toBe(0);
  });

  it("expires a draining generation in lifecycle lock order while preserving its running source",async()=>{
    const seeded=await seedDrainingGenerationTransition();
    const request=(await pool.query(`UPDATE workspace_checkpoint_requests SET state='queued',checkpoint_id=NULL,completed_at=NULL,
      created_at=now()-interval '10 minutes',deadline_at=now()-interval '1 second' WHERE lifecycle_intent_id=$1 RETURNING id`,[seeded.drainIntentId])).rows[0];
    await assertDatabaseLockOrder(pool,{
      parentSql:"SELECT id FROM cloud_workspace_generation_transitions WHERE id=$1 FOR UPDATE",parentId:seeded.transitionId,
      childSql:"SELECT id FROM workspace_checkpoint_requests WHERE id=$1 FOR UPDATE",childId:request.id,
      parentQuery:/FROM organizations|UPDATE cloud_workspace_generation_transitions/,
      action:controlled=>new CloudWorkspaceCheckpointRequestWorker(controlled).expireOnce(),
    });
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE id=$1",[seeded.transitionId])).rows[0].state).toBe("cancelled");
    expect((await pool.query("SELECT retired_at IS NOT NULL AS retired FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2",[seeded.workspaceId])).rows[0].retired).toBe(true);
    expect((await pool.query("SELECT desired_state,current_generation FROM cloud_workspaces WHERE id=$1",[seeded.workspaceId])).rows[0]).toEqual({desired_state:"running",current_generation:1});
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

  it("does not confirm deletion while an allocation outcome is unknown", async () => {
    const seeded = await seedWorkspace({
      desiredState: "deleted",
      status: "deleting",
      operation: "delete",
    });
    const provider = new FakeProvider();
    provider.verifyAbsence = async () => false;
    await reconciler(provider).runOnce();
    const result = await pool.query(
      `SELECT cw.status, cw.deleted_at, i.state AS intent_state
       FROM cloud_workspaces cw JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(result.rows[0]).toMatchObject({
      status: "deleting",
      deleted_at: null,
    });
    expect(result.rows[0].intent_state).not.toBe("succeeded");
    expect(provider.createCount).toBe(0);
  });

  it("allows delete to bypass an unfinished local-copy upload gate", async () => {
    const seeded = await seedWorkspace({
      desiredState: "deleted",
      status: "deleting",
      operation: "delete",
      providerResourceId: "bound-resource",
      observedState: "running",
    });
    await pool.query(
      `INSERT INTO workspace_fork_intents (
         org_id, requested_by, operation, source_local_workspace_id,
         target_cloud_workspace_id, source_revision, idempotency_key,
         request_sha256
       ) VALUES ($1, $2, 'local_to_cloud', $3, $4, 0, $5, $6)`,
      [
        orgId,
        ownerId,
        randomUUID(),
        seeded.workspaceId,
        `fork-${randomUUID()}`,
        createHash("sha256").update("unfinished-fork").digest(),
      ],
    );
    const provider = new FakeProvider();
    provider.resources.set(
      "bound-resource",
      provider.make(
        { workspaceId: seeded.workspaceId, generation: 1 },
        "running",
        "bound-resource",
      ),
    );

    await expect(reconciler(provider).runOnce()).resolves.toBe(true);
    expect(provider.deleteCount).toBe(1);
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
    expect(JSON.stringify(state.rows[0])).not.toContain(
      "secret-provider-detail",
    );

    provider.createFailure = null;
    await pool.query(
      `UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at = now()
       WHERE id = $1`,
      [seeded.intentId],
    );
    await worker.runOnce();
    expect(provider.createCount).toBe(1);
    state = await pool.query(
      `SELECT state, error_code, error_message
       FROM cloud_workspace_lifecycle_intents WHERE id = $1`,
      [seeded.intentId],
    );
    expect(state.rows[0]).toEqual({
      state: "succeeded",
      error_code: null,
      error_message: null,
    });
  });

  it("restores the source generation when candidate provisioning is rejected", async () => {
    const seeded = await seedGenerationTransition();
    const provider = new FakeProvider();
    provider.createFailure = new CloudProviderError(
      "provider_generation_rejected",
      "provider returned private rejection detail",
      false,
    );

    await expect(reconciler(provider).runOnce()).resolves.toBe(true);
    const result = await pool.query(
      `SELECT cw.current_generation, cw.status, cw.last_error_code,
              gt.state AS transition_state, gt.error_code,
              candidate.retired_at IS NOT NULL AS candidate_retired,
              provision.state AS provision_state,
              array_agg(
                jsonb_build_object(
                  'operation', recovery.operation,
                  'generation', recovery.generation,
                  'affectsWorkspace', recovery.affects_workspace,
                  'state', recovery.state
                ) ORDER BY recovery.affects_workspace DESC, recovery.operation
              ) FILTER (WHERE recovery.id IS NOT NULL) AS recovery_intents
       FROM cloud_workspaces cw
       JOIN cloud_workspace_generation_transitions gt
         ON gt.workspace_id = cw.id
       JOIN cloud_workspace_generations candidate
         ON candidate.workspace_id = cw.id AND candidate.generation = 2
       JOIN cloud_workspace_lifecycle_intents provision
         ON provision.id = gt.provision_intent_id
       LEFT JOIN cloud_workspace_lifecycle_intents recovery
         ON recovery.generation_transition_id = gt.id
        AND recovery.id <> gt.provision_intent_id
       WHERE cw.id = $1
       GROUP BY cw.current_generation, cw.status, cw.last_error_code,
                gt.state, gt.error_code, candidate.retired_at,
                provision.state`,
      [seeded.workspaceId],
    );
    expect(result.rows[0]).toEqual({
      current_generation: 1,
      status: "waking",
      last_error_code: null,
      transition_state: "rolling_back",
      error_code: "provider_generation_rejected",
      candidate_retired: true,
      provision_state: "failed",
      recovery_intents: [
        {
          operation: "wake",
          generation: 1,
          affectsWorkspace: true,
          state: "queued",
        },
        {
          operation: "delete",
          generation: 2,
          affectsWorkspace: false,
          state: "queued",
        },
      ],
    });
    expect(JSON.stringify(result.rows[0])).not.toContain("private rejection");
  });

  it("moves an active transition to setup only after the candidate is running", async () => {
    const seeded = await seedGenerationTransition();
    const provider = new FakeProvider();

    await expect(reconciler(provider).runOnce()).resolves.toBe(true);
    const result = await pool.query(
      `SELECT cw.current_generation, cw.status, gt.state AS transition_state,
              i.state AS intent_state, sr.state AS setup_state
       FROM cloud_workspaces cw
       JOIN cloud_workspace_generation_transitions gt
         ON gt.workspace_id = cw.id
       JOIN cloud_workspace_lifecycle_intents i
         ON i.id = gt.provision_intent_id
       JOIN cloud_workspace_setup_runs sr
         ON sr.workspace_id = cw.id AND sr.generation = 2
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(result.rows[0]).toEqual({
      current_generation: 2,
      status: "setting_up",
      transition_state: "setting_up",
      intent_state: "succeeded",
      setup_state: "queued",
    });
  });

  it("drains the source generation before queuing candidate provisioning", async () => {
    const seeded = await seedDrainingGenerationTransition();
    const provider = new FakeProvider();
    provider.resources.set(
      "source-resource",
      provider.make(
        { workspaceId: seeded.workspaceId, generation: 1 },
        "running",
        "source-resource",
      ),
    );
    const worker = reconciler(provider);

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(provider.stopCount).toBe(1);
    expect(provider.createCount).toBe(0);
    const drained = await pool.query(
      `SELECT gt.state, drain.state AS drain_state,
              provision.operation AS provision_operation,
              provision.generation AS provision_generation,
              provision.state AS provision_state
       FROM cloud_workspace_generation_transitions gt
       JOIN cloud_workspace_lifecycle_intents drain
         ON drain.id = gt.drain_intent_id
       JOIN cloud_workspace_lifecycle_intents provision
         ON provision.id = gt.provision_intent_id
       WHERE gt.id = $1`,
      [seeded.transitionId],
    );
    expect(drained.rows[0]).toEqual({
      state: "provisioning",
      drain_state: "succeeded",
      provision_operation: "create",
      provision_generation: 2,
      provision_state: "queued",
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(provider.createCount).toBe(1);
  });
  it.each(['failed','archiving'] as const)("recovers a durable checkpoint after compute stops with provider snapshot %s",async state=>{
    const seeded=await seedDrainingGenerationTransition();
    await pool.query("UPDATE cloud_workspace_generation_transitions SET operation='recover' WHERE id=$1",[seeded.transitionId]);
    await pool.query(`UPDATE cloud_workspace_generations generation SET recovery_checkpoint_id=request.checkpoint_id
      FROM workspace_checkpoint_requests request WHERE generation.workspace_id=$1 AND generation.generation=2 AND request.lifecycle_intent_id=$2`,[seeded.workspaceId,seeded.drainIntentId]);
    const provider=new FakeProvider();const stopped={...provider.make({workspaceId:seeded.workspaceId,generation:1},state,'source-resource'),computeStopped:true};
    provider.resources.set('source-resource',stopped);provider.stop=async()=>{provider.stopCount++;return stopped;};
    await reconciler(provider).runOnce();
    expect(provider.stopCount).toBe(1);
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE id=$1",[seeded.transitionId])).rows[0].state).toBe('provisioning');
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1",[seeded.workspaceId])).rows[0].current_generation).toBe(2);
  });

  it("rolls back without provisioning when the source drain is rejected", async () => {
    const seeded = await seedDrainingGenerationTransition();
    const provider = new FakeProvider();
    provider.resources.set(
      "source-resource",
      provider.make(
        { workspaceId: seeded.workspaceId, generation: 1 },
        "running",
        "source-resource",
      ),
    );
    provider.stopFailure = new CloudProviderError(
      "provider_source_drain_rejected",
      "provider returned private drain detail",
      false,
    );

    await expect(reconciler(provider).runOnce()).resolves.toBe(true);
    expect(provider.stopCount).toBe(1);
    expect(provider.createCount).toBe(0);
    const result = await pool.query(
      `SELECT cw.current_generation, cw.status,
              gt.state AS transition_state, gt.error_code,
              gt.provision_intent_id,
              drain.state AS drain_state,
              candidate.retired_at IS NOT NULL AS candidate_retired,
              array_agg(
                jsonb_build_object(
                  'operation', recovery.operation,
                  'generation', recovery.generation,
                  'affectsWorkspace', recovery.affects_workspace,
                  'state', recovery.state
                ) ORDER BY recovery.affects_workspace DESC, recovery.operation
              ) FILTER (WHERE recovery.id IS NOT NULL) AS recovery_intents
       FROM cloud_workspaces cw
       JOIN cloud_workspace_generation_transitions gt
         ON gt.workspace_id = cw.id
       JOIN cloud_workspace_lifecycle_intents drain
         ON drain.id = gt.drain_intent_id
       JOIN cloud_workspace_generations candidate
         ON candidate.workspace_id = cw.id AND candidate.generation = 2
       LEFT JOIN cloud_workspace_lifecycle_intents recovery
         ON recovery.generation_transition_id = gt.id
        AND recovery.id <> gt.drain_intent_id
       WHERE cw.id = $1
       GROUP BY cw.current_generation, cw.status, gt.state, gt.error_code,
                gt.provision_intent_id, drain.state, candidate.retired_at`,
      [seeded.workspaceId],
    );
    expect(result.rows[0]).toEqual({
      current_generation: 1,
      status: "waking",
      transition_state: "rolling_back",
      error_code: "provider_source_drain_rejected",
      provision_intent_id: null,
      drain_state: "failed",
      candidate_retired: true,
      recovery_intents: [
        {
          operation: "wake",
          generation: 1,
          affectsWorkspace: true,
          state: "queued",
        },
        {
          operation: "delete",
          generation: 2,
          affectsWorkspace: false,
          state: "queued",
        },
      ],
    });
    expect(JSON.stringify(result.rows[0])).not.toContain(
      "private drain detail",
    );
  });

  it.each([
    {
      caseName: "honors a bounded provider retry delay",
      providerDelayMs: 120_000,
      expectedDelayMs: 120_000,
    },
    {
      caseName: "caps an untrusted provider retry delay",
      providerDelayMs: 24 * 60 * 60_000,
      expectedDelayMs: 5 * 60_000,
    },
  ])("$caseName", async ({ providerDelayMs, expectedDelayMs }) => {
    const seeded = await seedWorkspace();
    const provider = new FakeProvider();
    provider.createFailure = new CloudProviderError(
      "provider_rate_limited",
      "rate limited",
      true,
      { retryAfterMs: providerDelayMs },
    );

    expect(await reconciler(provider).runOnce()).toBe(true);
    const result = await pool.query(
      `SELECT state,
              round(extract(epoch FROM (next_attempt_at - updated_at)) * 1000)::integer
                AS retry_delay_ms
       FROM cloud_workspace_lifecycle_intents
       WHERE id = $1`,
      [seeded.intentId],
    );
    expect(result.rows[0]).toEqual({
      state: "observing",
      retry_delay_ms: expectedDelayMs,
    });
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

  it("locks workspace before intent when a lifecycle request races provider completion", async () => {
    const seeded = await seedWorkspace();
    const provider = new FakeProvider();
    provider.createEntered = new Deferred();
    provider.createRelease = new Deferred();
    const run = reconciler(provider).runOnce();
    await provider.createEntered.promise;

    const routeTx = await pool.connect();
    let committed = false;
    try {
      await routeTx.query("BEGIN");
      await routeTx.query("SET LOCAL deadlock_timeout = '100ms'");
      await routeTx.query(
        `SELECT id FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
        [seeded.workspaceId],
      );
      provider.createRelease.resolve();

      let reconcilerWaiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE pid <> pg_backend_pid()
               AND datname = current_database()
               AND wait_event_type = 'Lock'
               AND query LIKE '%FROM cloud_workspaces%FOR UPDATE%'
           ) AS waiting`,
        );
        if (waiting.rows[0]?.waiting) {
          reconcilerWaiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(reconcilerWaiting).toBe(true);

      await routeTx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET updated_at = updated_at WHERE id = $1`,
        [seeded.intentId],
      );
      await routeTx.query("COMMIT");
      committed = true;
      await expect(run).resolves.toBe(true);
    } finally {
      provider.createRelease.resolve();
      if (!committed) await routeTx.query("ROLLBACK").catch(() => {});
      routeTx.release();
      await run.catch(() => {});
    }

    const intent = await pool.query(
      `SELECT state FROM cloud_workspace_lifecycle_intents WHERE id = $1`,
      [seeded.intentId],
    );
    expect(intent.rows[0]).toEqual({ state: "succeeded" });
  });

  it("records an old generation result without overwriting the new generation", async () => {
    const seeded = await seedWorkspace();
    const provider = new FakeProvider();
    provider.createEntered = new Deferred();
    provider.createRelease = new Deferred();
    const worker = reconciler(provider);

    const run = worker.runOnce();
    await provider.createEntered.promise;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) VALUES ($1, 2, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3, $4, $5)`,
        [
          seeded.workspaceId,
          orgId,
          "b".repeat(40),
          ownerId,
          seeded.providerConnectionId,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider
         ) VALUES ($1, 2, $2, 'daytona')`,
        [seeded.workspaceId, orgId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET current_generation = 2, status = 'provisioning',
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [seeded.workspaceId],
      );
    });
    provider.createRelease.resolve();
    await expect(run).resolves.toBe(true);

    const result = await pool.query(
      `SELECT cw.current_generation, cw.status, cw.version,
              i.state AS intent_state,
              (SELECT count(*) FROM cloud_workspace_setup_runs sr
               WHERE sr.workspace_id = cw.id) AS setup_count,
              (SELECT pb.provider_resource_id
               FROM cloud_workspace_provider_bindings pb
               WHERE pb.workspace_id = cw.id AND pb.generation = 1)
                AS old_provider_resource_id
       FROM cloud_workspaces cw
       JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(result.rows[0]).toEqual({
      current_generation: 2,
      status: "provisioning",
      version: "2",
      intent_state: "superseded",
      setup_count: "0",
      old_provider_resource_id: `resource-${seeded.workspaceId}-1`,
    });
  });

  it("never dispatches a reclaimed workspace intent against a newer generation", async () => {
    const seeded = await seedWorkspace();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) VALUES ($1, 2, $2, 'daytona', 'snap-next', 'linux/amd64',
                   2000, 4096, 20480, $3, $4, $5)`,
        [
          seeded.workspaceId,
          orgId,
          "b".repeat(40),
          ownerId,
          seeded.providerConnectionId,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider
         ) VALUES ($1, 2, $2, 'daytona')`,
        [seeded.workspaceId, orgId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET current_generation = 2, status = 'provisioning',
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [seeded.workspaceId],
      );
    });

    const provider = new FakeProvider();
    await expect(reconciler(provider).runOnce()).resolves.toBe(true);
    expect(provider.createCount).toBe(0);
    const result = await pool.query(
      `SELECT state, generation
       FROM cloud_workspace_lifecycle_intents WHERE id = $1`,
      [seeded.intentId],
    );
    expect(result.rows[0]).toEqual({ state: "superseded", generation: 1 });
  });

  it("supersedes an in-flight result when a newer desired state wins", async () => {
    const seeded = await seedWorkspace();
    const provider = new FakeProvider();
    provider.createEntered = new Deferred();
    provider.createRelease = new Deferred();
    const run = reconciler(provider).runOnce();

    await provider.createEntered.promise;
    await withSystemTx(pool, async (tx) => {
      const setupRun = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt, state, started_at,
           claim_count, execution_fence, lease_owner, lease_expires_at,
           last_heartbeat_at
         ) VALUES ($1, 1, $2, 1, 'running', now(), 1, 1,
                   'fixture-worker', now() + interval '5 minutes', now())
         RETURNING id`,
        [seeded.workspaceId, orgId],
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
          seeded.workspaceId,
          orgId,
          ownerId,
          createHash("sha256").update(randomUUID()).digest(),
          setupRun.rows[0]!.id,
        ],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET desired_state = 'deleted', status = 'deleting',
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [seeded.workspaceId],
      );
    });
    provider.createRelease.resolve();
    await expect(run).resolves.toBe(true);

    const result = await pool.query(
      `SELECT cw.status, cw.desired_state, i.state AS intent_state,
              (SELECT state FROM cloud_workspace_setup_runs sr
               WHERE sr.workspace_id = cw.id AND sr.generation = 1)
                AS setup_state,
              (SELECT bool_and(eg.revoked_at IS NOT NULL)
               FROM cloud_workspace_endpoint_grants eg
               WHERE eg.workspace_id = cw.id AND eg.generation = 1)
                AS grants_revoked
       FROM cloud_workspaces cw
       JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(result.rows[0]).toEqual({
      status: "deleting",
      desired_state: "deleted",
      intent_state: "superseded",
      setup_state: "cancelled",
      grants_revoked: true,
    });
  });

  it("supersedes an in-flight failure when a newer desired state wins", async () => {
    const seeded = await seedWorkspace();
    const provider = new FakeProvider();
    provider.createEntered = new Deferred();
    provider.createRelease = new Deferred();
    provider.createFailure = new CloudProviderError(
      "provider_invalid_request",
      "old generation failure",
      false,
    );
    const run = reconciler(provider).runOnce();

    await provider.createEntered.promise;
    await withSystemTx(pool, async (tx) => {
      const setupRun = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt, state, started_at,
           claim_count, execution_fence, lease_owner, lease_expires_at,
           last_heartbeat_at
         ) VALUES ($1, 1, $2, 1, 'running', now(), 1, 1,
                   'fixture-worker', now() + interval '5 minutes', now())
         RETURNING id`,
        [seeded.workspaceId, orgId],
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
          seeded.workspaceId,
          orgId,
          ownerId,
          createHash("sha256").update(randomUUID()).digest(),
          setupRun.rows[0]!.id,
        ],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET desired_state = 'deleted', status = 'deleting',
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [seeded.workspaceId],
      );
    });
    provider.createRelease.resolve();
    await expect(run).resolves.toBe(true);

    const result = await pool.query(
      `SELECT cw.status, cw.desired_state, cw.last_error_code,
              cw.last_error_message, i.state AS intent_state,
              i.error_code AS intent_error_code,
              i.error_message AS intent_error_message,
              (SELECT state FROM cloud_workspace_setup_runs sr
               WHERE sr.workspace_id = cw.id AND sr.generation = 1)
                AS setup_state,
              (SELECT bool_and(eg.revoked_at IS NOT NULL)
               FROM cloud_workspace_endpoint_grants eg
               WHERE eg.workspace_id = cw.id AND eg.generation = 1)
                AS grants_revoked
       FROM cloud_workspaces cw
       JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(result.rows[0]).toEqual({
      status: "deleting",
      desired_state: "deleted",
      last_error_code: null,
      last_error_message: null,
      intent_state: "superseded",
      intent_error_code: null,
      intent_error_message: null,
      setup_state: "cancelled",
      grants_revoked: true,
    });
  });

  it("queues a fresh setup verification after waking a configured generation", async () => {
    const seeded = await seedWorkspace({
      desiredState: "running",
      status: "waking",
      operation: "wake",
      providerResourceId: "bound-resource",
      observedState: "stopped",
    });
    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt, state,
           started_at, completed_at
         ) VALUES ($1, 1, $2, 1, 'succeeded', now(), now())`,
        [seeded.workspaceId, orgId],
      ),
    );
    const provider = new FakeProvider();
    provider.resources.set(
      "bound-resource",
      provider.make(
        { workspaceId: seeded.workspaceId, generation: 1 },
        "stopped",
        "bound-resource",
      ),
    );

    expect(await reconciler(provider).runOnce()).toBe(true);
    const result = await pool.query(
      `SELECT attempt, state
       FROM cloud_workspace_setup_runs
       WHERE workspace_id = $1
       ORDER BY attempt`,
      [seeded.workspaceId],
    );
    expect(result.rows).toEqual([
      { attempt: 1, state: "succeeded" },
      { attempt: 2, state: "queued" },
    ]);
  });

  it("repairs a missing setup run after observing a healthy provisioned resource", async () => {
    const seeded = await seedWorkspace({
      status: "provisioning",
      intentState: "succeeded",
      providerResourceId: "bound-resource",
      observedState: "provisioning",
    });
    const provider = new FakeProvider();
    provider.resources.set(
      "bound-resource",
      provider.make(
        { workspaceId: seeded.workspaceId, generation: 1 },
        "running",
        "bound-resource",
      ),
    );

    expect(await reconciler(provider).reconcileDriftOnce()).toBe(true);
    const result = await pool.query(
      `SELECT cw.status, sr.attempt, sr.state AS setup_state
       FROM cloud_workspaces cw
       LEFT JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(result.rows[0]).toEqual({
      status: "setting_up",
      attempt: 1,
      setup_state: "queued",
    });
  });

  it.each(["ready", "busy"])(
    "preserves %s while refreshing a healthy provider observation",
    async (status) => {
      const seeded = await seedWorkspace({
        status,
        intentState: "succeeded",
        providerResourceId: "bound-resource",
        observedState: "running",
      });
      const provider = new FakeProvider();
      provider.resources.set(
        "bound-resource",
        provider.make(
          { workspaceId: seeded.workspaceId, generation: 1 },
          "running",
          "bound-resource",
        ),
      );

      expect(await reconciler(provider).reconcileDriftOnce()).toBe(true);
      const result = await pool.query(
        `SELECT cw.status, pb.observed_state,
                (SELECT count(*) FROM cloud_workspace_setup_runs sr
                 WHERE sr.workspace_id = cw.id) AS setup_count
         FROM cloud_workspaces cw
         JOIN cloud_workspace_provider_bindings pb
           ON pb.workspace_id = cw.id AND pb.generation = cw.current_generation
         WHERE cw.id = $1`,
        [seeded.workspaceId],
      );
      expect(result.rows[0]).toEqual({
        status,
        observed_state: "running",
        setup_count: "0",
      });
    },
  );

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
      provider.make(
        { workspaceId: seeded.workspaceId, generation: 1 },
        "stopped",
        "bound-resource",
      ),
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
  it("reconciles customer-provider drift independently of the managed default", async () => {
    const seeded = await seedWorkspace({ status: "ready", intentState: "succeeded", providerResourceId: "customer-resource", observedState: "running" });
    const customer = new FakeProvider();
    customer.resources.set("customer-resource", customer.make({ workspaceId: seeded.workspaceId, generation: 1 }, "stopped", "customer-resource"));
    const managed = new FakeProvider();
    Object.defineProperty(managed, "name", { value: "boat" });
    const worker = new CloudWorkspaceReconciler({ pool, provider: managed, intervalMs: 1000,
      providerResolver: { resolve: async (input: { workspaceId: string; organizationId: string; generation: number }) => {
        expect(input).toMatchObject({ workspaceId: seeded.workspaceId, organizationId: orgId, generation: 1 });
        return { provider: customer };
      } } as unknown as import("./provider-resolver.js").CloudWorkspaceProviderResolver,
    });
    expect(await worker.reconcileDriftOnce()).toBe(true);
    expect((await pool.query("SELECT operation FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND state='queued'", [seeded.workspaceId])).rows).toEqual([{ operation: "wake" }]);
    expect(managed.startCount).toBe(0);
    expect(managed.createCount).toBe(0);
  });
  it("does not let an unavailable provider observation starve another workspace", async () => {
    const unavailable = await seedWorkspace({ status: "ready", intentState: "succeeded", providerResourceId: "unavailable-resource", observedState: "running" });
    await pool.query("UPDATE provider_connections SET display_name='Unavailable fixture provider' WHERE id=$1", [unavailable.providerConnectionId]);
    const healthy = await seedWorkspace({ status: "ready", intentState: "succeeded", providerResourceId: "healthy-resource", observedState: "running" });
    await pool.query("UPDATE cloud_workspace_provider_bindings SET last_observed_at=now()-interval '2 hours' WHERE workspace_id=$1", [unavailable.workspaceId]);
    const provider = new FakeProvider();
    const observations: string[] = [];
    provider.inspect = async (id) => {
      observations.push(id);
      if (id === "unavailable-resource") throw new CloudProviderError("provider_unavailable", "unavailable", true);
      return provider.make({ workspaceId: healthy.workspaceId, generation: 1 }, "running", id);
    };
    const worker = reconciler(provider);
    expect(await worker.reconcileDriftOnce()).toBe(true);
    expect(await worker.reconcileDriftOnce()).toBe(true);
    expect(observations).toEqual(["unavailable-resource", "healthy-resource"]);
    expect((await pool.query("SELECT last_observed_at<now()-interval '1 hour' AS unchanged FROM cloud_workspace_provider_bindings WHERE workspace_id=$1", [unavailable.workspaceId])).rows[0].unchanged).toBe(true);
  });
  it("latches a paused VM for explicit cold-stop instead of repeatedly queuing wake",async()=>{
    const seeded=await seedWorkspace({status:"ready",intentState:"succeeded",operation:"create",providerResourceId:"paused-vm",observedState:"running"});
    const provider=new FakeProvider();provider.resources.set("paused-vm",provider.make({workspaceId:seeded.workspaceId,generation:1},"paused","paused-vm"));
    const worker=reconciler(provider);await worker.reconcileDriftOnce();
    const first=(await pool.query("SELECT status,last_error_code,version FROM cloud_workspaces WHERE id=$1",[seeded.workspaceId])).rows[0];
    expect(first).toMatchObject({status:"failed",last_error_code:"provider_paused_requires_stop"});
    await pool.query("UPDATE cloud_workspace_provider_bindings SET last_observed_at=NULL,next_drift_check_at=now() WHERE workspace_id=$1",[seeded.workspaceId]);
    await worker.reconcileDriftOnce();
    expect((await pool.query("SELECT version FROM cloud_workspaces WHERE id=$1",[seeded.workspaceId])).rows[0].version).toBe(first.version);
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='wake'",[seeded.workspaceId])).rows[0].count).toBe(0);
    expect(provider.startCount).toBe(0);
  });
  it("does not repeatedly queue Stop after confirmed compute shutdown with a failed snapshot",async()=>{
    const seeded=await seedWorkspace({status:'stopped',desiredState:'stopped',intentState:'succeeded',operation:'stop',providerResourceId:'bound-resource',observedState:'archived'});
    const provider=new FakeProvider();provider.resources.set('bound-resource',{...provider.make({workspaceId:seeded.workspaceId,generation:1},'failed','bound-resource'),computeStopped:true});
    const worker=reconciler(provider);await worker.reconcileDriftOnce();
    const first=(await pool.query("SELECT status,last_error_code,version FROM cloud_workspaces WHERE id=$1",[seeded.workspaceId])).rows[0];
    expect(first).toMatchObject({status:'failed',last_error_code:'provider_snapshot_failed'});
    await pool.query("UPDATE cloud_workspace_provider_bindings SET last_observed_at=NULL,next_drift_check_at=now() WHERE workspace_id=$1",[seeded.workspaceId]);
    await worker.reconcileDriftOnce();
    expect((await pool.query("SELECT version FROM cloud_workspaces WHERE id=$1",[seeded.workspaceId])).rows[0].version).toBe(first.version);
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND state IN ('queued','observing')",[seeded.workspaceId])).rows[0].count).toBe(0);
  });

  it("reconciles the current generation while a retired generation awaits provider deletion",async()=>{
    const seeded=await seedWorkspace({status:'ready',intentState:'succeeded',providerResourceId:'bound-resource',observedState:'running'});
    await pool.query(`INSERT INTO cloud_workspace_generations(workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,
      provider_connection_id,provider_connection_version)
      SELECT workspace_id,2,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,
        provider_connection_id,provider_connection_version
      FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`,[seeded.workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,state,affects_workspace,next_attempt_at)
      VALUES($1,$2,2,$3,'delete',$4,$5,'observing',false,now()+interval '1 hour')`,[randomUUID(),seeded.workspaceId,orgId,randomUUID(),randomBytes(32)]);
    const provider=new FakeProvider();provider.resources.set('bound-resource',provider.make({workspaceId:seeded.workspaceId,generation:1},'stopped','bound-resource'));
    expect(await reconciler(provider).reconcileDriftOnce()).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND generation=1 AND operation='wake' AND state='queued'",[seeded.workspaceId])).rows[0].count).toBe(1);
    expect(provider.deleteCount).toBe(0);
  });

  it.each(["stop", "delete"])("requires absence proof for retired-generation %s while the current workspace keeps running", async operation => {
    const seeded = await seedWorkspace({status:"ready",intentState:"succeeded",providerResourceId:"current-resource",observedState:"running"});
    await pool.query(`INSERT INTO cloud_workspace_generations(workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,
      provider_connection_id,provider_connection_version,retired_at)
      SELECT workspace_id,2,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,
        provider_connection_id,provider_connection_version,now()
      FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`, [seeded.workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_provider_bindings(workspace_id,generation,org_id,provider)
      VALUES($1,2,$2,'daytona')`, [seeded.workspaceId,orgId]);
    const cleanupId = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,affects_workspace)
      VALUES($1,$2,2,$3,$4,$5,$6,false)`, [cleanupId,seeded.workspaceId,orgId,operation,randomUUID(),randomBytes(32)]);
    const provider = new FakeProvider();
    provider.verifyAbsence = vi.fn(async () => false);
    const worker = reconciler(provider);
    await worker.runOnce();
    expect(provider.verifyAbsence).toHaveBeenCalledWith(expect.objectContaining({workspaceId:seeded.workspaceId,generation:2}));
    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_lifecycle_intents WHERE id=$1", [cleanupId])).rows[0])
      .toEqual({state:"observing",error_code:"provider_absence_unconfirmed"});
    expect((await pool.query("SELECT deletion_verified_at FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=2", [seeded.workspaceId])).rows[0].deletion_verified_at).toBeNull();
    expect((await pool.query("SELECT current_generation,desired_state,status FROM cloud_workspaces WHERE id=$1", [seeded.workspaceId])).rows[0])
      .toEqual({current_generation:1,desired_state:"running",status:"ready"});
  });

  it.each(["drift", "wake"])("requires a fresh recovery generation after confirmed allocation loss during %s", async trigger => {
    const seeded = await seedWorkspace({ status: trigger === "drift" ? "ready" : "waking", intentState: trigger === "drift" ? "succeeded" : "queued",
      operation: trigger === "drift" ? "create" : "wake", providerResourceId: "lost-resource", observedState: "running" });
    const provider = new FakeProvider(); provider.verifyAbsence = async () => true;
    const worker = reconciler(provider);
    if (trigger === "drift") await worker.reconcileDriftOnce(); else await worker.runOnce();
    expect(provider.createCount).toBe(0);
    expect((await pool.query("SELECT status,last_error_code,current_generation FROM cloud_workspaces WHERE id=$1", [seeded.workspaceId])).rows).toEqual([
      { status: "failed", last_error_code: "provider_resource_lost", current_generation: 1 },
    ]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND state IN ('queued','dispatching','observing')", [seeded.workspaceId])).rows).toEqual([{ count: 0 }]);
  });

  it("does not infer allocation loss from an unconfirmed provider 404", async () => {
    const seeded = await seedWorkspace({ status: "ready", intentState: "succeeded", providerResourceId: "unconfirmed-resource", observedState: "running" });
    const provider = new FakeProvider(); provider.verifyAbsence = async () => false;
    await reconciler(provider).reconcileDriftOnce();
    expect(provider.createCount).toBe(0);
    expect((await pool.query("SELECT status,last_error_code FROM cloud_workspaces WHERE id=$1", [seeded.workspaceId])).rows).toEqual([{ status: "ready", last_error_code: null }]);
  });

  it("records confirmed allocation loss once across repeated drift observations", async () => {
    const seeded = await seedWorkspace({ status: "ready", intentState: "succeeded", providerResourceId: "lost-resource", observedState: "running" });
    const provider = new FakeProvider();
    provider.verifyAbsence = async () => true;
    const worker = reconciler(provider);
    await worker.reconcileDriftOnce();
    const before = await pool.query("SELECT version FROM cloud_workspaces WHERE id = $1", [seeded.workspaceId]);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET last_observed_at = NULL,next_drift_check_at=now() WHERE workspace_id = $1", [seeded.workspaceId]);
    expect(await worker.reconcileDriftOnce()).toBe(true);
    expect((await pool.query("SELECT version FROM cloud_workspaces WHERE id = $1", [seeded.workspaceId])).rows).toEqual(before.rows);
    expect((await pool.query("SELECT count(*)::integer AS count FROM audit_log WHERE org_id = $1 AND action = 'cloud_workspace.allocation_lost' AND subject->>'workspaceId' = $2", [orgId, seeded.workspaceId])).rows).toEqual([{ count: 1 }]);
    expect(provider.createCount).toBe(0);
  });

  it("cancels stale setup on provider stop so wake queues a fresh attempt", async () => {
    const seeded = await seedWorkspace({
      status: "setting_up",
      intentState: "succeeded",
      providerResourceId: "bound-resource",
      observedState: "running",
    });
    await withSystemTx(pool, async (tx) => {
      const setupRun = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt, state, started_at,
           claim_count, execution_fence, lease_owner, lease_expires_at,
           last_heartbeat_at
         ) VALUES ($1, 1, $2, 1, 'running', now(), 1, 1,
                   'fixture-worker', now() + interval '5 minutes', now())
         RETURNING id`,
        [seeded.workspaceId, orgId],
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
          seeded.workspaceId,
          orgId,
          ownerId,
          createHash("sha256").update(randomUUID()).digest(),
          setupRun.rows[0]!.id,
        ],
      );
    });
    const provider = new FakeProvider();
    provider.resources.set(
      "bound-resource",
      provider.make(
        { workspaceId: seeded.workspaceId, generation: 1 },
        "stopped",
        "bound-resource",
      ),
    );
    const worker = reconciler(provider);

    expect(await worker.reconcileDriftOnce()).toBe(true);
    let setup = await pool.query(
      `SELECT sr.attempt, sr.state,
              sr.completed_at IS NOT NULL AS completed,
              (SELECT bool_and(eg.revoked_at IS NOT NULL)
               FROM cloud_workspace_endpoint_grants eg
               WHERE eg.workspace_id = sr.workspace_id) AS grants_revoked
       FROM cloud_workspace_setup_runs sr
       WHERE sr.workspace_id = $1 ORDER BY sr.attempt`,
      [seeded.workspaceId],
    );
    expect(setup.rows).toEqual([
      {
        attempt: 1,
        state: "cancelled",
        completed: true,
        grants_revoked: true,
      },
    ]);

    expect(await worker.runOnce()).toBe(true);
    setup = await pool.query(
      `SELECT sr.attempt, sr.state,
              sr.completed_at IS NOT NULL AS completed
       FROM cloud_workspace_setup_runs sr
       WHERE sr.workspace_id = $1 ORDER BY sr.attempt`,
      [seeded.workspaceId],
    );
    expect(setup.rows).toEqual([
      { attempt: 1, state: "cancelled", completed: true },
      { attempt: 2, state: "queued", completed: false },
    ]);
  });

  it("does not dispatch a stale create after delete wins, but still discovers and deletes an unknown result", async () => {
    const seeded = await seedWorkspace({
      desiredState: "deleted",
      status: "deleting",
    });
    const provider = new FakeProvider();
    const unknown = provider.make({
      workspaceId: seeded.workspaceId,
      generation: 1,
    });
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

  it.each(["organization", "team"] as const)(
    "durably deletes provider resources when the owning %s is soft-deleted",
    async (scope) => {
      const seeded = await seedWorkspace({
        status: "ready",
        intentState: "succeeded",
        providerResourceId: "bound-resource",
        observedState: "running",
      });
      const provider = new FakeProvider();
      provider.resources.set(
        "bound-resource",
        provider.make(
          { workspaceId: seeded.workspaceId, generation: 1 },
          "running",
          "bound-resource",
        ),
      );

      await pool.query(
        scope === "organization"
          ? `UPDATE organizations SET deleted_at = now() WHERE id = $1`
          : `UPDATE teams SET deleted_at = now() WHERE id = $1`,
        [scope === "organization" ? orgId : teamId],
      );

      let persisted = await pool.query(
        `SELECT cw.desired_state, cw.status,
                cw.deleted_at IS NOT NULL AS deleted,
                i.operation, i.state AS intent_state, i.generation,
                i.affects_workspace
         FROM cloud_workspaces cw
         JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
         WHERE cw.id = $1 AND i.id <> $2
         ORDER BY i.created_at, i.id`,
        [seeded.workspaceId, seeded.intentId],
      );
      expect(persisted.rows).toEqual([
        {
          desired_state: "deleted",
          status: "deleting",
          deleted: false,
          operation: "delete",
          intent_state: "queued",
          generation: 1,
          affects_workspace: true,
        },
      ]);

      expect(await reconciler(provider).runOnce()).toBe(true);
      expect(provider.deleteCount).toBe(1);
      persisted = await pool.query(
        `SELECT status, desired_state, deleted_at IS NOT NULL AS deleted
         FROM cloud_workspaces WHERE id = $1`,
        [seeded.workspaceId],
      );
      expect(persisted.rows[0]).toEqual({
        status: "deleted",
        desired_state: "deleted",
        deleted: true,
      });
    },
  );

  it("retires every provider generation and cancels replacement work when an organization is deleted", async () => {
    const seeded = await seedGenerationTransition();
    const provider = new FakeProvider();
    provider.resources.set(
      "source-resource",
      provider.make(
        { workspaceId: seeded.workspaceId, generation: 1 },
        "running",
        "source-resource",
      ),
    );
    provider.resources.set(
      "candidate-resource",
      provider.make(
        { workspaceId: seeded.workspaceId, generation: 2 },
        "running",
        "candidate-resource",
      ),
    );

    await pool.query(
      `UPDATE organizations SET deleted_at = now() WHERE id = $1`,
      [orgId],
    );

    const transition = await pool.query(
      `SELECT state, completed_at IS NOT NULL AS completed,
              error_code
       FROM cloud_workspace_generation_transitions WHERE id = $1`,
      [seeded.transitionId],
    );
    expect(transition.rows[0]).toEqual({
      state: "cancelled",
      completed: true,
      error_code: "organization_deleted",
    });
    const intents = await pool.query(
      `SELECT generation, operation, state, affects_workspace
       FROM cloud_workspace_lifecycle_intents
       WHERE workspace_id = $1
       ORDER BY generation, operation, created_at, id`,
      [seeded.workspaceId],
    );
    expect(intents.rows).toEqual([
      {
        generation: 1,
        operation: "create",
        state: "succeeded",
        affects_workspace: true,
      },
      {
        generation: 1,
        operation: "delete",
        state: "queued",
        affects_workspace: false,
      },
      {
        generation: 2,
        operation: "create",
        state: "superseded",
        affects_workspace: true,
      },
      {
        generation: 2,
        operation: "delete",
        state: "queued",
        affects_workspace: true,
      },
    ]);

    const worker = reconciler(provider);
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect(provider.deleteCount).toBe(2);
    expect(provider.resources.size).toBe(0);
    const workspace = await pool.query(
      `SELECT status, desired_state, deleted_at IS NOT NULL AS deleted
       FROM cloud_workspaces WHERE id = $1`,
      [seeded.workspaceId],
    );
    expect(workspace.rows[0]).toEqual({
      status: "deleted",
      desired_state: "deleted",
      deleted: true,
    });
  });

  it("durably deletes paid compute when the temporary workspace owner account is deleted", async () => {
    const seeded = await seedWorkspace({
      status: "ready",
      intentState: "succeeded",
      providerResourceId: "owner-resource",
      observedState: "running",
    });
    const provider = new FakeProvider();
    provider.resources.set(
      "owner-resource",
      provider.make(
        { workspaceId: seeded.workspaceId, generation: 1 },
        "running",
        "owner-resource",
      ),
    );

    await pool.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [
      ownerId,
    ]);

    const queued = await pool.query(
      `SELECT cw.status, cw.desired_state, i.operation, i.state
       FROM cloud_workspaces cw
       JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
       WHERE cw.id = $1 AND i.id <> $2`,
      [seeded.workspaceId, seeded.intentId],
    );
    expect(queued.rows).toEqual([
      {
        status: "deleting",
        desired_state: "deleted",
        operation: "delete",
        state: "queued",
      },
    ]);

    expect(await reconciler(provider).runOnce()).toBe(true);
    expect(provider.deleteCount).toBe(1);
    const workspace = await pool.query(
      `SELECT status, desired_state, deleted_at IS NOT NULL AS deleted
       FROM cloud_workspaces WHERE id = $1`,
      [seeded.workspaceId],
    );
    expect(workspace.rows[0]).toEqual({
      status: "deleted",
      desired_state: "deleted",
      deleted: true,
    });
  });

  it("does not complete delete until a post-dispatch inspection proves absence", async () => {
    const seeded = await seedWorkspace({
      desiredState: "deleted",
      status: "deleting",
      operation: "delete",
      providerResourceId: "bound-resource",
      observedState: "running",
    });
    const provider = new FakeProvider();
    provider.deleteObservedState = "deleting";
    provider.resources.set(
      "bound-resource",
      provider.make(
        { workspaceId: seeded.workspaceId, generation: 1 },
        "running",
        "bound-resource",
      ),
    );
    const worker = reconciler(provider);

    expect(await worker.runOnce()).toBe(true);
    let result = await pool.query(
      `SELECT cw.status, cw.deleted_at IS NOT NULL AS deleted,
              i.state AS intent_state, pb.observed_state,
              pb.deletion_verified_at IS NOT NULL AS deletion_verified
       FROM cloud_workspaces cw
       JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
       JOIN cloud_workspace_provider_bindings pb
         ON pb.workspace_id = cw.id AND pb.generation = cw.current_generation
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(result.rows[0]).toEqual({
      status: "deleting",
      deleted: false,
      intent_state: "observing",
      observed_state: "deleting",
      deletion_verified: false,
    });

    provider.resources.delete("bound-resource");
    await pool.query(
      `UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at = now()
       WHERE id = $1`,
      [seeded.intentId],
    );
    expect(await worker.runOnce()).toBe(true);
    result = await pool.query(
      `SELECT cw.status, cw.deleted_at IS NOT NULL AS deleted,
              i.state AS intent_state, pb.observed_state,
              pb.deletion_verified_at IS NOT NULL AS deletion_verified
       FROM cloud_workspaces cw
       JOIN cloud_workspace_lifecycle_intents i ON i.workspace_id = cw.id
       JOIN cloud_workspace_provider_bindings pb
         ON pb.workspace_id = cw.id AND pb.generation = cw.current_generation
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(result.rows[0]).toEqual({
      status: "deleted",
      deleted: true,
      intent_state: "succeeded",
      observed_state: "deleted",
      deletion_verified: true,
    });
    expect(provider.deleteCount).toBe(1);
  });

  it.each(["running", "stopped"] as const)(
    "publishes client-access revocation only after provider stop succeeds from %s",
    async (providerState) => {
      const seeded = await seedWorkspace({
        desiredState: "stopped",
        status: "stopping",
        operation: "stop",
        providerResourceId: "bound-resource",
        observedState: "running",
      });
      const grantId = randomUUID();
      await withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO cloud_workspace_client_access_grants (
           id, workspace_id, generation, org_id, account_user_id, kind,
           provider_resource_id, token_hash, idempotency_key, request_sha256,
           state, requested_expires_at, expires_at, issued_at,
           revocation_reason
         ) VALUES ($1, $2, 1, $3, $4, 'ssh', 'bound-resource', $5, $6, $7,
                   'revocation_pending', now() + interval '15 minutes',
                   now() + interval '15 minutes', now(),
                   'workspace_stop_requested')`,
          [
            grantId,
            seeded.workspaceId,
            orgId,
            ownerId,
            createHash("sha256").update(randomUUID()).digest(),
            randomUUID(),
            createHash("sha256").update(randomUUID()).digest(),
          ],
        ),
      );
      const provider = new FakeProvider();
      provider.resources.set(
        "bound-resource",
        provider.make(
          { workspaceId: seeded.workspaceId, generation: 1 },
          providerState,
          "bound-resource",
        ),
      );

      await expect(reconciler(provider).runOnce()).resolves.toBe(true);
      expect(provider.stopCount).toBe(1);
      const result = await withSystemTx(pool, (tx) =>
        tx.query<{ state: string; revoked: boolean }>(
          `SELECT state, revoked_at IS NOT NULL AS revoked
         FROM cloud_workspace_client_access_grants WHERE id = $1`,
          [grantId],
        ),
      );
      expect(result.rows[0]).toEqual({ state: "revoked", revoked: true });
    },
  );

  it("never adopts or deletes label-only resources, even after repeated aged observations", async () => {
    const seeded = await seedWorkspace({ intentState: "succeeded" });
    const provider = new FakeProvider();
    provider.durableOwnership = false;
    for (const workspaceId of [seeded.workspaceId, randomUUID()]) {
      const resource = provider.make({ workspaceId, generation: 1 });
      provider.resources.set(resource.resourceId, resource);
    }
    const worker = reconciler(provider, { orphanGraceMs: 60_000 });
    await worker.reconcileOrphansOnce();
    await pool.query("UPDATE cloud_workspace_provider_orphans SET first_seen_at = now() - interval '2 minutes'");
    await worker.reconcileOrphansOnce();
    expect(provider.deleteCount).toBe(0);
    const binding = await pool.query("SELECT provider_resource_id FROM cloud_workspace_provider_bindings WHERE workspace_id = $1", [seeded.workspaceId]);
    expect(binding.rows[0].provider_resource_id).toBeNull();
  });

  it("recognizes a live binding globally even when another credential scope inventories it", async () => {
    const seeded = await seedWorkspace({ providerResourceId: "shared-resource", intentState: "succeeded" });
    const provider = new FakeProvider();
    provider.resources.set("shared-resource", provider.make({ workspaceId: seeded.workspaceId, generation: 1 }, "running", "shared-resource"));
    const scopes = await withSystemTx(pool, async (tx) => {
      const otherOrg = (await tx.query<{ id: string }>(`INSERT INTO organizations
        (slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES ($1,'Other Org',$2,false,true) RETURNING id`,
        [`other-${randomUUID()}`, ownerId])).rows[0]!.id;
      const result = [];
      for (const organizationId of [orgId, otherOrg]) {
        const connectionId = randomUUID();
        await tx.query(`INSERT INTO provider_connections
          (id,org_id,owner_kind,provider,display_name,credential_source,current_version,state)
          VALUES ($1,$2,'organization','daytona','Shared delegated account','delegated',2,'active')`, [connectionId,organizationId]);
        for (const version of [1,2]) {
          await tx.query(`INSERT INTO provider_connection_versions
            (connection_id,org_id,version,credential_source,endpoint,key_version,nonce,ciphertext,auth_tag,credential_sha256,created_by)
            VALUES ($1,$2,$3,'delegated','https://app.daytona.io/api',1,$4,$5,$6,$7,$8)`,
            [connectionId,organizationId,version,randomBytes(12),randomBytes(32),randomBytes(16),randomBytes(32),ownerId]);
          result.push({provider,organizationId,connectionId,connectionVersion:version,credentialSource:'delegated' as const});
        }
      }
      return result;
    });
    const warn = vi.fn();
    const worker = reconciler(provider, {
      orphanGraceMs: 60_000,
      logger: { info() {}, warn, error() {} },
      providerResolver: {
        cleanupScopes: async () => ({ unavailable: 0, scopes }),
      },
    });
    await worker.reconcileOrphansOnce();
    await pool.query("UPDATE cloud_workspace_provider_orphans SET first_seen_at = now() - interval '2 minutes'");
    await worker.reconcileOrphansOnce();
    expect(provider.deleteCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect((await pool.query("SELECT * FROM cloud_workspace_provider_orphans")).rowCount).toBe(0);
  });

  it("isolates failed inventories and rotates scope priority at the safety ceiling", async () => {
    const failed = new FakeProvider();
    failed.listManaged = async function* () { throw new CloudProviderError("provider_authorization_failed", "private key", false); };
    const providers = [failed, new FakeProvider(), new FakeProvider()];
    for (const provider of providers.slice(1)) {
      provider.durableOwnership = false;
      const resource = provider.make({ workspaceId: randomUUID(), generation: 1 });
      provider.resources.set(resource.resourceId, resource);
    }
    const worker = reconciler(providers[1]!, {
      maxManagedResourcesPerSweep: 1,
      providerResolver: {
        cleanupScopes: async () => ({ unavailable: 0, scopes: providers.map((provider) => ({
          provider, organizationId: null, connectionId: null, connectionVersion: null, credentialSource: "hosted",
        })) }),
      },
    });
    for (let i = 0; i < 3; i++) await expect(worker.reconcileOrphansOnce()).resolves.toBe(1);
    expect((await pool.query("SELECT * FROM cloud_workspace_provider_orphans")).rowCount).toBe(2);
    expect(providers.every((provider) => provider.deleteCount === 0)).toBe(true);
  });

  it("recovers an unbound known generation and deletes only twice-observed aged true orphans", async () => {
    const seeded = await seedWorkspace({ intentState: "succeeded" });
    const provider = new FakeProvider();
    const recovered = provider.make({
      workspaceId: seeded.workspaceId,
      generation: 1,
    });
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
    expect(binding.rows[0]).toEqual({
      provider_resource_id: recovered.resourceId,
    });

    const orphanWorkspace = randomUUID();
    const orphan = provider.make({
      workspaceId: orphanWorkspace,
      generation: 1,
    });
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

  it("does not mark asynchronous orphan deletion verified until inspection proves it", async () => {
    const provider = new FakeProvider();
    provider.deleteObservedState = "deleting";
    const orphan = provider.make({
      workspaceId: randomUUID(),
      generation: 1,
    });
    provider.resources.set(orphan.resourceId, orphan);
    const worker = reconciler(provider, { orphanGraceMs: 60_000 });

    await worker.reconcileOrphansOnce();
    await pool.query(
      `UPDATE cloud_workspace_provider_orphans
       SET first_seen_at = now() - interval '2 minutes'
       WHERE provider_resource_id = $1`,
      [orphan.resourceId],
    );
    await worker.reconcileOrphansOnce();

    let record = await pool.query(
      `SELECT deletion_verified_at IS NOT NULL AS verified
       FROM cloud_workspace_provider_orphans
       WHERE provider_resource_id = $1`,
      [orphan.resourceId],
    );
    expect(provider.deleteCount).toBe(1);
    expect(provider.resources.get(orphan.resourceId)?.state).toBe("deleting");
    expect(record.rows[0]).toEqual({ verified: false });

    provider.deleteObservedState = null;
    await worker.reconcileOrphansOnce();
    record = await pool.query(
      `SELECT deletion_verified_at IS NOT NULL AS verified
       FROM cloud_workspace_provider_orphans
       WHERE provider_resource_id = $1`,
      [orphan.resourceId],
    );
    expect(provider.deleteCount).toBe(2);
    expect(provider.resources.has(orphan.resourceId)).toBe(false);
    expect(record.rows[0]).toEqual({ verified: true });
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

import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { requireCloudRecoveryPoint } from "./automatic-recovery.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { copyGenerationPins, loadGenerationSource } from "./generation-pins.js";
import { seedComputerTemplate } from "./computer-workspace-test-fixtures.js";
import { rollbackCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { DatabaseCloudIdleStop } from "./idle-stop.js";
import { DatabaseCloudWorkspaceManagementService } from "./management.js";
import { DatabaseCloudWorkspaceBlobService } from "./object-store.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { CloudProviderError, type CloudProviderResource, type CloudWorkspaceProvider } from "./provider.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { cloudRuntimePinValues } from "./runtime-selection.js";
import { runtimeBase, runtimeWitness, seedRuntimeBundle, seedRuntimeBase } from "./runtime-test-fixtures.js";
import { CloudWorkspaceSetupError, CloudWorkspaceSetupWorker } from "./setup-worker.js";
import { seedCanonicalCloudWorkspaceAuthority, seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

const config = { provider: "boat", imageRef: "zeros-v2-test-current-legacy-image", sourceCommit: "b".repeat(40),
  architecture: "linux/amd64", cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480,
  settingsSecretEncryptionKeys: {}, currentSettingsSecretEncryptionKeyVersion: null,
  runtime: { newWorkspaceProfile: "legacy", staffOnly: true, qualificationMode: "full" },
} as CloudWorkspaceBackendConfig;

(process.env.TEST_DATABASE_URL ? describe : describe.skip)("v4 lifecycle pins and checkpoint replacements", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
    await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'");
    await pool.query(`INSERT INTO cloud_workspace_quotas(org_id,max_workspaces,max_running_workspaces,max_cpu_millicores,max_memory_mib,max_storage_mib)
      VALUES($1,10,10,100000,100000,1000000)`, [fixture.organizationId]);
    await pool.query(`INSERT INTO cloud_workspace_setup_attestations (setup_run_id,workspace_id,generation,org_id,execution_fence,
      image_ref,image_source_commit,repository_revision,repository_commit,settings_version,settings_snapshot_sha256,
      engine_instance_id,engine_protocol_version,engine_health,durable_record_connected,
      runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
      runtime_installer_receipt_sha256,runtime_boot_id,runtime_supervisor_session_id)
      SELECT run.id,run.workspace_id,1,run.org_id,run.execution_fence,g.image_ref,g.source_commit,'main',$2,1,spec.settings_snapshot_sha256,
        engine.id,engine.protocol_version,'ready',true,g.runtime_id,g.runtime_manifest_sha256,g.runtime_base_image_id,g.runtime_base_compatibility_id,
        g.runtime_profile,g.runtime_engine_protocol_version,engine.runtime_installer_receipt_sha256,engine.runtime_boot_id,engine.runtime_supervisor_session_id
      FROM cloud_workspace_setup_runs run JOIN cloud_workspace_generations g USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_setup_specs spec USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_engine_instances engine ON engine.setup_run_id=run.id WHERE run.workspace_id=$1`, [fixture.workspaceId,"c".repeat(40)]);
    await pool.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
  });
  const scope = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1 });
  const pin = (generation = 1) => withSystemTx(pool, tx => loadGenerationSource(tx, { ...scope(), generation }));
  const route = (path: string, body?: unknown, selectedConfig = config) => {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: fixture.userId, staffRole: "developer" }); await next(); });
    app.route("/", createCloudWorkspaceRoutes(pool, selectedConfig, { workosEnabled: false }));
    app.onError((error, c) => {
      if (error instanceof HttpError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
      throw error;
    });
    return app.request(`/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(body ?? {}),
    });
  };
  const upgrade = (operationId = randomUUID(), expectedGeneration = 1, selectedConfig = config) =>
    route("/runtime-upgrade", { operationId, expectedGeneration }, selectedConfig);
  async function advanceHead(mode: "full" | "smoke" = "full") {
    return withSystemTx(pool, async tx => {
      const runtime = await seedRuntimeBundle(tx, { digit: "2", releaseOrder: 2, mode });
      await seedRuntimeBase(tx, { ...runtimeBase, id: "zeros-v2-test-later-base", imageRef: "boat:zeros-v2-test-later-base",
        compatibilityId: `bc1-${"8".repeat(64)}` }, new Date(Date.now() + 1_000));
      return runtime;
    });
  }
  async function revoke() {
    await pool.query("UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id=$1", [(await pin()).runtime!.runtimeId]);
  }
  async function finalCheckpoint(reason: "before_stop" | "before_rebuild" = "before_stop") {
    const engineScope = { ...scope(), engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
    const objects = new Map<string, Buffer>();
    const blobs = new DatabaseCloudWorkspaceBlobService({ pool, workosEnabled: false, encryptionKeyV1: randomBytes(32).toString("base64url"),
      objectStore: { async putIfAbsent(key, value) { if (objects.has(key)) return "already_exists"; objects.set(key,value); return "created"; },
        async get(key) { return objects.get(key) ?? null; }, async delete(key) { objects.delete(key); },
        async deleteAndFence(key) { objects.delete(key); }, async sweepAbandonedUploads() { return 0; } } });
    const content = new DatabaseCloudWorkspaceContentService({ pool, workosEnabled: false });
    const manifest = await blobs.put({ ...engineScope, bytes: Buffer.from("{}") });
    const file = await blobs.put({ ...engineScope, bytes: Buffer.from("preserved") });
    const revision = await content.append({ ...engineScope, expectedRevision: 0, idempotencyKey: randomUUID(), gitBaseCommit: "a".repeat(40), gitHeadRef: null,
      mutations: [{ path: "work.txt", operation: "upsert", entryType: "file", mode: 33188, blobId: file.id, contentSha256: file.plaintextSha256, sizeBytes: 9 }] });
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '11 minutes' WHERE id=$1", [fixture.engineInstanceId]);
    if (reason === "before_rebuild") expect((await upgrade()).status).toBe(202);
    const directive = reason === "before_stop"
      ? (await new DatabaseCloudIdleStop(pool,false).request(engineScope,randomUUID()))!
      : (await pool.query("SELECT id FROM workspace_checkpoint_requests WHERE workspace_id=$1 AND reason='before_rebuild' AND state='queued'", [fixture.workspaceId])).rows[0];
    const checkpoint = await content.commitCheckpoint({ ...engineScope, requestId: directive.id, idempotencyKey: randomUUID(), contentRevision: revision.revision,
      reason, manifestBlobId: manifest.id, artifactBlobId: null, inclusionPolicy: {}, fileCount: 1, totalBytes: 9, integritySha256: manifest.plaintextSha256 });
    if (reason === "before_rebuild") return checkpoint.checkpointId;
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='stopped' WHERE workspace_id=$1", [fixture.workspaceId]);
    return checkpoint.checkpointId;
  }
  async function drain() {
    let resource: CloudProviderResource = { workspaceId: fixture.workspaceId, generation: 1, resourceId: `sandbox-${fixture.workspaceId}`, state: "running", target: null, metadata: {} };
    const unexpected = vi.fn(async () => { throw new Error("Only source drain is expected"); });
    const provider: CloudWorkspaceProvider = { name: "boat", async find() { return [resource]; }, async inspect() { return resource; },
      create: unexpected, start: unexpected, async stop() { resource = { ...resource, state: "stopped" }; return resource; },
      archive: unexpected, delete: unexpected, async *listManaged() {} };
    expect(await new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1000 }).runOnce()).toBe(true);
    expect(unexpected).not.toHaveBeenCalled();
  }
  async function failedWake() {
    expect((await route("/wake")).status).toBe(202);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    const run = (await pool.query(`INSERT INTO cloud_workspace_setup_runs(workspace_id,generation,org_id,attempt,state)
      VALUES($1,1,$2,2,'queued') RETURNING id`, [fixture.workspaceId,fixture.organizationId])).rows[0];
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='running' WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspaces SET status='setting_up',authority_epoch=authority_epoch+1 WHERE id=$1", [fixture.workspaceId]);
    const worker = new CloudWorkspaceSetupWorker({ pool, recoveryConfig: config, intervalMs: 1000, maxClaims: 2, sanitizeLog: value => value,
      executor: { async execute() { throw new CloudWorkspaceSetupError("setup_immutable_runtime_missing", "Fixture restore failure", true); } } });
    await worker.runOnce();
    await pool.query("UPDATE cloud_workspace_setup_runs SET next_attempt_at=now() WHERE id=$1", [run.id]);
    await worker.runOnce();
    return worker;
  }

  it.each(["wake", "retry", "recover", "automatic recovery", "upgrade"] as const)("retains the accepted computer source through %s after activation changes", async operation => {
    const accepted = await withSystemTx(pool, async tx => {
      const installationId = randomUUID();
      await tx.query(`INSERT INTO github_installations(id,github_installation_id,app_variant,org_id,account_login,account_type,target_type)
        VALUES($1,987654,'github.com',$2,'withso','Organization','Organization')`, [installationId,fixture.organizationId]);
      const input = { organizationId: fixture.organizationId, ownerUserId: fixture.userId, installationId,
        runtimeId: (await loadGenerationSource(tx, scope())).runtime!.runtimeId };
      const computer = await seedComputerTemplate(tx, input);
      await tx.query(`INSERT INTO cloud_workspace_computer_sources(workspace_id,generation,org_id,build_id,template_id,config_id)
        VALUES($1,1,$2,$3,$3,$4)`, [fixture.workspaceId,fixture.organizationId,computer.buildId,computer.configId]);
      await seedComputerTemplate(tx, { ...input, version: 2 });
      return { build_id: computer.buildId, template_id: computer.templateId, config_id: computer.configId };
    });
    const checkpointId = await finalCheckpoint();
    await advanceHead();
    if (operation === "automatic recovery") {
      const worker = await failedWake();
      await drain();
      expect(await worker.runOnce()).toBe(true);
    } else if (operation === "recover") {
      expect((await route("/generations", { operation: "recover", sourceGeneration: 1, checkpointId })).status).toBe(202);
    } else if (operation === "upgrade") {
      expect((await upgrade()).status).toBe(202);
    } else {
      expect((await route("/wake")).status).toBe(202);
      if (operation === "retry") {
        await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
        const run = (await pool.query(`INSERT INTO cloud_workspace_setup_runs(workspace_id,generation,org_id,attempt,state)
          VALUES($1,1,$2,2,'queued') RETURNING id`, [fixture.workspaceId,fixture.organizationId])).rows[0];
        await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='running' WHERE workspace_id=$1", [fixture.workspaceId]);
        await pool.query("UPDATE cloud_workspaces SET status='setting_up' WHERE id=$1", [fixture.workspaceId]);
        const execute = vi.fn(async () => { throw new CloudWorkspaceSetupError("setup_repository_unavailable", "Fixture retry", true); });
        const worker = new CloudWorkspaceSetupWorker({ pool, recoveryConfig: config, intervalMs: 1000, maxClaims: 3,
          sanitizeLog: value => value, executor: { execute } });
        expect(await worker.runOnce()).toBe(true);
        await pool.query("UPDATE cloud_workspace_setup_runs SET next_attempt_at=now() WHERE id=$1", [run.id]);
        expect(await worker.runOnce()).toBe(true);
        expect(execute).toHaveBeenCalledTimes(2);
      }
    }
    // Wake and retry reuse generation 1. Replacements copy the same immutable
    // build/template/config tuple even though a different build is now active.
    const generations = operation === "wake" || operation === "retry" ? [1] : [1,2];
    expect((await pool.query(`SELECT generation,build_id,template_id,config_id FROM cloud_workspace_computer_sources
      WHERE workspace_id=$1 ORDER BY generation`, [fixture.workspaceId])).rows)
      .toEqual(generations.map(generation => ({ generation, ...accepted })));
  });

  it("copies the full pin at the single generation-copy boundary", async () => {
    const source = await pin();
    await advanceHead();
    await withSystemTx(pool, async tx => {
      const connection = (await tx.query("SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1", [fixture.workspaceId])).rows[0];
      await copyGenerationPins(tx, { ...scope(), sourceGeneration: 1, targetGeneration: 2, actorUserId: fixture.userId,
        providerConnectionId: connection.provider_connection_id, legacyProfile: config, qualificationMode: "full" });
    });
    expect(await pin(2)).toEqual(source);
  });
  it("copies the source pin in explicit checkpoint recovery after the head and create switch change", async () => {
    const source = await pin(), checkpointId = await finalCheckpoint();
    await advanceHead();
    const response = await route("/generations", { operation: "recover", sourceGeneration: 1, checkpointId });
    expect(response.status).toBe(202);
    expect(await pin(2)).toEqual(source);
    await drain();
    expect(await pin(2)).toEqual(source);
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].current_generation).toBe(2);
    expect((await pool.query("SELECT recovery_checkpoint_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rows[0].recovery_checkpoint_id).toBe(checkpointId);
  });
  it("copies the source pin in automatic recovery through drain and reconciler provisioning", async () => {
    const source = await pin();
    await finalCheckpoint();
    await advanceHead();
    const worker = await failedWake();
    await drain();
    expect(await worker.runOnce()).toBe(true);
    expect(await pin(2)).toEqual(source);
    expect((await pool.query("SELECT operation,state FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows)
      .toEqual([{ operation: "recover", state: "provisioning" }]);
  });
  it("refuses revoked explicit recovery without changing the source or creating a candidate", async () => {
    const checkpointId = await finalCheckpoint();
    await advanceHead(); await revoke();
    const response = await route("/generations", { operation: "recover", sourceGeneration: 1, checkpointId });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "cloud_runtime_revoked", message: expect.stringContaining("upgrade") } });
    expect((await pool.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(1);
  });
  it("fails automatic recovery closed when its saved runtime is revoked after wake failure", async () => {
    await finalCheckpoint();
    const worker = await failedWake();
    await drain(); await advanceHead(); await revoke();
    await worker.runOnce();
    expect((await pool.query("SELECT last_error_code,last_error_message,current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ last_error_code: "cloud_runtime_revoked", last_error_message: expect.stringContaining("upgrade"), current_generation: 1 });
    expect((await pool.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(1);
  });
  it.each(["base", "contract", "qualification"])("reports a revoked %s on wake without selecting another pin", async kind => {
    const source = await pin();
    await finalCheckpoint(); await advanceHead();
    const sql = {
      base: "UPDATE cloud_runtime_base_images SET revoked_at=now() WHERE base_image_id=$1",
      contract: "UPDATE cloud_runtime_base_contracts SET revoked_at=now() WHERE base_compatibility_id=$1",
      qualification: "UPDATE cloud_runtime_qualifications SET revoked_at=now(),enabled=false,mcp_qualified=false WHERE runtime_id=$1 AND credential_kind='codex-chatgpt'",
    }[kind]!;
    await pool.query(sql, [kind === "base" ? source.runtime!.baseImageId : kind === "contract" ? source.runtime!.baseCompatibilityId : source.runtime!.runtimeId]);
    const response = await route("/wake");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "cloud_runtime_revoked" } });
    expect(await pin()).toEqual(source);
  });
  it("refuses a newer runtime qualified only for a different base", async () => {
    await withSystemTx(pool, async tx => {
      const base = await seedRuntimeBase(tx, { ...runtimeBase, id: "zeros-v2-test-other-base", imageRef: "boat:zeros-v2-test-other-base",
        compatibilityId: `bc1-${"8".repeat(64)}` });
      await seedRuntimeBundle(tx, { digit: "2", releaseOrder: 2, baseCompatibilityId: base.compatibilityId });
    });
    await revoke();
    const response = await upgrade();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "cloud_runtime_unavailable" } });
    expect((await pool.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(1);
  });
  it("ignores an unconfirmed republication of the source when admitting a later eligible runtime", async () => {
    const next = await advanceHead();
    await pool.query(`INSERT INTO cloud_runtime_channel_releases(channel,release_order,runtime_id,github_release_run_id,github_release_run_attempt)
      VALUES('alpha',3,$1,3,1)`, [(await pin()).runtime!.runtimeId]);
    expect((await upgrade()).status).toBe(202);
    expect((await pin(2)).runtime).toEqual(next.pin);
  });
  it.each(["missing", "lossy"])("refuses a stopped runtime upgrade with a %s final checkpoint", async kind => {
    if (kind === "lossy") {
      await finalCheckpoint();
      await pool.query("UPDATE cloud_workspace_engine_instances SET registered_at=now() WHERE id=$1", [fixture.engineInstanceId]);
    } else {
      await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    }
    await advanceHead();
    const response = await upgrade();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: kind === "lossy" ? "recovery_acknowledgement_required" : "cloud_recovery_checkpoint_unavailable" } });
    expect((await pool.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(1);
  });
  it("explicitly upgrades a revoked stopped runtime on the same base using its final checkpoint", async () => {
    const source = await pin(), checkpointId = await finalCheckpoint();
    const next = await advanceHead(); await revoke();
    const response = await upgrade();
    expect(response.status).toBe(202);
    const accepted = await response.json();
    expect(await pin(2)).toEqual({ profile: source.profile, runtime: next.pin });
    await drain();
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].current_generation).toBe(2);
    expect((await pool.query("SELECT recovery_checkpoint_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rows[0].recovery_checkpoint_id).toBe(checkpointId);
    // Replaying an accepted request ignores the now-stale expectedGeneration.
    const replay = await upgrade(accepted.operationId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(accepted);
  });
  it("retains the exact source settings snapshot during a runtime-only upgrade", async () => {
    const saved = (await pool.query("SELECT settings_snapshot FROM cloud_workspace_setup_specs WHERE workspace_id=$1 AND generation=1", [fixture.workspaceId])).rows[0];
    await advanceHead();
    expect((await upgrade()).status).toBe(202);
    expect((await pool.query("SELECT settings_snapshot FROM cloud_workspace_setup_specs WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rows[0]).toEqual(saved);
  });
  it("preserves the source pin when a runtime upgrade candidate fails and rolls back", async () => {
    const source = await pin(); await advanceHead();
    const response = await upgrade(); expect(response.status).toBe(202);
    await withSystemTx(pool, tx => rollbackCloudWorkspaceGenerationTransition(tx, { ...scope(), candidateGeneration: 2,
      errorCode: "setup_repository_unavailable", errorMessage: "Fixture candidate failed" }));
    expect(await pin()).toEqual(source);
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].current_generation).toBe(1);
    expect((await pool.query("SELECT operation,generation FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='wake'", [fixture.workspaceId])).rows)
      .toEqual([{ operation: "wake", generation: 1 }]);
  });
  it.each(["fresh", "later registration"])("retries an upgrade after revoked-source rollback only with a fresh rebuild checkpoint (%s)", async freshness => {
    const source = await pin(), next = await advanceHead();
    const checkpointId = await finalCheckpoint("before_rebuild");
    // Ordinary recovery keeps its existing stop/archive-only lossless rule.
    expect((await withSystemTx(pool, tx => requireCloudRecoveryPoint(tx, {
      ...scope(), sourceGeneration: 1, checkpointId,
    }))).lossless).toBe(false);
    await drain();
    let resource: CloudProviderResource = { workspaceId: fixture.workspaceId, generation: 1,
      resourceId: `sandbox-${fixture.workspaceId}`, state: "stopped", target: null, metadata: {} };
    const start = vi.fn(async () => { throw new Error("Revoked source must not wake"); });
    const provider: CloudWorkspaceProvider = { name: "boat",
      async find(identity) { return identity.generation === resource.generation ? [resource] : []; },
      async inspect(id) { return id === resource.resourceId ? resource : null; }, start,
      async create(input) {
        if (input.generation === 2) throw new CloudProviderError("provider_resource_failed", "Fixture candidate failed", false);
        resource = { ...resource, generation: input.generation, resourceId: `replacement-${input.generation}`, state: "running" };
        return resource;
      },
      async stop() { resource = { ...resource, state: "stopped" }; return resource; },
      archive: start, delete: start, async *listManaged() {},
    };
    const reconciler = new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1000 });
    expect(await reconciler.runOnce()).toBe(true); // Candidate B fails; rollback queues A's wake.
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows)
      .toEqual([{ state: "rolling_back" }]);
    await revoke();
    // Keep unrelated candidate cleanup out of this lifecycle assertion.
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at=now()+interval '1 hour' WHERE workspace_id=$1 AND operation='delete'", [fixture.workspaceId]);
    expect(await reconciler.runOnce()).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect((await pool.query("SELECT current_generation,status,last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ current_generation: 1, status: "failed", last_error_code: "cloud_runtime_revoked" });
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows)
      .toEqual([{ state: "rollback_failed" }]);
    if (freshness === "later registration") {
      await pool.query("UPDATE cloud_workspace_engine_instances SET registered_at=now() WHERE id=$1", [fixture.engineInstanceId]);
    }
    const response = await upgrade(); // New operationId after the failed attempt.
    if (freshness !== "fresh") {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "recovery_acknowledgement_required" } });
      return;
    }
    const accepted = await response.json();
    expect({ status: response.status, error: accepted.error?.code }).toEqual({ status: 202, error: undefined });
    expect(accepted).toMatchObject({ sourceGeneration: 1, generation: 3, runtimeId: next.pin.runtimeId });
    expect(await pin(3)).toEqual({ profile: source.profile, runtime: next.pin });
    expect(await reconciler.runOnce()).toBe(true); // Drain A, preserving the original checkpoint.
    expect(await reconciler.runOnce()).toBe(true); // Provision B as generation 3.
    const worker = new CloudWorkspaceSetupWorker({ pool, intervalMs: 1000, sanitizeLog: value => value,
      executor: { async execute(execution) {
        const engineId = randomUUID();
        await withSystemTx(pool, async tx => {
          const grant = (await tx.query(`INSERT INTO cloud_workspace_endpoint_grants
            (workspace_id,generation,org_id,account_user_id,purpose,audience,token_hash,account_revision,authorization_revision,
             expires_at,consumed_at,setup_run_id,setup_execution_fence)
            VALUES($1,$2,$3,$4,'setup','https://control.example.test/internal/v1/cloud-workspaces/engine/register',$5,1,1,
              now()+interval '5 minutes',now(),$6,$7) RETURNING id`,
          [fixture.workspaceId,execution.generation,fixture.organizationId,fixture.userId,randomBytes(32),execution.setupRunId,execution.executionFence])).rows[0];
          await tx.query(`INSERT INTO cloud_workspace_engine_instances
            (id,workspace_id,generation,org_id,account_user_id,setup_run_id,setup_execution_fence,registration_grant_id,
             protocol_version,state,bridge_token_hash,heartbeat_token_hash,registered_at,last_heartbeat_at,lease_expires_at,
             runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,
             runtime_engine_protocol_version,runtime_installer_receipt_sha256,runtime_boot_id,runtime_supervisor_session_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10,$11,now(),now(),now()+interval '2 minutes',$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [engineId,fixture.workspaceId,execution.generation,fixture.organizationId,fixture.userId,execution.setupRunId,
            execution.executionFence,grant.id,CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,randomBytes(32),randomBytes(32),
            ...cloudRuntimePinValues(execution.runtime),runtimeWitness.installerReceiptSha256,randomUUID(),randomUUID()]);
        });
        return { readiness: { version: 1, setupRunId: execution.setupRunId, workspaceId: fixture.workspaceId,
          organizationId: fixture.organizationId, generation: execution.generation, executionFence: execution.executionFence,
          image: { ref: execution.image.ref, sourceCommit: execution.image.sourceCommit! },
          repository: { revision: execution.repository.revision, commit: "c".repeat(40) },
          settings: { version: execution.settings.version, sha256: execution.settings.sha256 },
          engine: { instanceId: engineId, protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, health: "ready", durableRecordConnected: true } } };
      } },
    });
    expect(await worker.runOnce()).toBe(true);
    expect((await pool.query("SELECT current_generation,status,last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ current_generation: 3, status: "ready", last_error_code: null });
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE id=$1", [accepted.transitionId])).rows[0].state).toBe("succeeded");
    expect((await pool.query("SELECT recovery_checkpoint_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=3", [fixture.workspaceId])).rows[0].recovery_checkpoint_id).toBe(checkpointId);
    expect(await pin()).toEqual(source);
  });
  it("rejects stale generation CAS and operationId reuse with a different request", async () => {
    await advanceHead();
    const stale = await upgrade(randomUUID(), 2);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "cloud_generation_changed" } });
    const operationId = randomUUID(); expect((await upgrade(operationId)).status).toBe(202);
    const reused = await upgrade(operationId, 2);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ error: { code: "idempotency_key_reused" } });
  });
  it("serializes simultaneous upgrade retries into one candidate", async () => {
    await advanceHead();
    const operationId = randomUUID();
    const replies = await Promise.all([upgrade(operationId), upgrade(operationId)]);
    expect(replies.map(reply => reply.status).sort()).toEqual([200,202]);
    expect(await replies[0].json()).toEqual(await replies[1].json());
    expect((await pool.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(2);
  });
  it("persists a no-op receipt so a replay cannot upgrade to a later channel head", async () => {
    const operationId = randomUUID(), response = await upgrade(operationId);
    expect(response.status).toBe(200);
    const accepted = await response.json();
    expect(accepted).toMatchObject({ unchanged: true, generation: 1, transitionId: null });
    await advanceHead();
    const replay = await upgrade(operationId);
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(accepted);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(1);
  });
  it("does not present an already-current runtime receipt as a workspace stop", async () => {
    const management = new DatabaseCloudWorkspaceManagementService(pool, config, { workosEnabled: false });
    const input = { ...scope(), actorUserId: fixture.userId };
    const before = await management.workspaceOverview(input);
    expect((await upgrade()).status).toBe(200);
    expect((await management.workspaceOverview(input)).lifecycle).toEqual(before.lifecycle);
    expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].status).toBe("ready");
  });
  it("refuses busy workspaces without accepting an operation or selecting another pin", async () => {
    await advanceHead();
    await pool.query("UPDATE cloud_workspaces SET status='busy' WHERE id=$1", [fixture.workspaceId]);
    const response = await upgrade();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "cloud_workspace_busy" } });
    expect((await pool.query("SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(0);
  });
  it("refuses an active agent lease even before the workspace status becomes busy", async () => {
    await advanceHead();
    const credentialId = randomUUID(), delegationId = randomUUID(), sessionId = randomUUID(), leaseId = randomUUID();
    await pool.query(`INSERT INTO cloud_agent_credentials(id,owner_user_id,kind,display_name,last_operation_id,last_request_sha256)
      VALUES($1,$2,'cursor-api-key','Fixture',gen_random_uuid(),$3)`, [credentialId,fixture.userId,Buffer.alloc(32)]);
    await pool.query(`INSERT INTO cloud_agent_credential_delegations(id,credential_id,owner_user_id,credential_revision,workspace_id,org_id,
      grantee_user_id,owner_fingerprint,grantee_fingerprint,compute_fingerprint,compute_trust,models,expires_at)
      VALUES($1,$2,$3,1,$4,$5,$3,$6,$6,$6,'zeros-managed',ARRAY['fixture-model'],now()+interval '5 minutes')`,
    [delegationId,credentialId,fixture.userId,fixture.workspaceId,fixture.organizationId,"a".repeat(64)]);
    const device = (await pool.query(`INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint)
      VALUES($1,'Fixture','linux',$2,$3) RETURNING id`, [fixture.userId,randomBytes(32),randomBytes(32)])).rows[0];
    await pool.query(`INSERT INTO cloud_workspace_actor_sessions(id,workspace_id,org_id,generation,engine_instance_id,actor_user_id,device_id,
      device_key_version,authority_epoch,actor_fingerprint,actor_role,token_hash,admission_expires_at,session_expires_at,revoked_at)
      VALUES($1,$2,$3,1,$4,$5,$6,1,1,$7,'owner',$8,now()+interval '5 minutes',now()+interval '5 minutes',now())`,
    [sessionId,fixture.workspaceId,fixture.organizationId,fixture.engineInstanceId,fixture.userId,device.id,"a".repeat(64),randomBytes(32)]);
    await pool.query(`INSERT INTO cloud_agent_execution_leases(id,delegation_id,credential_id,credential_revision,workspace_id,org_id,generation,
      engine_instance_id,actor_source_session_id,execution_id,provider,model,expires_at)
      VALUES($1,$2,$3,1,$4,$5,1,$6,$7,'fixture-execution','cursor','fixture-model',now()+interval '5 minutes')`,
    [leaseId,delegationId,credentialId,fixture.workspaceId,fixture.organizationId,fixture.engineInstanceId,sessionId]);
    const refused = await upgrade();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "cloud_workspace_busy" } });
    await pool.query("UPDATE cloud_agent_execution_leases SET released_at=now() WHERE id=$1", [leaseId]);
    expect((await upgrade()).status).toBe(202);
  });
  it("applies running quota to an upgrade that wakes a stopped source", async () => {
    await finalCheckpoint(); await advanceHead();
    await withSystemTx(pool, async tx => {
      const sibling = randomUUID();
      await tx.query(`INSERT INTO cloud_workspaces SELECT (jsonb_populate_record(NULL::cloud_workspaces,
        to_jsonb(workspace)||jsonb_build_object('id',$2::uuid,'desired_state','running','status','ready'))).*
        FROM cloud_workspaces workspace WHERE id=$1`, [fixture.workspaceId,sibling]);
      await tx.query(`INSERT INTO cloud_workspace_generations SELECT (jsonb_populate_record(NULL::cloud_workspace_generations,
        to_jsonb(g)||jsonb_build_object('workspace_id',$2::uuid))).*
        FROM cloud_workspace_generations g WHERE workspace_id=$1 AND generation=1`, [fixture.workspaceId,sibling]);
      await seedCanonicalCloudWorkspaceAuthority(tx, {
        workspaceId: sibling, organizationId: fixture.organizationId, ownerUserId: fixture.userId,
      });
      await tx.query("UPDATE cloud_workspace_quotas SET max_running_workspaces=1 WHERE org_id=$1", [fixture.organizationId]);
    });
    const response = await upgrade();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "cloud_quota_exceeded" } });
  });
  it("keeps v3 pins NULL and rejects the v4-only endpoint without migrating the generation", async () => {
    fixture = await seedReadyCloudWorkspace(pool);
    const response = await upgrade();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "cloud_runtime_upgrade_not_supported" } });
    const source = await pin();
    await withSystemTx(pool, async tx => {
      const connection = (await tx.query("SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1", [fixture.workspaceId])).rows[0];
      await copyGenerationPins(tx, { ...scope(), sourceGeneration: 1, targetGeneration: 2, actorUserId: fixture.userId,
        providerConnectionId: connection.provider_connection_id, legacyProfile: { ...source.profile, imageRef: "zeros-v2-test-legacy-upgrade" }, qualificationMode: "full" });
    });
    expect(await pin(2)).toEqual({ runtime: null, profile: { ...source.profile, imageRef: "zeros-v2-test-legacy-upgrade" } });
  });
  it("copies a previously qualified v4 source pin during an explicit generation rollback", async () => {
    const source = await pin(); await finalCheckpoint(); await advanceHead();
    expect((await upgrade()).status).toBe(202);
    await drain();
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_generation_transitions SET state='succeeded',completed_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspaces SET current_generation=2,status='ready' WHERE id=$1", [fixture.workspaceId]);
    const response = await route("/generations", { operation: "rollback", sourceGeneration: 1 });
    expect(response.status).toBe(202);
    expect(await pin(3)).toEqual(source);
  });
  it("refuses to downgrade when revocation leaves only an older eligible runtime", async () => {
    await finalCheckpoint(); const next = await advanceHead();
    expect((await upgrade()).status).toBe(202);
    await drain();
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_generation_transitions SET state='succeeded',completed_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspaces SET status='ready' WHERE id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id=$1", [next.pin.runtimeId]);
    const response = await upgrade(randomUUID(), 2);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "cloud_runtime_unavailable" } });
    expect((await pin(2)).runtime).toEqual(next.pin);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(2);
  });
  it("uses the current database staff role even with a stale engineering session", async () => {
    await advanceHead();
    await pool.query("UPDATE users SET staff_role='support_admin' WHERE id=$1", [fixture.userId]);
    expect((await upgrade()).status).toBe(404);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(1);
  });
  it("accepts a smoke-only upgrade only under the configured qualification mode", async () => {
    const next = await advanceHead("smoke");
    expect(await (await upgrade()).json()).toMatchObject({ unchanged: true, generation: 1 });
    const response = await upgrade(randomUUID(), 1, { ...config, runtime: { ...config.runtime!, qualificationMode: "smoke" } });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ runtimeId: next.pin.runtimeId, generation: 2 });
  });
});

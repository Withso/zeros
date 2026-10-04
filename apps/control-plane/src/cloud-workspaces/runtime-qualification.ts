import type pg from "pg";
import { HttpError } from "../authz.js";
import type { Config } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import { BoatApiClient } from "./boat-client.js";
import { BoatCloudBuilderVms, BuilderVmError, builderVmSourceResolver, type BuilderVm, type CloudBuilderVms } from "./cloud-builder-vm.js";
import { DatabaseBuilderVmOperationStore, type BuilderVmIntent, type BuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import { RUNTIME_SMOKE_CHECKS, type ClosedDiagnostic } from "./cloud-builder-commands.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { RuntimeDescriptorSchema, RuntimeInstallInputSchema, type RuntimeDescriptor } from "./runtime-contract.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";

export const RUNTIME_QUALIFICATION_KINDS = ["claude-setup-token", "codex-chatgpt", "cursor-api-key", "claude-api-key", "codex-api-key"] as const;
const RUN_MS = 25 * 60_000;
const CLEANUP_LEASE_MS = 7 * 60_000;
const SCHEDULE_LOCK = "cloud-runtime-smoke-scheduler";
type Run = { id: string; runtime_id: string; state: "queued" | "running" | "succeeded" | "failed";
  base_image_id: string | null; base_compatibility_id: string | null; sandbox_id: string | null; deadline_at: Date | null };
type Base = { base_image_id: string; base_compatibility_id: string };
type Bundle = { runtime_id: string; manifest_sha256: string; archive_sha256: string; archive_bytes: string;
  expanded_bytes: string; source_commit: string; node_modules_abi: number; bootstrap_protocol_version: number;
  engine_protocol_version: number; object_key: string };
export type RuntimeQualificationEnqueueResult = { status: "queued" | "running" | "qualified" | "failed" | "disabled"; runId: string | null };
export type RuntimeRequalify = (runtimeId: string) => Promise<RuntimeQualificationEnqueueResult>;

function failure(stage: string, check: string): ClosedDiagnostic {
  return { schema: "zeros.diagnostic/v1", component: "qualification", stage, ok: false,
    exitCode: null, timedOut: check === "timeout", failedChecks: [check] };
}
class QualificationFailure extends Error {
  constructor(readonly diagnostic: ClosedDiagnostic) { super("Runtime qualification failed"); }
}
function reject(stage: string, check: string): never { throw new QualificationFailure(failure(stage, check)); }
const operationKey = (run: Run) => `runtime-qualification.${run.id}`;
const intent = (run: Run): BuilderVmIntent => ({ purpose: "runtime-qualification",
  source: { kind: "base", baseImageId: run.base_image_id! }, name: `zeros-v2-qual-${run.runtime_id.slice(3, 15)}`,
  operationKey: operationKey(run), ttlSeconds: 1800 });
const vm = (run: Run, id: string): BuilderVm => ({ purpose: "runtime-qualification", sandboxId: id, operationKey: operationKey(run) });

async function newestBase(tx: Tx): Promise<Base | null> {
  return (await tx.query<Base>(`SELECT base.base_image_id,base.base_compatibility_id FROM cloud_runtime_base_images base
    JOIN cloud_runtime_base_contracts contract USING (base_compatibility_id)
    WHERE base.revoked_at IS NULL AND contract.revoked_at IS NULL AND base.provider='boat' AND base.approved_at<=clock_timestamp()
    ORDER BY base.approved_at DESC,base.base_image_id LIMIT 1 FOR SHARE OF base,contract`)).rows[0] ?? null;
}
async function eligibleBundle(tx: Tx, id: string): Promise<Bundle | null> {
  return (await tx.query<Bundle>(`SELECT bundle.* FROM cloud_runtime_bundles bundle
    JOIN cloud_runtime_channel_releases release USING (runtime_id)
    WHERE bundle.runtime_id=$1 AND bundle.revoked_at IS NULL AND bundle.engine_protocol_version=$2
      AND release.channel='alpha' AND release.confirmed_at IS NOT NULL AND release.revoked_at IS NULL
    ORDER BY release.release_order DESC LIMIT 1 FOR SHARE OF bundle,release`, [id, CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION])).rows[0] ?? null;
}
async function qualified(tx: Tx, id: string, base: Base) {
  return (await tx.query(`SELECT 1 FROM cloud_runtime_qualifications WHERE runtime_id=$1 AND base_compatibility_id=$2
    AND profile='zeros-cloud-worker-v4' AND credential_kind=ANY($3::text[]) AND enabled AND revoked_at IS NULL
    AND evidence->>'mode' IN ('smoke','full')`, [id, base.base_compatibility_id, RUNTIME_QUALIFICATION_KINDS])).rowCount === RUNTIME_QUALIFICATION_KINDS.length;
}

/** Publication only queues. The database's global running index, short claims
 * and cleanup lease coordinate API/worker replicas without holding a DB
 * transaction over Boat, artifact signing or SSH. */
export class RuntimeQualificationWorker {
  private pending: Promise<void> | null = null;
  constructor(private readonly options: {
    pool: pg.Pool; enabled: boolean; vms: CloudBuilderVms | null;
    operations: BuilderVmOperationStore | null; artifacts: RuntimeArtifactStore | null;
    intervalMs?: number;
  }) {}

  async enqueue(runtimeId: string, options: { force?: boolean } = {}): Promise<RuntimeQualificationEnqueueResult> {
    if (!this.options.enabled) return { status: "disabled", runId: null };
    if (!/^r1-[a-f0-9]{64}$/.test(runtimeId)) throw new HttpError(400, "invalid_request", "Invalid runtime identity");
    if (!this.options.vms || !this.options.operations || !this.options.artifacts)
      throw new HttpError(503, "runtime_smoke_unavailable", "Runtime smoke qualification unavailable");
    return withSystemTx(this.options.pool, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [SCHEDULE_LOCK]);
      if (!await eligibleBundle(tx, runtimeId)) throw new HttpError(409, "runtime_smoke_ineligible", "Runtime is not eligible for smoke qualification");
      const previous = (await tx.query<Run>(`SELECT * FROM cloud_runtime_qualification_runs
        WHERE runtime_id=$1 AND state IN ('queued','running')`, [runtimeId])).rows[0];
      if (previous) return { status: previous.state as "queued" | "running", runId: previous.id };
      const base = await newestBase(tx);
      if (!options.force && base && await qualified(tx, runtimeId, base)) return { status: "qualified", runId: null };
      // An automatic publication replay does not loop indefinitely on a failed
      // runtime. Operators retry explicitly; a new base can get a fresh smoke.
      if (!options.force && base) {
        const failed = (await tx.query<Run>(`SELECT * FROM cloud_runtime_qualification_runs
          WHERE runtime_id=$1 AND base_compatibility_id=$2 AND state='failed' ORDER BY created_at DESC LIMIT 1`,
        [runtimeId, base.base_compatibility_id])).rows[0];
        if (failed) return { status: "failed", runId: failed.id };
      }
      const run = (await tx.query<Run>(`INSERT INTO cloud_runtime_qualification_runs (runtime_id) VALUES ($1) RETURNING *`, [runtimeId])).rows[0]!;
      return { status: "queued", runId: run.id };
    });
  }

  tick(): Promise<void> {
    if (!this.options.enabled || !this.options.vms || !this.options.operations || !this.options.artifacts) return Promise.resolve();
    if (!this.pending) this.pending = this.work().finally(() => { this.pending = null; });
    return this.pending;
  }
  start(): () => Promise<void> {
    if (!this.options.enabled) return async () => {};
    const tick = () => { void this.tick().catch(() => console.warn("[cloud-runtime] qualification_tick_failed")); };
    const timer = setInterval(tick, this.options.intervalMs ?? 30_000);
    timer.unref();
    tick();
    return async () => { clearInterval(timer); await this.pending?.catch(() => {}); };
  }

  private async claim(): Promise<{ run: Run; reconcile: boolean } | null> {
    return withSystemTx(this.options.pool, async tx => {
      const lock = (await tx.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [SCHEDULE_LOCK])).rows[0];
      if (!lock?.locked) return null;
      const running = (await tx.query<Run>(`SELECT * FROM cloud_runtime_qualification_runs WHERE state='running' FOR UPDATE`)).rows[0];
      if (running) {
        const expired = (await tx.query<Run>(`UPDATE cloud_runtime_qualification_runs
          SET cleanup_lease_until=clock_timestamp()+$2*interval '1 millisecond'
          WHERE id=$1 AND deadline_at<=clock_timestamp() AND (cleanup_lease_until IS NULL OR cleanup_lease_until<=clock_timestamp()) RETURNING *`,
        [running.id, CLEANUP_LEASE_MS])).rows[0];
        return expired ? { run: expired, reconcile: true } : null;
      }
      const base = await newestBase(tx);
      if (!base) return null;
      let queued = (await tx.query<Run>(`SELECT run.* FROM cloud_runtime_qualification_runs run
        JOIN cloud_runtime_bundles bundle USING (runtime_id)
        WHERE run.state='queued' ORDER BY run.created_at,run.id LIMIT 1 FOR UPDATE OF run`)).rows[0];
      if (!queued) {
        const candidate = (await tx.query<{ runtime_id: string }>(`SELECT bundle.runtime_id FROM cloud_runtime_channel_releases release
          JOIN cloud_runtime_bundles bundle USING (runtime_id)
          WHERE release.channel='alpha' AND release.confirmed_at IS NOT NULL AND release.revoked_at IS NULL AND bundle.revoked_at IS NULL
            AND bundle.engine_protocol_version=$1
            AND EXISTS (SELECT 1 FROM unnest($3::text[]) required(kind) WHERE NOT EXISTS (
              SELECT 1 FROM cloud_runtime_qualifications q WHERE q.runtime_id=bundle.runtime_id AND q.base_compatibility_id=$2
                AND q.credential_kind=required.kind AND q.profile='zeros-cloud-worker-v4' AND q.enabled AND q.revoked_at IS NULL
                AND q.evidence->>'mode' IN ('smoke','full')))
            AND NOT EXISTS (SELECT 1 FROM cloud_runtime_qualification_runs run
              WHERE run.runtime_id=bundle.runtime_id AND run.base_compatibility_id=$2 AND run.state IN ('failed','succeeded'))
          ORDER BY release.release_order DESC LIMIT 1`, [CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, base.base_compatibility_id, RUNTIME_QUALIFICATION_KINDS])).rows[0];
        if (!candidate) return null;
        queued = (await tx.query<Run>(`INSERT INTO cloud_runtime_qualification_runs (runtime_id) VALUES ($1) RETURNING *`, [candidate.runtime_id])).rows[0];
      }
      if (!queued) return null;
      if (!await eligibleBundle(tx, queued.runtime_id)) {
        await tx.query(`UPDATE cloud_runtime_qualification_runs SET state='failed',finished_at=clock_timestamp(),diagnostic=$2 WHERE id=$1`,
        [queued.id, JSON.stringify(failure("admit", "runtime_ineligible"))]);
        return null;
      }
      const run = (await tx.query<Run>(`UPDATE cloud_runtime_qualification_runs SET state='running',base_image_id=$2,base_compatibility_id=$3,
        started_at=clock_timestamp(),deadline_at=clock_timestamp()+$4*interval '1 millisecond' WHERE id=$1 RETURNING *`,
      [queued.id, base.base_image_id, base.base_compatibility_id, RUN_MS])).rows[0]!;
      return { run, reconcile: false };
    });
  }

  private async admitted(run: Run): Promise<{ descriptor: RuntimeDescriptor; objectKey: string }> {
    return withSystemTx(this.options.pool, async tx => {
      const bundle = await eligibleBundle(tx, run.runtime_id);
      const base = (await tx.query(`SELECT 1 FROM cloud_runtime_base_images base
        JOIN cloud_runtime_base_contracts contract USING (base_compatibility_id)
        WHERE base.base_image_id=$1 AND base.base_compatibility_id=$2 AND base.revoked_at IS NULL AND contract.revoked_at IS NULL FOR SHARE OF base,contract`,
      [run.base_image_id, run.base_compatibility_id])).rowCount;
      const live = (await tx.query(`SELECT 1 FROM cloud_runtime_qualification_runs
        WHERE id=$1 AND state='running' AND deadline_at>clock_timestamp()`, [run.id])).rowCount;
      if (!live) reject("admit", "timeout");
      if (!bundle || !base) reject("admit", "runtime_ineligible");
      const parsed = RuntimeDescriptorSchema.safeParse({ runtimeId: bundle.runtime_id, manifestSha256: bundle.manifest_sha256,
        archiveSha256: bundle.archive_sha256, archiveBytes: Number(bundle.archive_bytes), expandedBytes: Number(bundle.expanded_bytes),
        sourceCommit: bundle.source_commit, nodeModulesAbi: bundle.node_modules_abi,
        bootstrapProtocolVersion: bundle.bootstrap_protocol_version, engineProtocolVersion: bundle.engine_protocol_version });
      if (!parsed.success) reject("admit", "runtime_descriptor");
      return { descriptor: parsed.data, objectKey: bundle.object_key };
    });
  }

  private async work() {
    const claimed = await this.claim();
    if (!claimed) return;
    const { run, reconcile } = claimed;
    let stage = "allocate";
    let result: ClosedDiagnostic | null = reconcile ? failure("reconcile", "timeout") : null;
    if (!reconcile) try {
      await this.admitted(run);
      const builder = await this.options.vms!.create(intent(run));
      await this.recordSandbox(run, builder.sandboxId);
      stage = "base_status";
      const base = await this.options.vms!.baseStatus(builder);
      if (base.baseCompatibilityId !== run.base_compatibility_id || !["idle", "waiting_for_runtime"].includes(base.hostState)) reject(stage, "base_compatibility");
      stage = "install_runtime";
      const runtime = await this.admitted(run);
      const artifact = await this.options.artifacts!.presignGet(runtime.objectKey, 900);
      const payload = RuntimeInstallInputSchema.safeParse({ schema: "zeros.runtime-install/v1", purpose: "qualification", runtime: runtime.descriptor, artifact });
      if (!payload.success || Date.parse(artifact.expiresAt) <= Date.now() || Date.parse(artifact.expiresAt) > Date.now() + 900_000) reject(stage, "artifact_expired");
      const input = Buffer.from(Buffer.from(JSON.stringify(payload.data)).toString("base64url"));
      const installed = await this.options.vms!.runFixed(builder, "install-runtime", input, { timeoutMs: 600_000 });
      if (!installed.diagnostic) reject(stage, "diagnostic_missing");
      if (installed.exitCode !== 0 || !installed.diagnostic.ok) throw new QualificationFailure(installed.diagnostic);
      stage = "self_test";
      await this.admitted(run);
      const status = await this.options.vms!.baseStatus(builder);
      if (status.baseCompatibilityId !== run.base_compatibility_id || status.currentRuntimeId !== run.runtime_id || status.hostState !== "idle") reject(stage, "runtime_identity");
      const tested = await this.options.vms!.runFixed(builder, "runtime-self-test", undefined, { timeoutMs: 600_000 });
      if (!tested.diagnostic) reject(stage, "diagnostic_missing");
      if (tested.exitCode !== 0 || !tested.diagnostic.ok) throw new QualificationFailure(tested.diagnostic);
      result = tested.diagnostic;
    } catch (error) {
      result = error instanceof QualificationFailure ? error.diagnostic : failure(stage, error instanceof BuilderVmError ? error.check : "operation_failed");
    }
    // Cleanup precedes approval. An unknown create is replayed with the exact
    // journalled key/body solely to recover its identity and delete it.
    const cleaned = await this.cleanup(run);
    if (!cleaned) {
      await withSystemTx(this.options.pool, async tx => {
        await tx.query(`UPDATE cloud_runtime_qualification_runs SET diagnostic=$2,deadline_at=LEAST(deadline_at,clock_timestamp()),cleanup_lease_until=NULL
          WHERE id=$1 AND state='running'`, [run.id, JSON.stringify(failure("cleanup", "cleanup_unconfirmed"))]);
      });
      return;
    }
    await this.finish(run, result ?? failure("self_test", "diagnostic_missing"));
  }

  private async recordSandbox(run: Run, sandboxId: string) {
    await withSystemTx(this.options.pool, async tx => {
      const saved = await tx.query(`UPDATE cloud_runtime_qualification_runs SET sandbox_id=$2
        WHERE id=$1 AND state='running' AND (sandbox_id IS NULL OR sandbox_id=$2)`, [run.id, sandboxId]);
      if (saved.rowCount !== 1) reject("admit", "timeout");
    });
    run.sandbox_id = sandboxId;
  }
  private async cleanup(run: Run): Promise<boolean> {
    try {
      let operation = await this.options.operations!.find(operationKey(run));
      if (!operation && !run.sandbox_id) return true;
      if (!operation?.sandbox_id && operation?.create_dispatched_at) {
        try { await this.options.vms!.create(operation.intent); } catch { /* May bind before failing wallet/readiness. */ }
        operation = await this.options.operations!.find(operationKey(run));
      }
      const sandbox = operation?.sandbox_id ?? run.sandbox_id;
      if (!sandbox) return !operation?.create_dispatched_at;
      await this.recordSandbox(run, sandbox);
      await this.options.vms!.delete(vm(run, sandbox));
      return true;
    } catch { return false; }
  }

  private async finish(run: Run, result: ClosedDiagnostic) {
    await withSystemTx(this.options.pool, async tx => {
      // Lock the same revocable registry rows as admission through the inserts.
      const bundle = await eligibleBundle(tx, run.runtime_id);
      const base = (await tx.query(`SELECT 1 FROM cloud_runtime_base_images base JOIN cloud_runtime_base_contracts contract USING (base_compatibility_id)
        WHERE base.base_image_id=$1 AND base.base_compatibility_id=$2 AND base.revoked_at IS NULL AND contract.revoked_at IS NULL FOR SHARE OF base,contract`,
      [run.base_image_id, run.base_compatibility_id])).rowCount;
      const active = (await tx.query<{ timely: boolean }>(`SELECT deadline_at>clock_timestamp() AS timely FROM cloud_runtime_qualification_runs
        WHERE id=$1 AND state='running' FOR UPDATE`, [run.id])).rows[0];
      if (!active) return;
      if (result.ok && (!bundle || !base)) result = failure("admit", "runtime_ineligible");
      if (result.ok && !active.timely) result = failure("admit", "timeout");
      if (result.ok) {
        const evidence = { mode: "smoke", checks: ["base_status", "install_runtime", ...RUNTIME_SMOKE_CHECKS],
          baseImageId: run.base_image_id, runId: run.id, ranAt: new Date().toISOString() };
        // No model credentials or MCP round trip are exercised by this helper.
        // Existing immutable/revoked approvals are never overwritten by retry.
        await tx.query(`INSERT INTO cloud_runtime_qualifications
          (runtime_id,base_compatibility_id,credential_kind,profile,enabled,mcp_qualified,native_capabilities,evidence,qualified_at)
          SELECT $1,$2,kind,'zeros-cloud-worker-v4',true,false,'{}'::jsonb,$4::jsonb,clock_timestamp()
          FROM unnest($3::text[]) AS required(kind) ON CONFLICT DO NOTHING`,
        [run.runtime_id, run.base_compatibility_id, RUNTIME_QUALIFICATION_KINDS, JSON.stringify(evidence)]);
      }
      await tx.query(`UPDATE cloud_runtime_qualification_runs SET state=$2,diagnostic=$3,finished_at=clock_timestamp(),
        cleanup_confirmed_at=clock_timestamp(),cleanup_lease_until=NULL WHERE id=$1`,
      [run.id, result.ok ? "succeeded" : "failed", JSON.stringify(result)]);
    });
  }
}

export function createRuntimeQualificationWorker(config: Config, pool: pg.Pool, artifacts: RuntimeArtifactStore | null) {
  const cloud = config.cloudWorkspaces;
  const enabled = config.deploymentChannel === "alpha" && cloud?.runtime?.qualificationEnabled === true;
  const operations = enabled && cloud?.provider === "boat" && cloud.boat
    ? new DatabaseBuilderVmOperationStore(pool, cloud.boat.accountScope) : null;
  const vms = operations && cloud?.boat ? new BoatCloudBuilderVms({
    client: new BoatApiClient({ apiKey: cloud.apiKey, billingOrg: cloud.boat.billingOrg, timeoutMs: 45_000 }),
    billingOrg: cloud.boat.billingOrg, operations, resolveSource: builderVmSourceResolver(pool),
  }) : null;
  return new RuntimeQualificationWorker({ pool, enabled, vms, operations, artifacts });
}

import { randomBytes } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import { workerPollingOptions } from "../worker-polling-config.js";
import { BOAT_RESOURCE_ID_PATTERN, BoatApiClient } from "./boat-client.js";
import { boatRuntimeDisplayName } from "./boat-display-name.js";
import {
  BoatCloudBuilderVms, BuilderVmError, NAMED_SNAPSHOT_PATTERN, RUNTIME_IMAGE_ID_PATTERN, builderVmBaseSnapshot,
  builderVmSourceResolver, prepareBuilderVmOperation, type BuilderVm, type CloudBuilderVms,
} from "./cloud-builder-vm.js";
import { DatabaseBuilderVmOperationStore, type BuilderVmIntent, type BuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import type { ClosedDiagnostic } from "./cloud-builder-commands.js";
import { CloudProviderError } from "./provider.js";
import { RuntimeDescriptorSchema, RuntimeInstallInputSchema, type RuntimeDescriptor } from "./runtime-contract.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";
import type { CloudRuntimeBaseRollout } from "./runtime-base-rollout.js";
import { loadPinnedCloudRuntime, selectCloudRuntime } from "./runtime-selection.js";
import { CloudWorkerScheduler } from "./worker-scheduler.js";

export type RuntimeImageChannel = "alpha" | "beta" | "production";
export function runtimeImageChannel(channel: string): RuntimeImageChannel | null {
  return channel === "alpha" || channel === "beta" || channel === "production" ? channel : null;
}

const RUN_MS = 60 * 60_000;
const CLEANUP_LEASE_MS = 7 * 60_000;
const KEEP_READY = 2;
const MAX_FAILED_ATTEMPTS = 5;
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const SAVE_GRACE_MS = 2 * 60_000;
const PRESENCE_INTERVAL_MS = 10 * 60_000;

type ImageState = "building" | "ready" | "failed" | "retiring" | "retired";
type ImageRow = {
  image_id: string; channel: RuntimeImageChannel; runtime_id: string; base_image_id: string; base_compatibility_id: string;
  account_scope: string; billing_org: string; snapshot_name: string; state: ImageState;
  builder_sandbox_id: string | null; probe_sandbox_id: string | null; snapshot_requested_at: Date | null;
  snapshot_id: string | null; size_bytes: string | null; deadline_at: Date; verified_at: Date | null;
};
type Bundle = { runtime_id: string; manifest_sha256: string; archive_sha256: string; archive_bytes: string;
  expanded_bytes: string; source_commit: string; node_modules_abi: number; bootstrap_protocol_version: number;
  engine_protocol_version: number; object_key: string };

// Image production proves a restored runtime, so it reports as qualification;
// a consumer's withdrawal evidence comes from the build that observed it.
function failure(stage: string, check: string, component: "qualification" | "build" = "qualification"): ClosedDiagnostic {
  return { schema: "zeros.diagnostic/v1", component, stage, ok: false,
    exitCode: null, timedOut: check === "timeout", failedChecks: [check] };
}
class RuntimeImageFailure extends Error {
  constructor(readonly diagnostic: ClosedDiagnostic) { super("Runtime image production failed"); }
}
function reject(stage: string, check: string): never { throw new RuntimeImageFailure(failure(stage, check)); }

const builderKey = (row: ImageRow) => `runtime-image:${row.image_id}`;
const probeKey = (row: ImageRow) => `runtime-image-probe:${row.image_id}`;
const builderIntent = (row: ImageRow): BuilderVmIntent => ({ purpose: "runtime-image",
  source: { kind: "base", baseImageId: row.base_image_id }, name: `zeros-v2-rtimg-${row.runtime_id.slice(3, 15)}`,
  operationKey: builderKey(row), ttlSeconds: 1800 });
const probeIntent = (row: ImageRow): BuilderVmIntent => ({ purpose: "runtime-image",
  source: { kind: "image", imageId: row.image_id }, name: `zeros-v2-rtimg-probe-${row.runtime_id.slice(3, 15)}`,
  operationKey: probeKey(row), ttlSeconds: 1800 });

/** Consumers lock a ready image inside the transaction that records it with
 * their builder intent. Retirement's row lock conflicts with this share lock,
 * so a retiring image is never newly chosen. Revocable registry rows are
 * already locked by the caller's runtime selection. */
export async function lockReadyRuntimeImage(tx: Tx, input: {
  channel: RuntimeImageChannel; runtimeId: string; baseImageId: string; baseCompatibilityId: string;
  accountScope: string; billingOrg: string;
}): Promise<{ imageId: string; snapshotName: string } | null> {
  const row = (await tx.query<{ image_id: string; snapshot_name: string }>(`SELECT image.image_id,image.snapshot_name
    FROM cloud_runtime_images image
    JOIN cloud_runtime_bundles bundle USING (runtime_id)
    JOIN cloud_runtime_base_images base USING (base_image_id, base_compatibility_id)
    JOIN cloud_runtime_base_contracts contract USING (base_compatibility_id)
    WHERE image.channel=$1 AND image.runtime_id=$2 AND image.base_image_id=$3 AND image.base_compatibility_id=$4
      AND image.account_scope=$5 AND lower(image.billing_org)=lower($6) AND image.state='ready'
      AND bundle.revoked_at IS NULL AND base.revoked_at IS NULL AND contract.revoked_at IS NULL AND base.provider='boat'
    FOR SHARE OF image`, [input.channel, input.runtimeId, input.baseImageId, input.baseCompatibilityId,
    input.accountScope, input.billingOrg])).rows[0];
  if (!row || !RUNTIME_IMAGE_ID_PATTERN.test(row.image_id) || !NAMED_SNAPSHOT_PATTERN.test(row.snapshot_name)) return null;
  return { imageId: row.image_id, snapshotName: row.snapshot_name };
}

// The frozen TCB helper also reports internal timeouts and OS errors as
// tcb_modified, so a consumer's TCB failure is not withdrawal evidence.
export type RuntimeImageQuarantineCheck = "runtime_identity" | "base_compatibility" | "snapshot_missing";
/** Withdraw a ready image after deterministic evidence that it cannot serve
 * its pinned runtime. Publication evidence stays; the name is deleted only
 * once no builder that recorded the image can still create from it. */
export async function quarantineRuntimeImage(pool: pg.Pool, imageId: string, check: RuntimeImageQuarantineCheck): Promise<boolean> {
  if (!RUNTIME_IMAGE_ID_PATTERN.test(imageId)) return false;
  return withSystemTx(pool, async tx => (await tx.query(`UPDATE cloud_runtime_images
    SET state='retiring',retire_requested_at=clock_timestamp(),diagnostic=$2 WHERE image_id=$1 AND state='ready'`,
  [imageId, JSON.stringify(failure("runtime", check, "build"))])).rowCount === 1);
}

// Boat's free-text failure detail is never retained.
const namedSnapshotSchema = z.object({
  name: z.string().regex(NAMED_SNAPSHOT_PATTERN),
  status: z.enum(["saving", "ready", "failed"]),
  sourceSandboxId: z.string().optional(),
  snapshotId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).optional(),
  sizeBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type RuntimeImageSnapshot = z.infer<typeof namedSnapshotSchema>;
export interface RuntimeImageSnapshots {
  /** `in_progress` is Boat's documented conflict for a save still running under the name. */
  save(sandboxId: string, name: string): Promise<"saving" | "in_progress">;
  get(name: string): Promise<RuntimeImageSnapshot | null>;
  /** `gone` only after a following read confirms the name no longer exists. */
  remove(name: string): Promise<"gone" | "in_progress">;
}

export class BoatRuntimeImageSnapshots implements RuntimeImageSnapshots {
  constructor(private readonly client: Pick<BoatApiClient, "request">) {}
  async save(sandboxId: string, name: string) {
    if (!BOAT_RESOURCE_ID_PATTERN.test(sandboxId) || !NAMED_SNAPSHOT_PATTERN.test(name)) reject("save", "input_schema");
    try {
      const reply = await this.client.request("/named-snapshots", { method: "POST", body: { sandboxId, name }, timeoutMs: 60_000 });
      const parsed = namedSnapshotSchema.safeParse(reply.snapshot);
      if (!parsed.success || parsed.data.name !== name || parsed.data.status !== "saving") reject("save", "provider_response");
      return "saving" as const;
    } catch (error) {
      if (error instanceof CloudProviderError && error.httpStatus === 409) return "in_progress" as const;
      throw error;
    }
  }
  async get(name: string) {
    if (!NAMED_SNAPSHOT_PATTERN.test(name)) reject("save", "input_schema");
    try {
      const reply = await this.client.request(`/named-snapshots/${name}`, { timeoutMs: 30_000 });
      const parsed = namedSnapshotSchema.safeParse(reply.snapshot);
      if (!parsed.success || parsed.data.name !== name) reject("save", "provider_response");
      return parsed.data;
    } catch (error) {
      if (error instanceof CloudProviderError && error.code === "provider_not_found") return null;
      throw error;
    }
  }
  async remove(name: string) {
    if (!NAMED_SNAPSHOT_PATTERN.test(name)) reject("retire", "input_schema");
    try {
      await this.client.request(`/named-snapshots/${name}`, { method: "DELETE", confirmDelete: name, timeoutMs: 60_000 });
    } catch (error) {
      if (error instanceof CloudProviderError && error.httpStatus === 409) return "in_progress" as const;
      if (!(error instanceof CloudProviderError && error.code === "provider_not_found")) throw error;
    }
    return (await this.get(name)) === null ? "gone" as const : "in_progress" as const;
  }
}

/** Produces this control plane's runtime images: a builder from the approved
 * base installs the selected runtime, stops with a confirmed snapshot, and is
 * saved under a fresh name; a cold probe from that name must boot the runtime
 * and pass the full registry-pinned TCB check before publication. Cleanup of
 * builder and probe precedes publication, as for qualification. A disabled
 * worker still reconciles and retires what it already started. */
export class RuntimeImageWorker {
  private pending: Promise<void> | null = null;
  private readonly scheduler: CloudWorkerScheduler;
  private readonly maintenanceBatchSize: number;
  private retirementCursor: string | null = null;
  private moreWork = false;
  private sweepPasses = 0;
  private readonly checked = new Map<string, number>();
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  constructor(private readonly options: {
    pool: pg.Pool; enabled: boolean; channel: RuntimeImageChannel; mode: CloudRuntimeQualificationMode;
    accountScope: string; billingOrg: string; vms: CloudBuilderVms; operations: BuilderVmOperationStore;
    artifacts: RuntimeArtifactStore; snapshots: RuntimeImageSnapshots;
    baseRollout?: CloudRuntimeBaseRollout;
    intervalMs?: number; maintenanceBatchSize?: number; now?: () => number; wait?: (ms: number) => Promise<void>;
  }) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.maintenanceBatchSize = options.maintenanceBatchSize ?? 16;
    if (!Number.isSafeInteger(this.maintenanceBatchSize) || this.maintenanceBatchSize < 1 || this.maintenanceBatchSize > 100)
      throw new Error("runtime image maintenance configuration is invalid");
    this.scheduler = new CloudWorkerScheduler(options.intervalMs ?? 300_000, async periodic => {
      this.sweepPasses = periodic ? 1 : this.sweepPasses + 1;
      await this.tick();
    }, () => console.warn("[cloud-runtime] image_tick_failed"),
    async () => this.moreWork && this.sweepPasses < 4 ? 100 : null,
    { jitter: options.intervalMs === undefined });
  }

  tick(): Promise<void> {
    if (!this.pending) this.pending = this.work().finally(() => { this.pending = null; });
    return this.pending;
  }
  start(): () => Promise<void> {
    this.scheduler.start();
    return async () => { await this.scheduler.stop(); await this.pending?.catch(() => {}); };
  }
  notify(): void { this.scheduler.notify(); }

  private async work() {
    this.moreWork = false;
    await this.retire();
    const claimed = await this.claim();
    if (!claimed) return;
    if (claimed.reconcile) await this.abandon(claimed.row, failure("reconcile", "timeout"));
    else await this.produce(claimed.row);
  }

  /** Rows, journals and names of another provider account are never touched. */
  private scope(): [RuntimeImageChannel, string, string] {
    return [this.options.channel, this.options.accountScope, this.options.billingOrg];
  }

  /** The global claim lock serializes these attempts across replicas. Rotate
   * by persisted attempt time so neither explicit target monopolizes the slot. */
  private async baseTargets(tx: Tx): Promise<Array<string | undefined>> {
    const policy = this.options.baseRollout;
    if (!policy) return [undefined];
    const targets = [policy.defaultBaseImageId, ...(policy.candidate ? [policy.candidate.baseImageId] : [])];
    if (targets.length === 1) return targets;
    const attempts = (await tx.query<{ base_image_id: string; attempted_at: Date }>(`SELECT base_image_id,max(created_at) AS attempted_at
      FROM cloud_runtime_images WHERE channel=$1 AND account_scope=$2 AND lower(billing_org)=lower($3)
        AND base_image_id=ANY($4::text[]) GROUP BY base_image_id`, [...this.scope(), targets])).rows;
    const times = new Map(attempts.map(row => [row.base_image_id, row.attempted_at.getTime()]));
    return targets.sort((a, b) => (times.get(a) ?? 0) - (times.get(b) ?? 0));
  }

  private async claim(): Promise<{ row: ImageRow; reconcile: boolean } | null> {
    const { mode } = this.options, scope = this.scope();
    return withSystemTx(this.options.pool, async tx => {
      const lock = (await tx.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked /*lock_purpose='runtime-image-retirement'*/",
        [`cloud-runtime-image-producer:${scope[0]}:${scope[1]}`])).rows[0];
      if (!lock?.locked) return null;
      const building = (await tx.query<ImageRow>(`SELECT * FROM cloud_runtime_images
        WHERE channel=$1 AND account_scope=$2 AND lower(billing_org)=lower($3) AND state='building' FOR UPDATE`, scope)).rows[0];
      if (building) {
        const expired = (await tx.query<ImageRow>(`UPDATE cloud_runtime_images SET cleanup_lease_until=clock_timestamp()+$2*interval '1 millisecond'
          WHERE image_id=$1 AND deadline_at<=clock_timestamp() AND (cleanup_lease_until IS NULL OR cleanup_lease_until<=clock_timestamp())
          RETURNING *`, [building.image_id, CLEANUP_LEASE_MS])).rows[0];
        return expired ? { row: expired, reconcile: true } : null;
      }
      if (!this.options.enabled) return null;
      for (const baseImageId of await this.baseTargets(tx)) {
        const selected = await selectCloudRuntime(tx, mode, baseImageId);
        if (!selected) continue;
        const pair = [...scope, selected.pin.runtimeId, selected.pin.baseImageId];
        if ((await tx.query(`SELECT 1 FROM cloud_runtime_images WHERE channel=$1 AND account_scope=$2 AND lower(billing_org)=lower($3)
          AND runtime_id=$4 AND base_image_id=$5 AND state='ready'`, pair)).rowCount) continue;
        const failed = (await tx.query<{ attempts: string; recent: boolean }>(`SELECT count(*) AS attempts,
            coalesce(max(finished_at)>clock_timestamp()-$6*interval '1 millisecond',false) AS recent
          FROM cloud_runtime_images WHERE channel=$1 AND account_scope=$2 AND lower(billing_org)=lower($3)
            AND runtime_id=$4 AND base_image_id=$5 AND state='failed'`, [...pair, RETRY_AFTER_FAILURE_MS])).rows[0]!;
        if (Number(failed.attempts) >= MAX_FAILED_ATTEMPTS || failed.recent) continue;
        const name = `zeros-rtimg-${scope[0]}-${selected.pin.runtimeId.slice(3, 15)}-${randomBytes(4).toString("hex")}`;
        const row = (await tx.query<ImageRow>(`INSERT INTO cloud_runtime_images
          (channel,account_scope,billing_org,runtime_id,base_image_id,base_compatibility_id,snapshot_name,deadline_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8*interval '1 millisecond') RETURNING *`,
        [...pair, selected.pin.baseCompatibilityId, name, RUN_MS])).rows[0]!;
        // The selected base row is locked by selection; prepare without provider I/O.
        await prepareBuilderVmOperation(this.options.operations, builderIntent(row), async () => builderVmBaseSnapshot(selected.base.imageRef), tx);
        return { row, reconcile: false };
      }
      return null;
    });
  }

  private async produce(row: ImageRow) {
    const { vms } = this.options;
    let stage = "allocate";
    let result: ClosedDiagnostic;
    try {
      const builder = await vms.create(builderIntent(row));
      await this.record(row, "builder_sandbox_id", builder.sandboxId);
      stage = "base_status";
      const base = await vms.waitForBase(builder);
      if (base.baseCompatibilityId !== row.base_compatibility_id || base.currentRuntimeId !== null) reject(stage, "base_compatibility");
      stage = "install_runtime";
      await this.install(row, builder);
      stage = "runtime_status";
      const status = await vms.baseStatus(builder);
      if (status.baseCompatibilityId !== row.base_compatibility_id || status.currentRuntimeId !== row.runtime_id ||
          status.hostState !== "idle") reject(stage, "runtime_identity");
      stage = "capture";
      // The name saves this stop's completed snapshot, never a later disk.
      await vms.stop(builder, { requireSnapshot: true, timeoutMs: this.bound(row, 30 * 60_000) });
      stage = "save";
      await this.record(row, "snapshot_requested_at", null);
      await this.save(row, builder.sandboxId);
      stage = "probe";
      const probe = await this.probe(row);
      const restored = await vms.waitForBase(probe);
      if (restored.baseCompatibilityId !== row.base_compatibility_id || restored.currentRuntimeId !== row.runtime_id ||
          restored.hostState !== "idle") reject(stage, "runtime_identity");
      stage = "verify";
      await this.verify(row, probe);
      result = { schema: "zeros.diagnostic/v1", component: "qualification", stage: "verify", ok: true,
        exitCode: 0, timedOut: false, failedChecks: [] };
    } catch (error) {
      result = error instanceof RuntimeImageFailure ? error.diagnostic : failure(stage, error instanceof BuilderVmError ? error.check : "operation_failed");
    }
    if (result.ok) {
      if (!await this.cleanupVms(row)) return this.defer(row);
      const published = await this.publish(row);
      if (published === "published") return;
      result = failure("publish", published === "late" ? "timeout" : "runtime_ineligible");
    }
    await this.abandon(row, result);
  }

  private bound(row: ImageRow, limit: number) {
    const remaining = row.deadline_at.getTime() - this.now();
    if (remaining <= 1000) reject("admit", "timeout");
    return Math.min(limit, remaining);
  }

  private async admitted(row: ImageRow): Promise<{ descriptor: RuntimeDescriptor; objectKey: string }> {
    return withSystemTx(this.options.pool, async tx => {
      const bundle = (await tx.query<Bundle>(`SELECT bundle.* FROM cloud_runtime_bundles bundle
        JOIN cloud_runtime_base_images base ON base.base_image_id=$2 AND base.base_compatibility_id=$3
        JOIN cloud_runtime_base_contracts contract ON contract.base_compatibility_id=base.base_compatibility_id
        JOIN cloud_runtime_images image ON image.image_id=$4 AND image.runtime_id=bundle.runtime_id AND image.state='building'
        WHERE bundle.runtime_id=$1 AND bundle.revoked_at IS NULL AND base.revoked_at IS NULL AND contract.revoked_at IS NULL
          AND image.deadline_at>clock_timestamp() FOR SHARE OF bundle,base,contract`,
      [row.runtime_id, row.base_image_id, row.base_compatibility_id, row.image_id])).rows[0];
      if (!bundle) reject("admit", "runtime_ineligible");
      const parsed = RuntimeDescriptorSchema.safeParse({ runtimeId: bundle.runtime_id, manifestSha256: bundle.manifest_sha256,
        archiveSha256: bundle.archive_sha256, archiveBytes: Number(bundle.archive_bytes), expandedBytes: Number(bundle.expanded_bytes),
        sourceCommit: bundle.source_commit, nodeModulesAbi: bundle.node_modules_abi,
        bootstrapProtocolVersion: bundle.bootstrap_protocol_version, engineProtocolVersion: bundle.engine_protocol_version });
      if (!parsed.success) reject("admit", "runtime_descriptor");
      return { descriptor: parsed.data, objectKey: bundle.object_key };
    });
  }

  private async install(row: ImageRow, builder: BuilderVm) {
    const runtime = await this.admitted(row);
    const artifact = await this.options.artifacts.presignGet(runtime.objectKey, 900);
    const payload = RuntimeInstallInputSchema.safeParse({ schema: "zeros.runtime-install/v1", purpose: "build", runtime: runtime.descriptor, artifact });
    if (!payload.success || Date.parse(artifact.expiresAt) <= this.now() || Date.parse(artifact.expiresAt) > this.now() + 900_000)
      reject("install_runtime", "artifact_expired");
    const input = Buffer.from(Buffer.from(JSON.stringify(payload.data)).toString("base64url"));
    try {
      const installed = await this.options.vms.runFixed(builder, "install-runtime", input, { timeoutMs: this.bound(row, 600_000) });
      if (!installed.diagnostic) reject("install_runtime", "diagnostic_missing");
      if (installed.exitCode !== 0 || !installed.diagnostic.ok) throw new RuntimeImageFailure(installed.diagnostic);
    } finally { input.fill(0); }
  }

  /** The stopped source keeps one last snapshot, so a repeated save under the
   * same fresh name stores the same disk. An ambiguous save is read back. */
  private async save(row: ImageRow, sandboxId: string) {
    const deadline = this.now() + this.bound(row, 20 * 60_000);
    let missingSince: number | null = null;
    let saved = false;
    for (;;) {
      if (this.now() >= deadline) reject("save", "timeout");
      if (!saved) {
        try { await this.options.snapshots.save(sandboxId, row.snapshot_name); }
        catch (error) { if (!(error instanceof CloudProviderError && error.retryable)) throw error; }
        // Accepted or ambiguous alike: read back, and resend only after the grace.
        saved = true;
      }
      const snapshot = await this.options.snapshots.get(row.snapshot_name);
      if (!snapshot) {
        missingSince ??= this.now();
        // Accepted saves become readable; a lost POST is resent after the grace.
        if (this.now() - missingSince >= SAVE_GRACE_MS) { saved = false; missingSince = null; }
      } else {
        missingSince = null;
        if (snapshot.sourceSandboxId !== undefined && snapshot.sourceSandboxId !== sandboxId) reject("save", "snapshot_identity");
        if (snapshot.status === "failed") reject("save", "snapshot_failed");
        if (snapshot.status === "ready") {
          if (!snapshot.snapshotId || !snapshot.sizeBytes) reject("save", "provider_response");
          await withSystemTx(this.options.pool, async tx => {
            const updated = await tx.query(`UPDATE cloud_runtime_images SET snapshot_id=$2,size_bytes=$3
              WHERE image_id=$1 AND state='building' AND (snapshot_id IS NULL OR (snapshot_id=$2 AND size_bytes=$3))`,
            [row.image_id, snapshot.snapshotId, snapshot.sizeBytes]);
            if (updated.rowCount !== 1) reject("save", "snapshot_identity");
          });
          row.snapshot_id = snapshot.snapshotId!;
          row.size_bytes = String(snapshot.sizeBytes);
          return;
        }
      }
      await this.wait(Math.min(5000, Math.max(1, deadline - this.now())));
    }
  }

  /** The probe is journalled with a resolver for exactly this building row's
   * saved name. Ordinary image resolution stays limited to ready images. */
  private async probe(row: ImageRow): Promise<BuilderVm> {
    await withSystemTx(this.options.pool, async tx => prepareBuilderVmOperation(this.options.operations, probeIntent(row), async source => {
      const image = (await tx.query<{ snapshot_name: string }>(`SELECT snapshot_name FROM cloud_runtime_images
        WHERE image_id=$1 AND state='building' AND snapshot_id IS NOT NULL AND channel=$2 AND account_scope=$3
          AND lower(billing_org)=lower($4) AND deadline_at>clock_timestamp() FOR SHARE`,
      [source.kind === "image" ? source.imageId : null, this.options.channel, this.options.accountScope, this.options.billingOrg])).rows[0];
      if (!image) reject("probe", "source_unavailable");
      return image.snapshot_name;
    }, tx));
    const probe = await this.options.vms.create(probeIntent(row));
    await this.record(row, "probe_sandbox_id", probe.sandboxId);
    return probe;
  }

  private async verify(row: ImageRow, probe: BuilderVm) {
    const input = Buffer.from(JSON.stringify({ schema: "zeros.computer-tcb-input/v1", buildId: row.image_id, workerFence: 1,
      runtimeId: row.runtime_id, baseCompatibilityId: row.base_compatibility_id, action: "baseline" }));
    const checked = await this.options.vms.runFixed(probe, "computer:verify-tcb", input, { timeoutMs: this.bound(row, 600_000) });
    const diagnostic = checked.diagnostic;
    if (!diagnostic) reject("verify", "diagnostic_missing");
    if (checked.exitCode !== 0 || !diagnostic.ok) throw new RuntimeImageFailure(diagnostic);
    let proof: unknown = null;
    try {
      const lines = checked.stdout.trim().split("\n");
      if (lines.length === 2) proof = JSON.parse(lines[0]!);
    } catch { /* Only the helper's closed result is accepted. */ }
    const value = proof as Record<string, unknown> | null;
    if (!value || value.schema !== "zeros.computer-tcb/v1" || value.buildId !== row.image_id || value.runtimeId !== row.runtime_id ||
        value.baseCompatibilityId !== row.base_compatibility_id || typeof value.protectedContractDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.protectedContractDigest)) reject("verify", "tcb_modified");
    await this.record(row, "verified_at", null);
  }

  private async record(row: ImageRow, column: "builder_sandbox_id" | "probe_sandbox_id" | "snapshot_requested_at" | "verified_at", value: string | null) {
    await withSystemTx(this.options.pool, async tx => {
      const sandbox = column === "builder_sandbox_id" || column === "probe_sandbox_id";
      const updated = sandbox
        ? await tx.query(`UPDATE cloud_runtime_images SET ${column}=$2 WHERE image_id=$1 AND state='building'
            AND (${column} IS NULL OR ${column}=$2)`, [row.image_id, value])
        : await tx.query(`UPDATE cloud_runtime_images SET ${column}=coalesce(${column},clock_timestamp())
            WHERE image_id=$1 AND state='building'`, [row.image_id]);
      if (updated.rowCount !== 1) reject("admit", "timeout");
    });
    if (column === "builder_sandbox_id") row.builder_sandbox_id = value;
    else if (column === "probe_sandbox_id") row.probe_sandbox_id = value;
    else if (column === "snapshot_requested_at") row.snapshot_requested_at ??= new Date(this.now());
    else row.verified_at ??= new Date(this.now());
  }

  /** An unknown create is replayed with its exact journalled key and body
   * solely to recover its identity and delete it. */
  private async cleanupVms(row: ImageRow): Promise<boolean> {
    try {
      for (const key of [probeKey(row), builderKey(row)]) {
        let operation = await this.options.operations.find(key);
        if (!operation) continue;
        if (!operation.sandbox_id && await this.options.operations.closeUnallocatedCreate(key)) continue;
        if (!operation.sandbox_id && operation.create_dispatched_at) {
          try { await this.options.vms.create(operation.intent); } catch { /* May bind before failing readiness. */ }
          operation = await this.options.operations.find(key);
        }
        if (!operation?.sandbox_id) {
          if (await this.options.operations.closeUnallocatedCreate(key)) continue;
          return false;
        }
        await this.options.vms.delete({ sandboxId: operation.sandbox_id, purpose: "runtime-image", operationKey: key });
      }
      return true;
    } catch { return false; }
  }

  private async defer(row: ImageRow) {
    // Reconciliation takes over at once: the deadline may only move earlier.
    await withSystemTx(this.options.pool, async tx => {
      await tx.query(`UPDATE cloud_runtime_images SET diagnostic=$2,deadline_at=LEAST(deadline_at,clock_timestamp()),cleanup_lease_until=NULL
        WHERE image_id=$1 AND state='building'`, [row.image_id, JSON.stringify(failure("cleanup", "cleanup_unconfirmed"))]);
    });
  }

  /** Registry rows are locked before the image row, in consumer order. */
  private async pinned(tx: Tx, row: Pick<ImageRow, "runtime_id" | "base_image_id" | "base_compatibility_id">) {
    const bundle = (await tx.query<{ manifest_sha256: string; engine_protocol_version: number }>(
      `SELECT manifest_sha256,engine_protocol_version FROM cloud_runtime_bundles WHERE runtime_id=$1`, [row.runtime_id])).rows[0];
    return !!bundle && !!await loadPinnedCloudRuntime(tx, { runtimeId: row.runtime_id, manifestSha256: bundle.manifest_sha256,
      baseImageId: row.base_image_id, baseCompatibilityId: row.base_compatibility_id, profile: "zeros-cloud-worker-v4",
      engineProtocolVersion: bundle.engine_protocol_version }, this.options.mode);
  }

  private async publish(row: ImageRow): Promise<"published" | "ineligible" | "late"> {
    try {
      return await withSystemTx(this.options.pool, async tx => {
        if (!await this.pinned(tx, row)) return "ineligible";
        // A late success must never race overdue reconciliation of its name.
        return (await tx.query(`UPDATE cloud_runtime_images SET state='ready',ready_at=clock_timestamp(),
            cleanup_confirmed_at=clock_timestamp(),cleanup_lease_until=NULL,diagnostic=NULL
          WHERE image_id=$1 AND state='building' AND verified_at IS NOT NULL AND snapshot_id IS NOT NULL
            AND deadline_at>clock_timestamp() AND cleanup_lease_until IS NULL`, [row.image_id])).rowCount === 1 ? "published" : "late";
      });
    } catch { return "late"; }
  }

  /** Failure and overdue reconciliation: fence publication, delete the VMs,
   * then any name this attempt may have saved, and only then record the
   * failure. A publication whose reply was lost is re-read here, so a ready
   * image's name is never deleted outside retirement. */
  private async abandon(row: ImageRow, result: ClosedDiagnostic) {
    const fenced = await withSystemTx(this.options.pool, async tx => (await tx.query(`UPDATE cloud_runtime_images
      SET cleanup_lease_until=GREATEST(coalesce(cleanup_lease_until,clock_timestamp()),clock_timestamp()+$2*interval '1 millisecond')
      WHERE image_id=$1 AND state='building'`, [row.image_id, CLEANUP_LEASE_MS])).rowCount === 1);
    if (!fenced) return;
    let cleaned = await this.cleanupVms(row);
    if (cleaned && row.snapshot_requested_at) {
      try { cleaned = await this.options.snapshots.remove(row.snapshot_name) === "gone"; }
      catch { cleaned = false; }
    }
    if (!cleaned) return this.defer(row);
    await withSystemTx(this.options.pool, async tx => {
      await tx.query(`UPDATE cloud_runtime_images SET state='failed',finished_at=clock_timestamp(),cleanup_confirmed_at=clock_timestamp(),
        cleanup_lease_until=NULL,diagnostic=$2 WHERE image_id=$1 AND state='building'`, [row.image_id, JSON.stringify(result)]);
    });
  }

  /** Keep the newest ready images (one per target during a two-base rollout);
   * withdraw older or revoked ones, then delete
   * a withdrawn name only once no Computer builder that recorded it remains
   * unstopped and uncleaned. Failed or cancelled builds can still replay an
   * unknown create, so their state never shortens this wait. */
  private async retire() {
    const { pool } = this.options, scope = this.scope();
    const readyLimit = KEEP_READY + this.maintenanceBatchSize;
    const ready = (await withSystemTx(pool, async tx => tx.query<ImageRow>(`SELECT * FROM cloud_runtime_images
      WHERE channel=$1 AND account_scope=$2 AND lower(billing_org)=lower($3) AND state='ready'
      ORDER BY ready_at DESC,image_id LIMIT $4`, [...scope, readyLimit]))).rows;
    this.moreWork ||= ready.length === readyLimit;
    // Only usable images count toward the newest kept.
    let kept = 0;
    const keptImages: ImageRow[] = [];
    const policy = this.options.baseRollout;
    const targetSlots = policy?.candidate ? new Set([policy.defaultBaseImageId, policy.candidate.baseImageId]) : null;
    for (const image of ready) {
      await withSystemTx(pool, async tx => {
        const usable = await this.pinned(tx, image);
        const hasSlot = targetSlots ? targetSlots.has(image.base_image_id) : kept < KEEP_READY;
        if (usable && hasSlot) { kept++; targetSlots?.delete(image.base_image_id); keptImages.push(image); return; }
        // The row lock waits for any consumer claim holding its share lock.
        if (!(await tx.query(`SELECT 1 FROM cloud_runtime_images WHERE image_id=$1 AND state='ready' FOR UPDATE`, [image.image_id])).rowCount) return;
        await tx.query(`UPDATE cloud_runtime_images SET state='retiring',retire_requested_at=clock_timestamp(),diagnostic=$2
          WHERE image_id=$1 AND state='ready'`, [image.image_id, JSON.stringify(failure("retire", usable ? "superseded" : "runtime_revoked"))]);
      });
    }
    await this.checkPresence(keptImages);
    // Evaluated after the withdrawal committed, so every claim that chose the
    // image is visible here.
    const retiring = (await withSystemTx(pool, async tx => tx.query<{ image_id: string; snapshot_name: string }>(`SELECT image.image_id,image.snapshot_name
      FROM cloud_runtime_images image WHERE image.channel=$1 AND image.account_scope=$2 AND lower(image.billing_org)=lower($3)
        AND ($4::uuid IS NULL OR image.image_id>$4)
        AND image.state='retiring' AND NOT EXISTS (
        SELECT 1 FROM cloud_computer_templates template WHERE template.builder_source_image_id=image.image_id
          AND template.stopped_at IS NULL AND template.cleanup_confirmed_at IS NULL)
      ORDER BY image.image_id LIMIT $5`, [...scope, this.retirementCursor, this.maintenanceBatchSize]))).rows;
    // Advance past unconfirmed removals too, so one provider failure cannot
    // monopolize the next bounded page. A later sweep wraps and retries it.
    this.moreWork ||= retiring.length === this.maintenanceBatchSize ||
      (this.retirementCursor !== null && retiring.length === 0);
    this.retirementCursor = retiring.length === this.maintenanceBatchSize ? retiring.at(-1)!.image_id : null;
    for (const image of retiring) {
      try {
        if (await this.options.snapshots.remove(image.snapshot_name) !== "gone") continue;
        await withSystemTx(pool, async tx => {
          await tx.query(`UPDATE cloud_runtime_images SET state='retired',retired_at=clock_timestamp()
            WHERE image_id=$1 AND state='retiring'`, [image.image_id]);
        });
      } catch { console.warn("[cloud-runtime] image_retirement_deferred"); }
    }
  }

  /** Boat may prune an unpaid name above the free allowance. A missing ready
   * name is withdrawn so later builds fall back to the base. */
  private async checkPresence(ready: ImageRow[]) {
    for (const id of this.checked.keys()) if (!ready.some(image => image.image_id === id)) this.checked.delete(id);
    for (const image of ready) {
      if (this.now() - (this.checked.get(image.image_id) ?? 0) < PRESENCE_INTERVAL_MS) continue;
      try {
        const snapshot = await this.options.snapshots.get(image.snapshot_name);
        this.checked.set(image.image_id, this.now());
        if (!snapshot || snapshot.status !== "ready") await quarantineRuntimeImage(this.options.pool, image.image_id, "snapshot_missing");
      } catch { console.warn("[cloud-runtime] image_presence_unconfirmed"); }
    }
  }
}

export function createRuntimeImageWorker(config: Config, pool: pg.Pool, artifacts: RuntimeArtifactStore | null) {
  const cloud = config.cloudWorkspaces;
  const channel = runtimeImageChannel(config.deploymentChannel);
  if (!channel || cloud?.provider !== "boat" || !cloud.boat || !artifacts) return null;
  const operations = new DatabaseBuilderVmOperationStore(pool, cloud.boat.accountScope);
  const client = new BoatApiClient({ apiKey: cloud.apiKey, billingOrg: cloud.boat.billingOrg, timeoutMs: 45_000 });
  const vms = new BoatCloudBuilderVms({ client, billingOrg: cloud.boat.billingOrg, operations, resolveSource: builderVmSourceResolver(pool),
    resolveDisplayName: intent => boatRuntimeDisplayName(channel, intent.source.kind === "image" ? "check" : "build") });
  return new RuntimeImageWorker({ pool, enabled: cloud.runtime?.imagesEnabled === true, channel,
    ...(cloud.runtime?.baseRollout ? { baseRollout: cloud.runtime.baseRollout } : {}),
    mode: cloud.runtime?.qualificationMode ?? "full", accountScope: cloud.boat.accountScope, billingOrg: cloud.boat.billingOrg,
    vms, operations, artifacts, snapshots: new BoatRuntimeImageSnapshots(client),
    ...workerPollingOptions(config.workerPollIntervalsMs, "runtimeImages") });
}

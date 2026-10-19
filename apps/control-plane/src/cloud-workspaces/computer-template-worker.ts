import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx, type Tx } from "../db.js";
import { ROLLOUT_FLAGS_OFF, type RolloutFlagReader } from "../rollout-flags.js";
import { lockCloudComputerOrganization } from "./computer-identity.js";
import { CloudComputerBuildQualificationSchema } from "./computer-build-qualification-contract.js";
import { computerBuildQualificationBase, readComputerBuildQualificationCheckpoint, recordComputerBuildQualification,
  type ComputerBuildQualificationCheckpoint } from "./computer-build-qualifications.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";
import { CloudWorkerScheduler } from "./worker-scheduler.js";
import {
  DatabaseCloudComputerV2Service,
  type CloudComputerV2Claim,
} from "./computer-v2.js";
import {
  CloudComputerV2RepositoryManifestSchema,
  type CloudComputerV2BuildError,
  type CloudComputerV2BuildStage,
} from "./computer-v2-contract.js";
import {
  ComputerTemplateJournal,
  type TemplateAllocation,
} from "./computer-template-capacity.js";
import { ComputerTemplateLogRedactor } from "./computer-template-logs.js";
import { BuilderVmError, computerTemplateBuilderIntent } from "./computer-template-boat.js";
import { quarantineRuntimeImage, type RuntimeImageChannel } from "./runtime-images.js";
import { parseBuilderDiagnostic, type ClosedDiagnostic } from "./cloud-builder-commands.js";
import type { ComputerTemplateSnapshotLifecycle } from "./computer-template-snapshots.js";
import type {
  BuilderFixedCommand,
  BuilderVm,
  BuilderVmOperations,
  CloudBuilderVms,
  ComputerTemplateRuntime,
} from "./computer-template-boat.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
// Recording the capture and completing the build must finish before the
// build deadline, so the template stop leaves this much of it unused.
const CAPTURE_COMPLETION_MS = 60_000;
const NAMED_CAPTURE_MS = 5 * 60_000;
const TcbResult = z
  .object({
    schema: z.literal("zeros.computer-tcb/v1"),
    buildId: z.string().uuid(),
    baseCompatibilityId: z.string(),
    runtimeId: z.string(),
    protectedContractDigest: hash,
  })
  .strict();
const RepositoriesResult = z
  .object({
    schema: z.literal("zeros.computer-repositories/v1"),
    buildId: z.string().uuid(),
    repositories: CloudComputerV2RepositoryManifestSchema,
  })
  .strict();
const InstallResult = z
  .object({
    schema: z.literal("zeros.computer-install/v1"),
    buildId: z.string().uuid(),
    workerFence: z.number().int().positive().safe(),
    state: z.enum(["running", "succeeded", "failed"]),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    truncated: z.boolean(),
    chunks: z
      .array(
        z
          .object({
            seq: z.number().int().positive().safe(),
            stream: z.enum(["stdout", "stderr"]),
            text: z
              .string()
              .refine((value) => Buffer.byteLength(value) <= 8192),
          })
          .strict(),
      )
      .max(8),
    nextAfter: z.number().int().nonnegative().safe(),
  })
  .strict();
const SanitationResult = z
  .object({
    schema: z.literal("zeros.computer-sanitation/v1"),
    buildId: z.string().uuid(),
    clean: z.literal(true),
    manifestSha256: hash,
  })
  .strict();
const BuildProducerResult = z.discriminatedUnion("mode", [
  z.object({ schema: z.literal("zeros.computer-build-producer/v1"), mode: z.literal("full") }).strict(),
  z.object({ schema: z.literal("zeros.computer-build-producer/v1"), mode: z.literal("build"),
    evidence: CloudComputerBuildQualificationSchema }).strict(),
]);

class BuildFailure extends Error {
  constructor(readonly code: CloudComputerV2BuildError, readonly diagnostic: ClosedDiagnostic | null = null) {
    super(code);
  }
}
class BuildHandoff extends Error {}
export type ComputerTemplateWorkerDependencies = {
  pool: pg.Pool;
  service: DatabaseCloudComputerV2Service;
  vms: CloudBuilderVms;
  operations: BuilderVmOperations;
  snapshots: ComputerTemplateSnapshotLifecycle;
  github: {
    mintContentsRead(input: {
      installationId: number;
      repositoryId: number;
    }): Promise<{ token: string; expiresAtMs: number }>;
    revoke(token: string): Promise<void>;
  };
  runtime: {
    select(tx: Tx, organizationId: string): Promise<ComputerTemplateRuntime | null>;
    load(tx: Tx, pin: { baseImageId: string; runtimeId: string }): Promise<ComputerTemplateRuntime | null>;
    validate(tx: Tx, runtime: ComputerTemplateRuntime): Promise<boolean>;
  };
  artifacts: {
    presignGet(
      key: string,
      ttlSeconds: number,
    ): Promise<{ url: string; expiresAt: string }>;
  };
  accountScope: string;
  billingOrg: string;
  flags?: RolloutFlagReader;
  channel?: RuntimeImageChannel;
  qualificationMode?: CloudRuntimeQualificationMode;
  runtimeImageChannel?: RuntimeImageChannel;
  maxConcurrentBuilds?: number;
  pollMs?: number;
  intervalMs?: number;
  namePrefix?: string;
};

function result<T>(
  schema: z.ZodType<T>,
  stdout: string,
  error: CloudComputerV2BuildError,
): T {
  try {
    if (Buffer.byteLength(stdout) > 65_536) throw new Error();
    const lines = stdout.trim().split("\n");
    if (
      lines.length === 2 &&
      JSON.parse(lines[1]!).schema === "zeros.diagnostic/v1"
    )
      lines.pop();
    if (lines.length !== 1) throw new Error();
    return schema.parse(JSON.parse(lines[0]!));
  } catch {
    throw new BuildFailure(error);
  }
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );
}

export class ComputerTemplateWorker {
  private readonly journal: ComputerTemplateJournal;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly scheduler: CloudWorkerScheduler;
  private fence = Date.now();
  private ticking: Promise<void> | null = null;
  private stopping = false;
  private snapshotSweepAt = 0;
  constructor(private readonly deps: ComputerTemplateWorkerDependencies) {
    this.journal = new ComputerTemplateJournal(
      deps.pool,
      deps.accountScope,
      deps.billingOrg,
    );
    this.concurrency = z
      .number()
      .int()
      .min(1)
      .max(32)
      .parse(deps.maxConcurrentBuilds ?? 2);
    this.pollMs = z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .parse(deps.pollMs ?? 1000);
    const intervalMs = z.number().int().min(100).max(300_000).parse(deps.intervalMs ?? 60_000);
    this.scheduler = new CloudWorkerScheduler(intervalMs, () => this.tick(), () => {
      // No provider exception, script output or stdin in infrastructure logs.
      console.error("[computer-template-worker] reconciliation_failed");
    }, () => this.journal.readNextDelayMs(this.concurrency), { readBeforeRun: true, jitter: deps.intervalMs === undefined });
  }
  start(): () => Promise<void> {
    this.scheduler.start();
    return async () => {
      this.stopping = true;
      await this.scheduler.stop();
      await this.ticking;
    };
  }
  notify(): void { this.scheduler.notify(); }
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.work();
    try {
      await this.ticking;
    } finally {
      this.ticking = null;
    }
  }
  private async work() {
    if (Date.now() - this.snapshotSweepAt >= 60_000) {
      await this.deps.snapshots.reconcile();
      this.snapshotSweepAt = Date.now();
    }
    await this.journal.fenceExpired();
    for (let index = 0; index < this.concurrency; index++) {
      const row = await this.journal.claimCleanup();
      if (!row) break;
      await this.cleanup(row);
    }
    const tasks: Array<() => Promise<void>> = [];
    for (let index = 0; index < this.concurrency && !this.stopping; index++) {
      let runtime: ComputerTemplateRuntime | null = null;
      const claim = await this.deps.service.claimNextBuild(++this.fence, {
        operations: this.deps.operations,
        accountScope: this.deps.accountScope,
        billingOrg: this.deps.billingOrg,
        ...(this.deps.runtimeImageChannel ? { runtimeImageChannel: this.deps.runtimeImageChannel } : {}),
        ...(this.deps.namePrefix ? { namePrefix: this.deps.namePrefix } : {}),
        selectRuntime: async (tx, organizationId) => {
          runtime = await this.deps.runtime.select(tx, organizationId);
          return runtime
            ? {
                baseImageId: runtime.baseImageId,
                runtimeId: runtime.descriptor.runtimeId,
              }
            : null;
        },
        loadRuntime: async (tx, pin) => {
          runtime = await this.deps.runtime.load(tx, pin);
          return runtime !== null && runtime.baseImageId === pin.baseImageId && runtime.descriptor.runtimeId === pin.runtimeId;
        },
      });
      if (!claim || !runtime) break;
      const pin: ComputerTemplateRuntime = runtime;
      tasks.push(() => this.build(claim, pin));
    }
    // A database failure on one build cannot prevent the others from draining.
    const outcomes = await Promise.allSettled(tasks.map((task) => task()));
    if (outcomes.some((outcome) => outcome.status === "rejected"))
      throw new Error("Computer build reconciliation failed");
  }
  private async guard(claim: CloudComputerV2Claim) {
    const authority = await this.journal.authority(
      claim.build.id,
      claim.workerFence,
    );
    if (!authority.active)
      throw new BuildFailure(
        authority.expired ? "build_timeout" : "build_failed",
      );
  }
  private qualificationScope(claim: CloudComputerV2Claim) {
    return { organizationId: claim.organizationId, buildId: claim.build.id, configId: claim.config.id,
      provider: "boat" as const, channel: this.deps.channel ?? "alpha", accountScope: this.deps.accountScope, billingOrg: this.deps.billingOrg };
  }
  private async qualificationTx<T>(claim: CloudComputerV2Claim, action: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await withSystemTx(this.deps.pool, async tx => {
        if (!(await tx.query(`SELECT id FROM organizations WHERE id=$1 AND NOT is_personal
          AND deleted_at IS NULL AND lifecycle_status='active' FOR SHARE`, [claim.organizationId])).rowCount)
          throw new BuildFailure("integrity_failed");
        await lockCloudComputerOrganization(tx, claim.organizationId);
        return action(tx);
      });
    } catch { throw new BuildFailure("integrity_failed"); }
  }
  private async qualificationCheckpoint(tx: Tx, claim: CloudComputerV2Claim, manifestSha256: string,
    required?: ComputerBuildQualificationCheckpoint | null) {
    const value = await readComputerBuildQualificationCheckpoint(tx, { ...this.qualificationScope(claim),
      workerFence: claim.workerFence, manifestSha256, qualificationMode: this.deps.qualificationMode ?? "full" });
    if (required && (value?.qualificationId !== required.qualificationId || value.evidenceSha256 !== required.evidenceSha256))
      throw new BuildFailure("integrity_failed");
    return value;
  }
  private async checkpoint(claim: CloudComputerV2Claim) {
    if (!this.stopping) return;
    await this.guard(claim);
    let applied: boolean;
    try {
      applied = await this.deps.service.handoffBuild(claim.build.id, claim.workerFence, claim.installProgress);
    } catch {
      // A lost commit reply is not a failed build. Only the durable checkpoint
      // permits adoption; an uncommitted handoff keeps the original deadline.
      console.error("[computer-template-worker] handoff_unconfirmed");
      throw new BuildHandoff();
    }
    if (!applied) {
      await this.guard(claim);
      throw new BuildFailure("build_failed");
    }
    throw new BuildHandoff();
  }
  private async stage(
    claim: CloudComputerV2Claim,
    stage: CloudComputerV2BuildStage,
  ) {
    await this.guard(claim);
    if (
      !(
        await this.deps.service.markBuildStage(
          claim.build.id,
          claim.workerFence,
          stage,
        )
      ).applied
    )
      throw new BuildFailure("build_failed");
    claim.build.stage = stage;
  }
  private async fixed(
    vm: BuilderVm,
    command: BuilderFixedCommand,
    value: unknown,
    error: CloudComputerV2BuildError,
    timeoutMs: number,
    component: string,
    stage: string,
  ) {
    let encoded = JSON.stringify(value);
    if (command === "install-runtime")
      encoded = Buffer.from(encoded).toString("base64url");
    const input = value === undefined ? undefined : Buffer.from(encoded);
    try {
      if (
        input &&
        input.length > (command === "install-runtime" ? 65_536 : 262_144)
      )
        throw new BuildFailure(error);
      const output = await this.deps.vms.runFixed(vm, command, input, {
        timeoutMs,
      });
      const diagnostic = output.diagnostic
        ? parseBuilderDiagnostic(JSON.stringify(output.diagnostic), command, output.exitCode)
        : null;
      if (
        output.exitCode !== 0 ||
        !diagnostic ||
        diagnostic.schema !== "zeros.diagnostic/v1" ||
        diagnostic.component !== component ||
        diagnostic.stage !== stage ||
        !diagnostic.ok ||
        diagnostic.exitCode !== 0 ||
        diagnostic.timedOut ||
        diagnostic.failedChecks.length
      )
        throw new BuildFailure(error, diagnostic);
      return output.stdout;
    } catch (failure) {
      if (failure instanceof BuildFailure) throw failure;
      throw new BuildFailure(error);
    } finally {
      input?.fill(0);
    }
  }
  private create(row: TemplateAllocation) {
    // Exactly the original body/key on a lost response. Never issue a fresh
    // allocation after the provider's 23-hour idempotency safety window.
    if (Date.now() - row.allocation_requested_at.getTime() >= 23 * 60 * 60_000)
      throw new BuildFailure("allocation_failed");
    return this.deps.vms.create(computerTemplateBuilderIntent({
      baseImageId: row.base_image_id,
      imageId: row.builder_source_image_id,
      name: row.builder_name,
      operationKey: row.builder_operation_key,
    }));
  }
  private async build(
    claim: CloudComputerV2Claim,
    runtime: ComputerTemplateRuntime,
  ) {
    const id = claim.build.id,
      fence = claim.workerFence;
    const pin = {
      baseImageId: runtime.baseImageId,
      runtimeId: runtime.descriptor.runtimeId,
    };
    const job = { buildId: id, workerFence: claim.helperFence };
    let failure: CloudComputerV2BuildError = "allocation_failed";
    try {
      await this.guard(claim);
      await this.checkpoint(claim);
      const allocation = await this.journal.allocation(id);
      if (!allocation.provider_resource_id && claim.build.stage !== "allocating")
        throw new BuildFailure("allocation_failed");
      const vm = allocation.provider_resource_id
        ? { sandboxId: allocation.provider_resource_id, purpose: "computer-build" as const, operationKey: allocation.builder_operation_key }
        : await this.create(allocation);
      if (
        vm.purpose !== "computer-build" ||
        vm.operationKey !== allocation.builder_operation_key
      )
        throw new BuildFailure("allocation_failed");
      await this.journal.recordVm(id, vm.operationKey, vm.sandboxId);
      if (claim.build.stage === "allocating") {
        await this.stage(claim, "runtime");
        await this.checkpoint(claim);
      }
      const literals: string[] = [];
      const tcbInput = {
        schema: "zeros.computer-tcb-input/v1",
        ...job,
        baseCompatibilityId: runtime.baseCompatibilityId,
        runtimeId: pin.runtimeId,
      };
      if (claim.build.stage === "runtime") {
        failure = "runtime_install_failed";
        const status = await this.deps.vms.waitForBase(vm);
        const imageId = allocation.builder_source_image_id;
        if (status.baseCompatibilityId !== runtime.baseCompatibilityId) {
          if (imageId) await quarantineRuntimeImage(this.deps.pool, imageId, "base_compatibility");
          throw new BuildFailure(failure);
        }
        if (imageId) {
          if (status.currentRuntimeId !== pin.runtimeId) {
            await quarantineRuntimeImage(this.deps.pool, imageId, "runtime_identity");
            throw new BuildFailure(failure);
          }
          if (status.hostState !== "idle") throw new BuildFailure(failure);
        } else {
          if (status.currentRuntimeId !== null || !["idle", "waiting_for_runtime"].includes(status.hostState))
            throw new BuildFailure(failure);
          const artifact = await this.deps.artifacts.presignGet(runtime.objectKey, 900);
          literals.push(artifact.url);
          await this.fixed(vm, "install-runtime",
            { schema: "zeros.runtime-install/v1", purpose: "build", runtime: runtime.descriptor, artifact },
            failure, this.timeout(claim, 600_000), "installer", "done");
        }
        await this.guard(claim);
        // Only take this baseline before the recipe, never on adoption. The
        // helper's generic tcb_modified does not prove shared-image corruption.
        const baseline = result(TcbResult, await this.fixed(vm, "computer:verify-tcb",
          { ...tcbInput, action: "baseline" }, "tcb_modified", this.timeout(claim, 180_000), "build", "integrity"), "tcb_modified");
        if (baseline.buildId !== id || baseline.runtimeId !== pin.runtimeId || baseline.baseCompatibilityId !== runtime.baseCompatibilityId)
          throw new BuildFailure("tcb_modified");
        await this.journal.recordDigest(id, fence, baseline.protectedContractDigest, "protected");
        allocation.protected_contract_digest = Buffer.from(baseline.protectedContractDigest, "hex");
        await this.stage(claim, "repositories");
        await this.checkpoint(claim);
      }
      if (!allocation.protected_contract_digest) throw new BuildFailure("tcb_modified");
      const baseline = {
        schema: "zeros.computer-tcb/v1", buildId: id, baseCompatibilityId: runtime.baseCompatibilityId,
        runtimeId: pin.runtimeId, protectedContractDigest: allocation.protected_contract_digest.toString("hex"),
      };
      let repositories = claim.repositoryManifest;
      if (claim.build.stage === "repositories") {
        failure = "repository_access_denied";
        repositories = await this.clone(claim, vm, literals);
        if (!(await this.deps.service.markBuildStage(id, fence, "install", { ...pin, repositoryManifest: repositories })).applied)
          throw new BuildFailure("build_failed");
        claim.build.stage = "install";
        // Clone is not replayable. Revoke its credentials and start the durable
        // helper with its redactions before yielding to another CP process.
      }
      if (!repositories) throw new BuildFailure("repository_clone_failed");
      if (claim.build.stage === "install") {
        failure = "install_failed";
        await this.install(claim, vm, literals);
        await this.stage(claim, "integrity");
        await this.checkpoint(claim);
      }
      const manifest = {
        schema: "zeros.computer-template/v1",
        buildId: id,
        configId: claim.config.id,
        ...pin,
        baseCompatibilityId: runtime.baseCompatibilityId,
        repositoryManifest: repositories,
        protectedContractDigest: baseline.protectedContractDigest,
      };
      const manifestSha256 = createHash("sha256").update(canonical(manifest)).digest("hex");
      failure = "integrity_failed";
      // Read the durable result before flags or fallback. This also covers an
      // integrity-stage handoff after recording but before the stage write.
      let qualification = await this.qualificationTx(claim, tx => this.qualificationCheckpoint(tx, claim, manifestSha256));
      if (claim.build.stage === "integrity") {
        const checked = result(TcbResult, await this.fixed(vm, "computer:verify-tcb",
          { ...tcbInput, action: "verify", protectedContractDigest: baseline.protectedContractDigest },
          "tcb_modified", this.timeout(claim, 180_000), "build", "integrity"), "tcb_modified");
        if (canonical(checked) !== canonical(baseline))
          throw new BuildFailure("tcb_modified");
        if (!qualification) {
          const base = (this.deps.flags ?? ROLLOUT_FLAGS_OFF).enabled(claim.organizationId, "build_qualification")
            ? await this.qualificationTx(claim, async tx => {
              if (!await this.deps.runtime.validate(tx, runtime)) throw new BuildFailure("integrity_failed");
              return computerBuildQualificationBase(tx, runtime);
            }) : null;
          if (base) {
            const scope = this.qualificationScope(claim);
            const produced = result(BuildProducerResult, await this.fixed(vm, "computer:qualify-build", {
              schema: "zeros.computer-build-qualification-input/v1", ...job, producerFence: fence, scope,
              builder: { operationKey: vm.operationKey, sandboxId: vm.sandboxId },
              runtime: { runtimeId: runtime.descriptor.runtimeId, manifestSha256: runtime.descriptor.manifestSha256,
                archiveSha256: runtime.descriptor.archiveSha256, engineProtocolVersion: runtime.descriptor.engineProtocolVersion },
              base, protectedContractSha256: baseline.protectedContractDigest, sanitationManifestSha256: manifestSha256,
              deadlineAt: claim.deadlineAt,
            }, "integrity_failed", this.timeout(claim, 600_000), "build", "integrity"), "integrity_failed");
            if (produced.mode === "build") {
              if (canonical(produced.evidence.scope) !== canonical(scope)) throw new BuildFailure("integrity_failed");
              qualification = await this.qualificationTx(claim, async tx => {
                await recordComputerBuildQualification(tx, { evidence: produced.evidence, workerFence: fence,
                  qualificationMode: this.deps.qualificationMode ?? "full" });
                const saved = await this.qualificationCheckpoint(tx, claim, manifestSha256);
                if (!saved) throw new BuildFailure("integrity_failed");
                return saved;
              });
            }
          }
          if (!qualification) await this.fixed(vm, "runtime-self-test", undefined, "integrity_failed",
            this.timeout(claim, 120_000), "qualification", "self_test");
        }
        await this.stage(claim, "sanitation");
        await this.checkpoint(claim);
      }
      if (!["sanitation", "stopping", "capture_confirmed"].includes(claim.build.stage))
        throw new BuildFailure("tcb_modified");
      if (claim.build.stage === "sanitation") {
        qualification = await this.qualificationTx(claim, tx => this.qualificationCheckpoint(tx, claim, manifestSha256, qualification));
        const sanitation = result(SanitationResult, await this.fixed(vm, "computer:sanitize",
          { schema: "zeros.computer-sanitation-input/v1", ...job, manifest, manifestSha256,
            ...(qualification ? { qualification: { evidenceSha256: qualification.evidenceSha256 } } : {}) },
          "sanitation_failed", this.timeout(claim, 120_000), "build", "sanitation"), "sanitation_failed");
        if (sanitation.buildId !== id || sanitation.manifestSha256 !== manifestSha256)
          throw new BuildFailure("sanitation_failed");
        await this.qualificationTx(claim, tx => this.qualificationCheckpoint(tx, claim, manifestSha256, qualification));
        await this.journal.recordDigest(id, fence, manifestSha256, "manifest");
        allocation.manifest_sha256 = Buffer.from(manifestSha256, "hex");
        await this.stage(claim, "stopping");
        await this.checkpoint(claim);
      }
      if (allocation.manifest_sha256?.toString("hex") !== manifestSha256)
        throw new BuildFailure("sanitation_failed");
      if (claim.build.stage === "stopping") {
        failure = "template_stop_failed";
        if (!allocation.stopped_at) {
          // Keep the original stop/capture reserves across every handoff.
          const stopped = await this.deps.vms
            .stop(vm, { timeoutMs: this.timeout(claim, 30 * 60_000, CAPTURE_COMPLETION_MS + NAMED_CAPTURE_MS), requireSnapshot: true })
            .catch((error: unknown) => {
              if (error instanceof BuilderVmError && error.check === "stop_snapshot_failed")
                throw new BuildFailure("template_capture_failed");
              throw error;
            });
          if (stopped.archived !== true) throw new BuildFailure("template_capture_failed");
          allocation.stopped_at = new Date(await this.journal.recordStopped(id));
        }
        await this.checkpoint(claim);
        failure = "template_capture_failed";
        // A name/save without its exact saved-artifact proof is not ready.
        await this.deps.snapshots.capture({ buildId: id, workerFence: fence,
          deadlineAt: new Date(Date.parse(claim.deadlineAt) - CAPTURE_COMPLETION_MS).toISOString(),
          guard: () => this.guard(claim) });
        await this.stage(claim, "capture_confirmed");
        await this.checkpoint(claim);
      }
      if (!allocation.stopped_at) throw new BuildFailure("template_capture_failed");
      await this.deps.service.completeBuild(
        id,
        fence,
        {
          ...pin,
          repositoryManifest: repositories,
          template: {
            providerResourceId: vm.sandboxId,
            accountScope: this.deps.accountScope,
            billingOrg: this.deps.billingOrg,
            protectedContractDigest: baseline.protectedContractDigest,
            stoppedAt: allocation.stopped_at.toISOString(),
          },
        },
        async tx => {
          await this.qualificationCheckpoint(tx, claim, manifestSha256, qualification);
          return this.deps.runtime.validate(tx, runtime);
        },
      );
    } catch (error) {
      if (error instanceof BuildHandoff) return;
      if (error instanceof BuildFailure && error.diagnostic) {
        // Persist only the closed command-specific vocabulary, never helper
        // output or exception text. Reporting cannot prevent failure/cleanup.
        await this.deps.service.appendBuildLog(id, fence, {
          stage: claim.build.stage, stream: "system", text: JSON.stringify(error.diagnostic),
        }).catch(() => undefined);
      }
      // failBuild is fenced and cannot turn an already-committed success into a
      // failure when the completion reply was lost. Cleanup reads that DB fact.
      await this.deps.service.failBuild(
        id,
        fence,
        error instanceof BuildFailure ? error.code : failure,
      );
    } finally {
      const cleanup = await this.journal.claimCleanup(id);
      if (cleanup) await this.cleanup(cleanup);
    }
  }
  private timeout(claim: CloudComputerV2Claim, limit: number, reserve = 0) {
    const remaining = Date.parse(claim.deadlineAt) - Date.now() - reserve;
    if (remaining <= 0) throw new BuildFailure("build_timeout");
    return Math.max(1, Math.min(limit, remaining));
  }
  private async clone(
    claim: CloudComputerV2Claim,
    vm: BuilderVm,
    literals: string[],
  ) {
    const credentials: string[] = [];
    try {
      const repositories = [];
      for (const repository of claim.config.repositories) {
        await this.guard(claim);
        const installationId = await this.journal.repositoryInstallation(
          claim.organizationId,
          repository,
        );
        const credential = await this.deps.github.mintContentsRead({
          installationId,
          repositoryId: Number(repository.id),
        });
        credentials.push(credential.token);
        literals.push(credential.token);
        if (
          credential.expiresAtMs <= Date.now() + 60_000 ||
          installationId !==
            (await this.journal.repositoryInstallation(
              claim.organizationId,
              repository,
            ))
        )
          throw new BuildFailure("repository_access_denied");
        repositories.push({
          id: repository.id,
          owner: repository.owner,
          name: repository.name,
          ref: repository.requestedRef,
          credential: {
            token: credential.token,
            expiresAt: new Date(credential.expiresAtMs).toISOString(),
          },
        });
      }
      await this.guard(claim);
      const output = result(
        RepositoriesResult,
        await this.fixed(
          vm,
          "computer:clone-repos",
          {
            schema: "zeros.computer-repositories-input/v1",
            buildId: claim.build.id,
            workerFence: claim.helperFence,
            repositories,
          },
          "repository_clone_failed",
          this.timeout(claim, 300_000),
          "build",
          "repositories",
        ),
        "repository_clone_failed",
      );
      if (output.buildId !== claim.build.id)
        throw new BuildFailure("repository_clone_failed");
      return output.repositories;
    } finally {
      const revoked = await Promise.allSettled(
        credentials.map((token) => this.deps.github.revoke(token)),
      );
      if (revoked.some((outcome) => outcome.status === "rejected"))
        throw new BuildFailure("repository_access_denied");
    }
  }
  private async install(
    claim: CloudComputerV2Claim,
    vm: BuilderVm,
    literals: string[],
  ) {
    const job = {
      schema: "zeros.computer-install-input/v1",
      buildId: claim.build.id,
      workerFence: claim.helperFence,
    };
    const redactor = new ComputerTemplateLogRedactor(literals, claim.installProgress.discardStreams);
    let after = claim.installProgress.after,
      started = claim.installProgress.started,
      failures = 0;
    // Repeating start is an inspection of the same durable helper marker. In
    // particular a lost SSH reply never starts another arbitrary root script.
    for (;;) {
      await this.guard(claim);
      let stdout: string;
      try {
        stdout = await this.fixed(
          vm,
          "computer:run-install",
          started
            ? { ...job, action: "poll", after }
            : {
                ...job,
                action: "start",
                after,
                script: claim.config.installScript,
                timeoutSeconds: claim.config.timeoutSeconds,
                redactions: literals,
              },
          "install_failed",
          this.timeout(claim, 30_000),
          "build",
          "install",
        );
      } catch (error) {
        if (++failures >= 3) throw error;
        if (this.pollMs)
          await new Promise((resolve) => setTimeout(resolve, this.pollMs));
        continue;
      }
      failures = 0;
      started = true;
      const output = result(InstallResult, stdout, "install_failed");
      if (
        output.buildId !== claim.build.id ||
        output.workerFence !== claim.helperFence ||
        output.nextAfter < after
      )
        throw new BuildFailure("install_failed");
      await this.guard(claim);
      if (
        output.truncated &&
        output.chunks[0] &&
        output.chunks[0].seq > after + 1
      ) {
        // A gap invalidates any withheld prefix; never concatenate disjoint log
        // chunks into a purported credential or release an unfiltered suffix.
        for (const stream of ["stdout", "stderr"] as const)
          await this.append(claim, stream, redactor.finish(stream));
        await this.append(
          claim,
          "system",
          "[earlier build log output truncated]",
        );
      }
      for (const chunk of output.chunks) {
        if (chunk.seq <= after || chunk.seq > output.nextAfter)
          throw new BuildFailure("install_failed");
        await this.append(
          claim,
          chunk.stream,
          redactor.push(chunk.stream, chunk.text),
        );
        after = chunk.seq;
      }
      if (output.nextAfter !== after) throw new BuildFailure("install_failed");
      claim.installProgress = { started, after, discardStreams: redactor.handoffStreams() };
      if (output.state !== "running") {
        for (const stream of ["stdout", "stderr"] as const)
          await this.append(claim, stream, redactor.finish(stream));
        if (
          output.state !== "succeeded" ||
          output.exitCode !== 0 ||
          output.timedOut
        )
          throw new BuildFailure("install_failed");
        return;
      }
      await this.checkpoint(claim);
      if (this.pollMs)
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
  private async append(
    claim: CloudComputerV2Claim,
    stream: "stdout" | "stderr" | "system",
    text: string,
  ) {
    if (
      text &&
      !(
        await this.deps.service.appendBuildLog(
          claim.build.id,
          claim.workerFence,
          { stream, stage: "install", text },
        )
      ).applied
    )
      throw new BuildFailure("build_failed");
  }
  private async cleanup(row: TemplateAllocation) {
    let confirmed = false;
    let recorded = false;
    let vm: BuilderVm | null = row.provider_resource_id
      ? {
          sandboxId: row.provider_resource_id,
          purpose: "computer-build",
          operationKey: row.builder_operation_key,
        }
      : null;
    try {
      if (!vm) {
        const find = async () => {
          const operation = await this.deps.operations.find(
            row.builder_operation_key,
          );
          if (
            operation &&
            (operation.purpose !== "computer-build" ||
              operation.operation_key !== row.builder_operation_key)
          )
            throw new Error("Computer builder identity mismatch");
          return operation;
        };
        let operation = await find();
        if (
          !operation?.sandbox_id &&
          (await this.deps.operations.closeUnallocatedCreate(
            row.builder_operation_key,
          ))
        ) {
          confirmed = true;
          return;
        }
        if (!operation?.sandbox_id && operation?.create_dispatched_at) {
          // Replay only an uncertain dispatch, using the original key/body.
          // B7 binds the ID before readiness/wallet checks can reject create.
          try {
            await this.create(row);
          } catch {
            /* Re-read its durable journal. */
          }
          operation = await find();
        }
        if (!operation?.sandbox_id) {
          confirmed = await this.deps.operations.closeUnallocatedCreate(
            row.builder_operation_key,
          );
          return;
        }
        vm = {
          sandboxId: operation.sandbox_id,
          purpose: operation.purpose,
          operationKey: operation.operation_key,
        };
      }
      if (
        vm.purpose !== "computer-build" ||
        vm.operationKey !== row.builder_operation_key
      )
        throw new Error("Computer builder identity mismatch");
      await this.journal.recordVm(row.build_id, vm.operationKey, vm.sandboxId);
      recorded = true;
      await this.deps.vms.delete(vm);
      confirmed = true;
    } catch {
      if (vm && recorded) {
        try {
          if ((await this.deps.vms.stop(vm)).archived === true)
            await this.journal.recordStopped(row.build_id);
        } catch {
          /* Unknown compute stays a capacity hold; next sweep retries. */
        }
      }
    } finally {
      await this.journal.cleanupResult(row, confirmed);
    }
  }
}

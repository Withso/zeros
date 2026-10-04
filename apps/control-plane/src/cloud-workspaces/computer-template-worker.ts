import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { Tx } from "../db.js";
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
import { computerTemplateBuilderIntent } from "./computer-template-boat.js";
import type {
  BuilderFixedCommand,
  BuilderVm,
  BuilderVmOperations,
  CloudBuilderVms,
  ComputerTemplateRuntime,
} from "./computer-template-boat.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
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

class BuildFailure extends Error {
  constructor(readonly code: CloudComputerV2BuildError) {
    super(code);
  }
}
export type ComputerTemplateWorkerDependencies = {
  pool: pg.Pool;
  service: DatabaseCloudComputerV2Service;
  vms: CloudBuilderVms;
  operations: BuilderVmOperations;
  github: {
    mintContentsRead(input: {
      installationId: number;
      repositoryId: number;
    }): Promise<{ token: string; expiresAtMs: number }>;
    revoke(token: string): Promise<void>;
  };
  runtime: {
    select(tx: Tx): Promise<ComputerTemplateRuntime | null>;
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
  maxConcurrentBuilds?: number;
  pollMs?: number;
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
  private fence = Date.now();
  private ticking: Promise<void> | null = null;
  private stopping = false;
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
  }
  start(): () => Promise<void> {
    this.stopping = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (this.stopping) return;
      timer = setTimeout(() => {
        void this.tick()
          .catch(() => {
            // No provider exception, script output or stdin in infrastructure logs.
            console.error("[computer-template-worker] reconciliation_failed");
          })
          .finally(schedule);
      }, 1000);
      timer.unref();
    };
    schedule();
    return async () => {
      this.stopping = true;
      clearTimeout(timer);
      await this.ticking;
    };
  }
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
        ...(this.deps.namePrefix ? { namePrefix: this.deps.namePrefix } : {}),
        selectRuntime: async (tx) => {
          runtime = await this.deps.runtime.select(tx);
          return runtime
            ? {
                baseImageId: runtime.baseImageId,
                runtimeId: runtime.descriptor.runtimeId,
              }
            : null;
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
    if (this.stopping || !authority.active)
      throw new BuildFailure(
        authority.expired ? "build_timeout" : "build_failed",
      );
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
      const diagnostic = output.diagnostic;
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
        throw new BuildFailure(error);
      return output.stdout;
    } catch {
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
    const job = { buildId: id, workerFence: fence };
    let failure: CloudComputerV2BuildError = "allocation_failed";
    try {
      await this.guard(claim);
      const allocation = await this.journal.allocation(id);
      const vm = await this.create(allocation);
      if (
        vm.purpose !== "computer-build" ||
        vm.operationKey !== allocation.builder_operation_key
      )
        throw new BuildFailure("allocation_failed");
      await this.journal.recordVm(id, vm.operationKey, vm.sandboxId);
      await this.stage(claim, "runtime");
      failure = "runtime_install_failed";
      const status = await this.deps.vms.baseStatus(vm);
      if (
        status.baseCompatibilityId !== runtime.baseCompatibilityId ||
        status.currentRuntimeId !== null ||
        !["idle", "waiting_for_runtime"].includes(status.hostState)
      )
        throw new BuildFailure(failure);
      const artifact = await this.deps.artifacts.presignGet(
        runtime.objectKey,
        900,
      );
      await this.fixed(
        vm,
        "install-runtime",
        {
          schema: "zeros.runtime-install/v1",
          purpose: "build",
          runtime: runtime.descriptor,
          artifact,
        },
        failure,
        this.timeout(claim, 600_000),
        "installer",
        "done",
      );
      await this.guard(claim);
      const tcbInput = {
        schema: "zeros.computer-tcb-input/v1",
        ...job,
        baseCompatibilityId: runtime.baseCompatibilityId,
        runtimeId: pin.runtimeId,
      };
      const baseline = result(
        TcbResult,
        await this.fixed(
          vm,
          "computer:verify-tcb",
          { ...tcbInput, action: "baseline" },
          "tcb_modified",
          this.timeout(claim, 180_000),
          "build",
          "integrity",
        ),
        "tcb_modified",
      );
      if (
        baseline.buildId !== id ||
        baseline.runtimeId !== pin.runtimeId ||
        baseline.baseCompatibilityId !== runtime.baseCompatibilityId
      )
        throw new BuildFailure("tcb_modified");
      await this.journal.recordDigest(
        id,
        fence,
        baseline.protectedContractDigest,
        "protected",
      );
      await this.stage(claim, "repositories");
      failure = "repository_access_denied";
      const literals: string[] = [artifact.url];
      const repositories = await this.clone(claim, vm, literals);
      if (
        !(
          await this.deps.service.markBuildStage(id, fence, "install", {
            ...pin,
            repositoryManifest: repositories,
          })
        ).applied
      )
        throw new BuildFailure("build_failed");
      await this.guard(claim);
      failure = "install_failed";
      await this.install(claim, vm, literals);
      await this.stage(claim, "integrity");
      const checked = result(
        TcbResult,
        await this.fixed(
          vm,
          "computer:verify-tcb",
          {
            ...tcbInput,
            action: "verify",
            protectedContractDigest: baseline.protectedContractDigest,
          },
          "tcb_modified",
          this.timeout(claim, 180_000),
          "build",
          "integrity",
        ),
        "tcb_modified",
      );
      if (canonical(checked) !== canonical(baseline))
        throw new BuildFailure("tcb_modified");
      await this.fixed(
        vm,
        "runtime-self-test",
        undefined,
        "integrity_failed",
        this.timeout(claim, 120_000),
        "qualification",
        "self_test",
      );
      await this.stage(claim, "sanitation");
      const manifest = {
        schema: "zeros.computer-template/v1",
        buildId: id,
        configId: claim.config.id,
        ...pin,
        baseCompatibilityId: runtime.baseCompatibilityId,
        repositoryManifest: repositories,
        protectedContractDigest: baseline.protectedContractDigest,
      };
      const manifestSha256 = createHash("sha256")
        .update(canonical(manifest))
        .digest("hex");
      const sanitation = result(
        SanitationResult,
        await this.fixed(
          vm,
          "computer:sanitize",
          {
            schema: "zeros.computer-sanitation-input/v1",
            ...job,
            manifest,
            manifestSha256,
          },
          "sanitation_failed",
          this.timeout(claim, 120_000),
          "build",
          "sanitation",
        ),
        "sanitation_failed",
      );
      if (
        sanitation.buildId !== id ||
        sanitation.manifestSha256 !== manifestSha256
      )
        throw new BuildFailure("sanitation_failed");
      await this.journal.recordDigest(id, fence, manifestSha256, "manifest");
      await this.stage(claim, "stopping");
      failure = "template_stop_failed";
      const stopped = await this.deps.vms.stop(vm);
      if (stopped.archived !== true)
        throw new BuildFailure("template_capture_failed");
      const stoppedAt = await this.journal.recordStopped(id);
      await this.stage(claim, "capture_confirmed");
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
            stoppedAt,
          },
        },
        (tx) => this.deps.runtime.validate(tx, runtime),
      );
    } catch (error) {
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
  private timeout(claim: CloudComputerV2Claim, limit: number) {
    const remaining = Date.parse(claim.deadlineAt) - Date.now();
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
            workerFence: claim.workerFence,
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
      workerFence: claim.workerFence,
    };
    const redactor = new ComputerTemplateLogRedactor(literals);
    let after = 0,
      started = false,
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
        output.workerFence !== claim.workerFence ||
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

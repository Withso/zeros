import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { assertHostedDevAdmission } from "../development-environment.js";
import { BOAT_BILLING_ORG_PATTERN, BOAT_RESOURCE_ID_PATTERN, BoatCreateRejectedError, type BoatApiClient } from "./boat-client.js";
import { executeBoatPinnedSsh, type BoatBootstrapChannel } from "./boat-pinned-ssh.js";
import { BUILDER_BASE_STATUS_COMMAND, COMPUTER_TEMPLATE_MAX_INPUT_BYTES, builderFixedCommand, isComputerBuilderCommand, parseBuilderDiagnostic, type BuilderFixedCommand, type ClosedDiagnostic } from "./cloud-builder-commands.js";
import { builderOperationConflict, type BuilderVmIntent, type BuilderVmOperation, type BuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import { CloudProviderError } from "./provider.js";
import { RuntimeBaseStatusSchema, RuntimeInstallInputSchema, RUNTIME_INSTALL_MAX_ENCODED_BYTES } from "./runtime-contract.js";

export type { BuilderFixedCommand, ClosedDiagnostic } from "./cloud-builder-commands.js";
export type BuilderVmSource = { kind: "base"; baseImageId: string } | { kind: "template"; templateId: string };
export type BuilderVm = { sandboxId: string; purpose: "runtime-qualification" | "computer-build"; operationKey: string };
export type BaseStatus = z.infer<typeof RuntimeBaseStatusSchema>;
export interface CloudBuilderVms {
  create(input: BuilderVmIntent): Promise<BuilderVm>;
  baseStatus(vm: BuilderVm): Promise<BaseStatus>;
  runFixed(vm: BuilderVm, command: BuilderFixedCommand, input?: Buffer, opts?: { timeoutMs?: number }):
    Promise<{ exitCode: number; stdout: string; diagnostic: ClosedDiagnostic | null }>;
  stop(vm: BuilderVm): Promise<{ archived: true }>;
  delete(vm: BuilderVm): Promise<void>;
}

const intentSchema = z.object({
  purpose: z.enum(["runtime-qualification", "computer-build"]),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("base"), baseImageId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) }).strict(),
    z.object({ kind: z.literal("template"), templateId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) }).strict(),
  ]),
  name: z.string().regex(/^zeros-v2-[a-z0-9][a-z0-9-]{0,52}$/),
  operationKey: z.string().regex(/^[A-Za-z0-9._:-]{1,255}$/),
  ttlSeconds: z.number().int().min(60).max(1800),
}).strict();
const sandboxSchema = z.object({
  id: z.string().regex(BOAT_RESOURCE_ID_PATTERN),
  state: z.enum(["init", "provisioning", "provisioned", "cloning", "ready", "idle", "running", "archiving", "archived", "error", "cancelled"]),
  team: z.object({ id: z.string() }).nullish(),
});
const deletionSchema = z.object({
  id: z.string().regex(/^bdop_[a-f0-9]{32}$/), kind: z.literal("sandbox"),
  targetId: z.string().regex(BOAT_RESOURCE_ID_PATTERN),
  status: z.enum(["pending", "processing", "blocked", "completed"]),
});
const MAX_OUTPUT_BYTES = 64 * 1024;
const CREATE_RETRY_WINDOW_MS = 23 * 60 * 60_000;

export class BuilderVmError extends Error {
  constructor(readonly check: "input_schema" | "source_unavailable" | "wallet_mismatch" | "provider_response" |
    "provider_unavailable" | "builder_stopped" | "timeout" | "command_invalid" | "command_unconfirmed" | "cleanup_unconfirmed") {
    super(`Builder VM ${check}`);
  }
}
function fail(check: BuilderVmError["check"]): never { throw new BuilderVmError(check); }
const vmFor = (row: BuilderVmOperation): BuilderVm => ({ sandboxId: row.sandbox_id!, purpose: row.purpose, operationKey: row.operation_key });

export function builderVmBaseSnapshot(imageRef: string) {
  const name = /^boat:([a-z0-9][a-z0-9-]{0,62})@sha256:[a-f0-9]{64}$/.exec(imageRef)?.[1];
  if (!name) fail("source_unavailable");
  return name;
}

/** Prepare without provider I/O. Qualification uses the claim transaction so
 * an overdue claim always has an intent that reconciliation can fence. */
export async function prepareBuilderVmOperation(operations: BuilderVmOperationStore, value: BuilderVmIntent,
  resolveSource: (source: BuilderVmSource) => Promise<string>, tx?: Tx): Promise<BuilderVmOperation> {
  const parsed = intentSchema.safeParse(value);
  if (!parsed.success) fail("input_schema");
  const input = parsed.data;
  const row = await operations.find(input.operationKey, tx);
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  if (row) {
    if (row.request_sha256 !== digest) builderOperationConflict();
    return row;
  }
  const source = await resolveSource(input.source);
  if (input.source.kind === "base" ? !/^[a-z0-9][a-z0-9-]{0,62}$/.test(source) : !BOAT_RESOURCE_ID_PATTERN.test(source)) fail("source_unavailable");
  return operations.prepare(input, digest, {
    path: input.source.kind === "base" ? "/sandboxes" : `/sandboxes/${source}/fork`,
    body: { ...(input.source.kind === "base" ? { from: source } : {}), name: input.name,
      type: "default", ttlSeconds: input.ttlSeconds, noEnv: true, env: {}, snapshots: input.purpose === "computer-build" },
  }, tx);
}

/** Resolves only approved registry bases. C3 supplies an authorized, pinned
 * template resolver; this module never guesses an org's active template. */
export function builderVmSourceResolver(pool: pg.Pool, template?: (id: string) => Promise<string>) {
  return async (source: BuilderVmSource): Promise<string> => {
    if (source.kind === "template") {
      const id = await template?.(source.templateId);
      if (!id || !BOAT_RESOURCE_ID_PATTERN.test(id)) fail("source_unavailable");
      return id;
    }
    const image = await withSystemTx(pool, async tx => (await tx.query<{ image_ref: string }>(
      `SELECT base.image_ref FROM cloud_runtime_base_images base
       JOIN cloud_runtime_base_contracts contract USING (base_compatibility_id)
       WHERE base.base_image_id=$1 AND base.revoked_at IS NULL AND contract.revoked_at IS NULL
         AND base.provider='boat' AND base.approved_at<=clock_timestamp()`, [source.baseImageId])).rows[0]);
    return builderVmBaseSnapshot(image?.image_ref ?? "");
  };
}

export class BoatCloudBuilderVms implements CloudBuilderVms {
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly lifecycleTimeoutMs: number;
  constructor(private readonly options: {
    client: Pick<BoatApiClient, "request">;
    billingOrg: string;
    operations: BuilderVmOperationStore;
    resolveSource(source: BuilderVmSource): Promise<string>;
    openChannel?: (signal: AbortSignal) => Promise<BoatBootstrapChannel>;
    lifecycleTimeoutMs?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  }) {
    if (!BOAT_BILLING_ORG_PATTERN.test(options.billingOrg)) fail("input_schema");
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? (ms => delay(ms));
    this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? 180_000;
    if (!Number.isSafeInteger(this.lifecycleTimeoutMs) || this.lifecycleTimeoutMs < 1 || this.lifecycleTimeoutMs > 600_000) fail("input_schema");
  }

  async create(value: BuilderVmIntent): Promise<BuilderVm> {
    let row = await prepareBuilderVmOperation(this.options.operations, value, this.options.resolveSource);
    const input = row.intent;
    if (row.create_closed_at || !["creating", "ready"].includes(row.state)) builderOperationConflict();
    const deadline = this.now() + this.lifecycleTimeoutMs;
    if (!row.sandbox_id) {
      const age = this.now() - new Date(row.created_at).getTime();
      if (age < -60_000 || age >= CREATE_RETRY_WINDOW_MS) fail("provider_unavailable");
      assertHostedDevAdmission(process.env, input.ttlSeconds);
      row = await this.retry(async () => {
        const attemptId = randomUUID();
        const dispatch = await this.options.operations.beginCreateAttempt(input.operationKey, attemptId);
        if (dispatch.sandbox_id) return dispatch;
        let reply: Record<string, unknown>;
        try {
          reply = await this.options.client.request(dispatch.provider_request.path, {
            method: "POST", body: dispatch.provider_request.body, idempotencyKey: dispatch.operation_key,
            signal: AbortSignal.timeout(Math.max(1, deadline - this.now())), timeoutMs: 120_000,
          });
        } catch (error) {
          if (error instanceof BoatCreateRejectedError)
            await this.options.operations.recordCreateRejection(input.operationKey, attemptId, error.createRejectionCode);
          throw error;
        }
        const nested = (reply.sandbox as { id?: unknown } | undefined)?.id;
        const id = nested ?? reply.sandboxId;
        if (typeof id !== "string" || !BOAT_RESOURCE_ID_PATTERN.test(id) ||
            dispatch.provider_request.path === `/sandboxes/${id}/fork`) fail("provider_response");
        // Bind before wallet/readiness validation so every failure can clean up.
        await this.options.operations.bind(input.operationKey, id);
        return { ...dispatch, sandbox_id: id };
      }, deadline);
    }
    const vm = vmFor(row);
    for (;;) {
      const sandbox = await this.inspect(vm.sandboxId, deadline);
      if (sandbox.team?.id.toLowerCase() !== this.options.billingOrg.toLowerCase()) fail("wallet_mismatch");
      if (["ready", "idle", "running"].includes(sandbox.state)) break;
      if (["error", "cancelled", "archived", "archiving"].includes(sandbox.state)) fail("builder_stopped");
      await this.pause(deadline);
    }
    await this.options.operations.state(input.operationKey, "ready");
    return vm;
  }

  async baseStatus(vm: BuilderVm): Promise<BaseStatus> {
    await this.owned(vm, true);
    const reply = await this.retry(() => this.options.client.request(`/sandboxes/${vm.sandboxId}/commands`, {
      method: "POST", body: { command: BUILDER_BASE_STATUS_COMMAND, timeoutSeconds: 20 }, timeoutMs: 30_000,
    }), this.now() + this.lifecycleTimeoutMs);
    if (reply.success !== true || reply.exitCode !== 0 || reply.timedOut || reply.stdoutTruncated ||
        typeof reply.stdout !== "string" || Buffer.byteLength(reply.stdout) > 4096 || !/^[^\r\n]+\n?$/.test(reply.stdout)) fail("provider_response");
    try {
      const parsed = RuntimeBaseStatusSchema.safeParse(JSON.parse(reply.stdout));
      if (parsed.success) return parsed.data;
    } catch { /* Never forward provider output. */ }
    return fail("provider_response");
  }

  async runFixed(vm: BuilderVm, command: BuilderFixedCommand, input?: Buffer, opts?: { timeoutMs?: number }) {
    await this.owned(vm, true);
    const timeoutMs = opts?.timeoutMs ?? 600_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800_000) fail("command_invalid");
    let stdin = "";
    if (command === "install-runtime") {
      if (!Buffer.isBuffer(input) || input.length === 0 || input.length > RUNTIME_INSTALL_MAX_ENCODED_BYTES) fail("command_invalid");
      stdin = input.toString("utf8");
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(stdin) || Buffer.from(stdin, "base64url").toString("base64url") !== stdin) fail("command_invalid");
        const parsed = RuntimeInstallInputSchema.safeParse(JSON.parse(Buffer.from(stdin, "base64url").toString("utf8")));
        if (!parsed.success || parsed.data.purpose !== (vm.purpose === "runtime-qualification" ? "qualification" : "build")) fail("command_invalid");
        const expiry = Date.parse(parsed.data.artifact.expiresAt);
        if (expiry <= this.now() || expiry > this.now() + 900_000) fail("command_invalid");
      } catch { fail("command_invalid"); }
    } else if (isComputerBuilderCommand(command)) {
      if (vm.purpose !== "computer-build" || !Buffer.isBuffer(input) || input.length === 0 ||
          input.length > COMPUTER_TEMPLATE_MAX_INPUT_BYTES) fail("command_invalid");
      stdin = input.toString("utf8");
      if (!Buffer.from(stdin, "utf8").equals(input)) fail("command_invalid");
      // The fixed base helper validates its own strict JSON schema. Credentials
      // remain on pinned SSH stdin and never enter a provider command or env.
    } else if (input !== undefined || command !== "runtime-self-test") fail("command_invalid");
    const runtime = command === "runtime-self-test" ? await this.baseStatus(vm) : null;
    if (runtime && runtime.hostState !== "idle") fail("builder_stopped");
    const fixed = builderFixedCommand(command, runtime?.currentRuntimeId ?? null);
    if (!fixed) fail("command_invalid");
    try {
      const result = await executeBoatPinnedSsh({ resourceId: vm.sandboxId, command: fixed, stdin,
        timeoutSeconds: Math.ceil(timeoutMs / 1000) }, { ...this.options, maxOutputBytes: MAX_OUTPUT_BYTES },
      AbortSignal.timeout(timeoutMs + 60_000));
      if (result.outputTruncated || typeof result.output !== "string" || Buffer.byteLength(result.output) > MAX_OUTPUT_BYTES ||
          !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255) fail("command_unconfirmed");
      return { exitCode: result.exitCode, stdout: result.output,
        diagnostic: parseBuilderDiagnostic(result.output, command, result.exitCode) };
    } catch { return fail("command_unconfirmed"); }
  }

  async stop(vm: BuilderVm): Promise<{ archived: true }> {
    await this.owned(vm, true);
    const deadline = this.now() + this.lifecycleTimeoutMs;
    let sandbox = await this.inspect(vm.sandboxId, deadline);
    if (sandbox.state !== "archived") {
      await this.options.operations.state(vm.operationKey, "stopping");
      if (sandbox.state !== "archiving") await this.retry(() => this.options.client.request(`/sandboxes/${vm.sandboxId}/stop`, { method: "POST" }), deadline);
      while (sandbox.state !== "archived") {
        if (["error", "cancelled"].includes(sandbox.state)) fail("builder_stopped");
        await this.pause(deadline);
        sandbox = await this.inspect(vm.sandboxId, deadline);
      }
    }
    await this.options.operations.state(vm.operationKey, "archived");
    return { archived: true };
  }

  async delete(vm: BuilderVm): Promise<void> {
    const row = await this.owned(vm, false);
    if (row.state === "deleted") return;
    await this.options.operations.state(vm.operationKey, "deleting");
    const deadline = this.now() + this.lifecycleTimeoutMs;
    let operationId = row.deletion_operation_id;
    if (!operationId) {
      try {
        const reply = await this.retry(() => this.options.client.request(`/sandboxes/${vm.sandboxId}`, {
          method: "DELETE", confirmDelete: vm.sandboxId,
        }), deadline);
        const parsed = deletionSchema.safeParse(reply.operation);
        if (!parsed.success || parsed.data.targetId !== vm.sandboxId) fail("cleanup_unconfirmed");
        operationId = parsed.data.id;
        await this.options.operations.deletion(vm.operationKey, operationId);
      } catch (error) {
        if (!(error instanceof CloudProviderError && error.code === "provider_not_found")) throw error;
      }
    }
    for (;;) {
      if (operationId) {
        const reply = await this.retry(() => this.options.client.request(`/deletion-operations/${operationId}`), deadline);
        const parsed = deletionSchema.safeParse(reply.operation);
        if (!parsed.success || parsed.data.id !== operationId || parsed.data.targetId !== vm.sandboxId) fail("cleanup_unconfirmed");
        if (parsed.data.status !== "completed") { await this.pause(deadline); continue; }
      }
      try { await this.inspect(vm.sandboxId, deadline); }
      catch (error) {
        if (!(error instanceof CloudProviderError && error.code === "provider_not_found")) throw error;
        await this.options.operations.state(vm.operationKey, "deleted");
        return;
      }
      await this.pause(deadline);
    }
  }

  private async owned(vm: BuilderVm, usable: boolean) {
    if (!BOAT_RESOURCE_ID_PATTERN.test(vm.sandboxId)) builderOperationConflict();
    const row = await this.options.operations.find(vm.operationKey);
    if (!row || row.sandbox_id !== vm.sandboxId || row.purpose !== vm.purpose ||
        (usable && ["deleting", "deleted"].includes(row.state))) builderOperationConflict();
    return row;
  }
  private async inspect(id: string, deadline: number) {
    const reply = await this.retry(() => this.options.client.request(`/sandboxes/${id}`), deadline);
    const parsed = sandboxSchema.safeParse(reply.sandbox);
    if (!parsed.success || parsed.data.id !== id) fail("provider_response");
    return parsed.data;
  }
  private async pause(deadline: number, retryAfter = 1000) {
    const remaining = deadline - this.now();
    if (remaining <= 0) fail("timeout");
    await this.wait(Math.min(retryAfter, remaining));
    if (this.now() >= deadline) fail("timeout");
  }
  private async retry<T>(action: () => Promise<T>, deadline: number): Promise<T> {
    for (;;) {
      if (this.now() >= deadline) fail("timeout");
      try { return await action(); }
      catch (error) {
        if (!(error instanceof CloudProviderError && error.retryable)) throw error;
        await this.pause(deadline, error.retryAfterMs ?? 1000);
      }
    }
  }
}

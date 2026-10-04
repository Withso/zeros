import { vi } from "vitest";
import { BoatApiClient } from "./boat-client.js";
import { BoatCloudBuilderVms } from "./cloud-builder-vm.js";
import type { BoatBootstrapExecution } from "./boat-pinned-ssh.js";
import { builderOperationConflict, type BuilderVmIntent, type BuilderVmOperation, type BuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import { runtimeBase } from "./runtime-test-fixtures.js";

export const BUILDER_SANDBOX = "bx_23456789";
export const BUILDER_WALLET = "team_11111111-1111-4111-8111-111111111111";
export const builderIntent: BuilderVmIntent = { purpose: "runtime-qualification", source: { kind: "base", baseImageId: runtimeBase.id },
  name: "zeros-v2-test-builder", operationKey: "zeros-v2-test-operation", ttlSeconds: 1800 };
export const installerInput = () => ({ schema: "zeros.runtime-install/v1", purpose: "qualification",
  runtime: { runtimeId: `r1-${"a".repeat(64)}`, manifestSha256: "a".repeat(64), archiveSha256: "b".repeat(64), archiveBytes: 100,
    expandedBytes: 200, sourceCommit: "c".repeat(40), nodeModulesAbi: 127, bootstrapProtocolVersion: 1, engineProtocolVersion: 20 },
  artifact: { url: "https://objects.example.test/private-artifact-value", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
export const encodeInstaller = (value = installerInput()) => Buffer.from(Buffer.from(JSON.stringify(value)).toString("base64url"));
export const diagnostic = (component = "qualification", failedChecks: string[] = []) => ({ schema: "zeros.diagnostic/v1", component,
  stage: component === "installer" ? "done" : "self_test", ok: failedChecks.length === 0,
  exitCode: failedChecks.length ? 1 : 0, timedOut: false, failedChecks });

export function memoryBuilderOperations(): BuilderVmOperationStore & { rows: Map<string, BuilderVmOperation> } {
  const rows = new Map<string, BuilderVmOperation>();
  const attempts = new Map<string, Map<string, string | null>>();
  const row = (key: string) => rows.get(key) ?? builderOperationConflict();
  return {
    rows,
    async find(key) { return rows.get(key) ?? null; },
    async prepare(intent, digest, request) {
      const existing = rows.get(intent.operationKey);
      if (existing) { if (existing.request_sha256 !== digest) builderOperationConflict(); return existing; }
      const value: BuilderVmOperation = { operation_key: intent.operationKey, purpose: intent.purpose, request_sha256: digest,
        intent, provider_request: request, state: "creating", sandbox_id: null, deletion_operation_id: null,
        created_at: new Date(), create_dispatched_at: null, create_closed_at: null };
      rows.set(intent.operationKey, value);
      attempts.set(intent.operationKey, new Map());
      return value;
    },
    async beginCreateAttempt(key, id) {
      const current = row(key);
      if (current.create_closed_at || !["creating", "ready"].includes(current.state)) builderOperationConflict();
      if (current.sandbox_id) return current;
      if (attempts.get(key)!.has(id)) builderOperationConflict();
      attempts.get(key)!.set(id, null);
      current.create_dispatched_at ??= new Date();
      return current;
    },
    async recordCreateRejection(key, id, code) {
      const previous = attempts.get(key)?.get(id);
      if (previous === undefined || (previous !== null && previous !== code)) builderOperationConflict();
      attempts.get(key)!.set(id, code);
    },
    async closeUnallocatedCreate(key) {
      const current = rows.get(key);
      if (!current || current.sandbox_id || [...attempts.get(key)!.values()].includes(null)) return false;
      current.create_closed_at ??= new Date();
      return true;
    },
    async bind(key, id) {
      if (row(key).create_closed_at || (row(key).sandbox_id && row(key).sandbox_id !== id)) builderOperationConflict();
      row(key).sandbox_id = id;
    },
    async state(key, state) { row(key).state = state; },
    async deletion(key, id) { row(key).deletion_operation_id = id; },
  };
}

export function builderFixture(operations: BuilderVmOperationStore = memoryBuilderOperations()) {
  let now = Date.now();
  const state = {
    sandboxId: BUILDER_SANDBOX, states: ["running"], wallet: BUILDER_WALLET, hostState: "waiting_for_runtime", runtimeId: null as string | null,
    baseCompatibilityId: runtimeBase.compatibilityId, deleted: false, deletionStatus: "completed", deleteRequests: 0,
    deletionStage: null as string | null, deletionReleasesCompute: false, baseStatusCalls: 0,
    baseStatusReplies: [] as Array<{ success?: boolean; exitCode?: number; timedOut?: boolean; stdout?: string; hostState?: string }>,
    createRepliesLost: 0, createRefused: false, creates: 0, allocations: new Set<string>(), failChecks: [] as string[],
    sshOutput: null as string | null, sshExit: 0, stdoutTruncated: false,
  };
  const operation = () => ({ id: `bdop_${"d".repeat(32)}`, kind: "sandbox", targetId: state.sandboxId,
    status: state.deletionStatus, stage: state.deletionStage });
  const keyBytes = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const publicKey = `ssh-ed25519 ${keyBytes.toString("base64")}`;
  const response = (body: object, status = 200) => new Response(JSON.stringify({ ok: status === 200, ...body }), { status });
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(url)).pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    if (method === "POST" && (route === "/sandboxes" || route.endsWith("/fork"))) {
      state.creates++;
      if (state.createRefused && state.createRepliesLost <= 0) return response({
        type: "sandbox.error", status: 429, code: "trial_compute_limit_reached", requestId: "req_zeros-v2-test-refusal",
        error: { status: 429, code: "trial_compute_limit_reached" },
      }, 429);
      state.allocations.add(new Headers(init?.headers).get("idempotency-key")!);
      if (state.createRepliesLost-- > 0) throw new Error("private provider error");
      return response({ sandbox: { id: state.sandboxId } });
    }
    if (route.startsWith("/deletion-operations/")) {
      if (state.deletionStatus === "completed") state.deleted = true;
      return response({ operation: operation() });
    }
    if (method === "DELETE") {
      state.deleteRequests++;
      if (state.deletionReleasesCompute) state.deleted = true;
      return response({ operation: operation() });
    }
    if (route.endsWith("/stop")) { state.states = ["archived"]; return response({}); }
    if (route.endsWith("/commands")) {
      const command = JSON.parse(String(init?.body)).command as string;
      if (command.endsWith("bootstrap.py status")) {
        state.baseStatusCalls++;
        const { hostState = state.hostState, ...reply } = state.baseStatusReplies.shift() ?? {};
        return response({ success: true, exitCode: 0, timedOut: false, stdoutTruncated: false,
          stdout: JSON.stringify({ schema: "zeros.base-status/v1", baseCompatibilityId: state.baseCompatibilityId,
            bootId: "11111111-1111-4111-8111-111111111111", currentRuntimeId: state.runtimeId, hostState }) + "\n", ...reply });
      }
      const stdout = command.includes("authorized_keys") ? command.includes("expiry-time") ? "restricted\n" : "revoked\n" : publicKey;
      return response({ success: true, exitCode: 0, stdout, timedOut: false, stdoutTruncated: false });
    }
    if (state.deleted) return response({}, 404);
    const current = state.states.length > 1 ? state.states.shift()! : state.states[0];
    return response({ sandbox: { id: state.sandboxId, state: current, team: { id: state.wallet }, ip: "208.67.222.222" } });
  });
  const client = new BoatApiClient({ apiKey: "builder-test-api-key", billingOrg: BUILDER_WALLET, timeoutMs: 1000, fetch: fetcher });
  const channel = { publicKey, dispose: vi.fn(async () => {}),
    execute: vi.fn(async (input: BoatBootstrapExecution) => {
      const install = input.command.includes("install-runtime.sh");
      if (install) { state.runtimeId = JSON.parse(Buffer.from(input.stdin, "base64url").toString()).runtime.runtimeId; state.hostState = "idle"; }
      const result = diagnostic(install ? "installer" : "qualification", install ? [] : state.failChecks);
      return { exitCode: state.sshOutput === null ? result.exitCode : state.sshExit,
        output: state.sshOutput ?? `${JSON.stringify(result)}\n`, outputTruncated: state.stdoutTruncated };
    }),
  };
  const waits: number[] = [];
  const vms = new BoatCloudBuilderVms({ client, billingOrg: BUILDER_WALLET, operations,
    resolveSource: async source => source.kind === "base" ? "zeros-v2-test-base" : "bx_bcdefghj",
    openChannel: async () => channel, now: () => now, wait: async ms => { waits.push(ms); now += ms; },
    lifecycleTimeoutMs: 3000, baseReadinessTimeoutMs: 18_000 });
  return { vms, client, channel, fetcher, operations, state, waits, advance: (ms: number) => { now += ms; } };
}

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { executeBoatPinnedSsh, type BoatPinnedSshOptions } from "./boat-pinned-ssh.js";
import { CloudActiveRuntimeSchema, CloudRuntimeWitnessSchema, RuntimeDescriptorSchema,
  RuntimeInstallInputSchema, type CloudActiveRuntime } from "./runtime-contract.js";
import { CloudResidentWitnessSchema, CloudRuntimeHandoffRequestSchema, CloudRuntimeHandoffReceiptSchema,
  detachedResident, sameHandoff, sameResidentHost, type CloudResidentWitness, type CloudRuntimeHandoffReceipt } from "./runtime-handoff-contract.js";

const schema = "zeros.runtime-update/v1";
const MAX_FRAME = 128 * 1024;
const executionScope = z.object({ workspaceId: z.string().uuid(), organizationId: z.string().uuid(),
  sourceGeneration: z.number().int().min(1).max(2 ** 31 - 1), candidateGeneration: z.number().int().min(1).max(2 ** 31 - 1),
  sourceEngineInstanceId: z.string().uuid(),
}).strict().refine(value => value.candidateGeneration > value.sourceGeneration);
const scope = { schema: z.literal(schema), transitionId: z.string().uuid(), fence: z.string().uuid(), scope: executionScope };
const inputFields = { ...scope, expiresAt: z.string().datetime({ offset: true }), source: CloudActiveRuntimeSchema,
  mode: z.enum(["bootstrap", "engine"]) };
const Input = z.discriminatedUnion("operation", [
  z.object({ ...inputFields, operation: z.literal("stage"), install: z.string().max(64 * 1024) }).strict(),
  z.object({ ...inputFields, operation: z.literal("activate"), target: RuntimeDescriptorSchema,
    handoff: CloudRuntimeHandoffRequestSchema.optional() }).strict(),
]);
export type RuntimeUpdateInput = z.infer<typeof Input>;
const Frame = z.object({ ...scope,
  phase: z.enum(["authorize", "authorize_consumption", "cancel_consumption", "consumed", "enroll", "health", "authorize_rollback", "rollback_enroll", "rollback_health"]),
  active: CloudActiveRuntimeSchema.optional(), controller: CloudActiveRuntimeSchema.optional(),
  resident: CloudResidentWitnessSchema.optional(), handoff: CloudRuntimeHandoffReceiptSchema.optional(),
  report: z.record(z.unknown()).optional(),
}).strict();
const Result = z.object({ ...scope, operation: z.enum(["stage", "activate"]),
  outcome: z.enum(["staged", "deferred", "healthy", "rolled_back", "recovery_required"]),
  active: CloudActiveRuntimeSchema.optional(),
}).strict();
export type RuntimeUpdateResult = z.infer<typeof Result>;
type Context = { input: RuntimeUpdateInput; controller: CloudActiveRuntime | null; resident?: CloudResidentWitness };
type Enrollment = Context & { active: CloudActiveRuntime; report: Record<string, unknown>; rollback: boolean };
export type RuntimeUpdateHandlers = {
  /** Owns the workspace transition lock, current-mode qualifications, complete
   * quiet reservation and presence gate. True is the activation linearization. */
  authorize(context: Context): Promise<boolean>;
  /** Journal authorization only; source authority MUST remain live. Missing
   * resident handlers deny activation even when legacy authorization allows. */
  authorizeConsumption?(context: Context & { resident: CloudResidentWitness; receipt: CloudRuntimeHandoffReceipt }): Promise<boolean>;
  /** Commit the consumed witness, then retire source authority in a separate
   * transaction. An ambiguous result closes admission and requires recovery. */
  consumed?(context: Context & { resident: CloudResidentWitness }): Promise<boolean>;
  /** Only an accepted root cancellation plus the original attached witness. */
  cancelConsumption?(context: Context & { resident: CloudResidentWitness }): Promise<boolean>;
  /** Fences candidate admission and resolves an ambiguous health response. */
  authorizeRollback(context: Context): Promise<boolean>;
  /** A fresh one-use grant; no repository setup or credential redemption. */
  enroll(context: Enrollment): Promise<Record<string, unknown> | null>;
  /** Exact registration, durable record sync and authenticated readiness.
   * Keep ordinary admission closed until the runner's final receipt is durable. */
  health(context: Context & { active: CloudActiveRuntime; rollback: boolean }): Promise<boolean>;
};

function invalid(): never { throw new Error("Runtime update response is invalid"); }
function requireValid(value: unknown): asserts value { if (!value) invalid(); }
const equal = (left: CloudActiveRuntime, right: CloudActiveRuntime) =>
  Object.keys(left).every(key => left[key as keyof CloudActiveRuntime] === right[key as keyof CloudActiveRuntime]);

let program: { command: string; source: string } | undefined;
function runtimeUpdateProgram() {
  if (!program) {
    const source = readFileSync(new URL("./runtime-update-adapter.py", import.meta.url));
    // Keep the forced command below sshd's 8 KiB authorized_keys line limit.
    // Read exactly the pinned source length without buffering the following
    // request; only these deployment-owned bytes may execute as root.
    const loader = ["import hashlib,os,sys", `size=${source.length}`, "source=bytearray()",
      "while len(source)<size:", " block=os.read(0,size-len(source))", " if not block: sys.exit(1)",
      " source.extend(block)",
      `if hashlib.sha256(source).hexdigest()!='${createHash("sha256").update(source).digest("hex")}': sys.exit(1)`,
      "exec(compile(bytes(source),'<runtime-update>','exec'))"].join("\n");
    const python = `exec(${JSON.stringify(loader)})`;
    program = { command: `/usr/bin/python3 -I -c '${python.replaceAll("'", "'\\''")}'`, source: source.toString("utf8") };
  }
  return program;
}
/** Fixed loader and deployment digest only. Request values/grants never enter
 * argv, the provider command API, authorized_keys, or deployment diagnostics. */
export function runtimeUpdateCommand(): string {
  return runtimeUpdateProgram().command;
}

/** Ordered duplex protocol. Callback errors become a closed denial; raw VM
 * bytes and callback exceptions are never included in the returned result. */
export function createRuntimeUpdateConversation(raw: RuntimeUpdateInput, handlers: RuntimeUpdateHandlers,
  now: () => number = Date.now) {
  const parsed = Input.safeParse(raw);
  requireValid(parsed.success);
  const input = parsed.data;
  const fresh = () => { const remaining = Date.parse(input.expiresAt) - now(); requireValid(remaining > 0 && remaining <= 900_000); };
  fresh();
  if (input.operation === "stage") {
    requireValid(/^[A-Za-z0-9_-]+$/.test(input.install));
    const bytes = Buffer.from(input.install, "base64url");
    requireValid(bytes.toString("base64url") === input.install);
    let document: unknown;
    try { document = JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
    const install = RuntimeInstallInputSchema.safeParse(document);
    requireValid(install.success && install.data.purpose !== "workspace-setup" &&
      install.data.runtime.runtimeId !== input.source.runtimeId);
  } else {
    requireValid(input.target.runtimeId !== input.source.runtimeId);
    if (input.handoff) requireValid(input.mode === "engine" && input.handoff.workspaceId === input.scope.workspaceId &&
      input.handoff.organizationId === input.scope.organizationId && input.handoff.generation === input.scope.sourceGeneration &&
      input.handoff.engineInstanceId === input.scope.sourceEngineInstanceId && input.handoff.expiresAtMs > now() &&
      input.handoff.expiresAtMs <= Date.parse(input.expiresAt));
  }
  const scopeValue = { schema, transitionId: input.transitionId, fence: input.fence, scope: input.scope };
  let state = input.operation === "stage" ? "staging" : "offered";
  let controller: CloudActiveRuntime | null = null;
  let resident: CloudResidentWitness | undefined;
  let enrolled: CloudActiveRuntime | null = null;
  let enrollmentAllowed = false;
  let result: RuntimeUpdateResult | undefined;
  let processing = false;
  const context = () => ({ input, controller, ...(resident ? { resident } : {}) });
  const sameScope = (value: z.infer<typeof Frame> | RuntimeUpdateResult) =>
    value.transitionId === input.transitionId && value.fence === input.fence &&
    Object.entries(input.scope).every(([key, expected]) => value.scope[key as keyof typeof input.scope] === expected);
  const sameAllocation = (value: CloudActiveRuntime) =>
    value.baseCompatibilityId === input.source.baseCompatibilityId && value.bootId === input.source.bootId &&
    value.cgroupRoot === input.source.cgroupRoot;
  async function decide(call: () => Promise<boolean>): Promise<boolean> {
    try { return (await call()) === true; } catch { return false; }
  }
  return {
    input,
    async onFrame(line: string): Promise<string | undefined> {
      requireValid(!processing && !result && Buffer.byteLength(line) <= MAX_FRAME);
      processing = true;
      try {
        let value: unknown;
        try { value = JSON.parse(line); } catch { invalid(); }
        const terminal = Result.safeParse(value);
        if (terminal.success) {
          const v = terminal.data;
          requireValid(sameScope(v) && v.operation === input.operation);
          const expected = { staged: "staging", deferred: "deferred", healthy: "healthy", rolled_back: "rolled_back" };
          requireValid(v.outcome === "recovery_required"
            ? ["consumption_authorized", "activated", "enrolling", "health_failed", "healthy", "rollback", "rollback_enrolling", "rolled_back", "recovery_required"].includes(state)
            : state === expected[v.outcome]);
          if (v.outcome === "healthy" || v.outcome === "rolled_back")
            requireValid(v.active && enrolled && equal(v.active, enrolled));
          else requireValid(!v.active);
          result = v;
          return;
        }
        const parsedFrame = Frame.safeParse(value);
        requireValid(parsedFrame.success && sameScope(parsedFrame.data) && input.operation === "activate");
        const frame = parsedFrame.data;
        const { phase } = frame;
        let allow = false;
        let environment: Record<string, unknown> | null = null;
        requireValid(phase === "authorize_consumption" || !frame.handoff);
        requireValid(input.handoff || !frame.resident);
        if (phase === "authorize" || phase === "authorize_consumption") {
          requireValid(state === "offered" && !frame.active && !frame.report);
          requireValid((phase === "authorize_consumption") === !!input.handoff);
          fresh();
          if (input.mode === "engine") {
            requireValid(frame.controller && sameAllocation(frame.controller));
            controller = frame.controller;
          } else requireValid(!frame.controller);
          if (input.handoff) {
            requireValid(frame.handoff && sameHandoff(input.handoff, frame.handoff) && input.handoff.expiresAtMs > now() &&
              frame.resident && frame.resident.hostId === input.handoff.hostId && frame.resident.fence === input.handoff.fence &&
              frame.resident.engineId === input.scope.sourceEngineInstanceId && frame.resident.generation === input.scope.sourceGeneration &&
              frame.resident.workspaceId === input.scope.workspaceId && frame.resident.organizationId === input.scope.organizationId &&
              frame.resident.bootId === input.source.bootId);
            resident = frame.resident;
            allow = await decide(() => handlers.authorizeConsumption?.({ ...context(), resident: frame.resident!, receipt: frame.handoff! }) ?? Promise.resolve(false));
            state = allow ? "consumption_authorized" : "deferred";
          } else {
            allow = await decide(() => handlers.authorize(context()));
            state = allow ? "activated" : "deferred";
          }
        } else if (phase === "cancel_consumption") {
          requireValid(input.handoff && state === "consumption_authorized" && resident && frame.resident &&
            Object.entries(resident).every(([key, value]) => frame.resident![key as keyof CloudResidentWitness] === value) &&
            !frame.active && !frame.controller && !frame.report);
          allow = await decide(() => handlers.cancelConsumption?.({ ...context(), resident: frame.resident! }) ?? Promise.resolve(false));
          state = allow ? "deferred" : "recovery_required";
        } else if (phase === "consumed") {
          requireValid(input.handoff && state === "consumption_authorized" && resident && frame.resident &&
            detachedResident(resident, frame.resident) && !frame.active && !frame.controller && !frame.report);
          resident = frame.resident;
          allow = await decide(() => handlers.consumed?.({ ...context(), resident: frame.resident! }) ?? Promise.resolve(false));
          state = allow ? "activated" : "recovery_required";
        } else if (phase === "authorize_rollback") {
          requireValid(["activated", "enrolling", "health_failed", "healthy"].includes(state) &&
            !frame.active && !frame.report && !frame.controller && !frame.resident);
          allow = await decide(() => handlers.authorizeRollback(context()));
          state = allow ? "rollback" : "recovery_required";
          enrolled = null;
          enrollmentAllowed = false;
        } else if (phase === "enroll" || phase === "rollback_enroll") {
          const rollback = phase === "rollback_enroll";
          requireValid(state === (rollback ? "rollback" : "activated") && frame.active && frame.controller && frame.report);
          const active = frame.active;
          const pin = rollback ? input.source : input.target;
          requireValid(sameAllocation(active) && active.runtimeId === pin.runtimeId &&
            active.manifestSha256 === pin.manifestSha256 && active.supervisorSessionId !== input.source.supervisorSessionId);
          if (rollback) requireValid(active.installerReceiptSha256 === input.source.installerReceiptSha256);
          if (input.mode === "bootstrap") { requireValid(equal(frame.controller, active)); controller = active; }
          else requireValid(controller && equal(frame.controller, controller));
          if (input.handoff) {
            requireValid(resident && frame.resident && sameResidentHost(resident, frame.resident) && frame.resident.engineId === null &&
              frame.resident.fence >= resident.fence);
            resident = frame.resident;
          }
          const report = frame.report;
          const witness = CloudRuntimeWitnessSchema.safeParse(report.runtime);
          requireValid(report.version === 1 && report.profile === "zeros-cloud-worker-v4" && report.qualified === true &&
            witness.success && Object.entries(witness.data).every(([key, value]) => active[key as keyof CloudActiveRuntime] === value));
          try { environment = await handlers.enroll({ ...context(), active, report, rollback }); } catch { /* closed denial */ }
          requireValid(environment === null || typeof environment === "object" && !Array.isArray(environment));
          allow = environment !== null;
          enrollmentAllowed = allow;
          enrolled = active;
          state = rollback ? "rollback_enrolling" : "enrolling";
        } else {
          const rollback = phase === "rollback_health";
          requireValid(state === (rollback ? "rollback_enrolling" : "enrolling") && enrollmentAllowed && frame.active && enrolled &&
            equal(frame.active, enrolled) && !frame.controller && !frame.report);
          if (input.handoff) requireValid(resident && frame.resident && sameResidentHost(resident, frame.resident) &&
            frame.resident.fence === resident.fence + 1 && frame.resident.engineId !== null && frame.resident.engineId !== input.scope.sourceEngineInstanceId &&
            frame.resident.generation === (rollback ? input.scope.sourceGeneration : input.scope.candidateGeneration));
          allow = await decide(() => handlers.health({ ...context(), ...(frame.resident ? { resident: frame.resident } : {}), active: frame.active!, rollback }));
          state = rollback ? allow ? "rolled_back" : "recovery_required" : allow ? "healthy" : "health_failed";
        }
        const response = JSON.stringify({ ...scopeValue, phase, allow, ...(environment ? { environment } : {}) });
        requireValid(Buffer.byteLength(response) < MAX_FRAME);
        return response;
      } finally { processing = false; }
    },
    result() { if (!result) invalid(); return result; },
  };
}

/** No lifecycle trigger calls this yet. Its handlers must be backed by the
 * durable transition/enrollment service before automatic updates are enabled. */
export async function runRuntimeUpdate(resourceId: string, input: RuntimeUpdateInput, handlers: RuntimeUpdateHandlers,
  options: BoatPinnedSshOptions, signal: AbortSignal): Promise<RuntimeUpdateResult> {
  requireValid(/^bx_[A-Za-z0-9_-]{1,128}$/.test(resourceId));
  const conversation = createRuntimeUpdateConversation(input, handlers);
  const result = await executeBoatPinnedSsh({ resourceId, command: runtimeUpdateCommand(),
    stdin: runtimeUpdateProgram().source + JSON.stringify(conversation.input) + "\n",
    timeoutSeconds: input.operation === "stage" ? 930 : 1440,
    onFrame: conversation.onFrame,
  }, { ...options, maxOutputBytes: Math.min(options.maxOutputBytes, 512 * 1024) }, signal);
  requireValid(result.exitCode === 0 && !result.outputTruncated);
  return conversation.result();
}

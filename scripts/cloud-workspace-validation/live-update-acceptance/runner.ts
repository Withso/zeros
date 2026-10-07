import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { TEST_NAME_PREFIXES, type AlphaLiveUpdateAdapter, type Device, type Journal, type Observation,
  type Operation, type Report, type TestNamePrefix, type Workspace } from "./contract";

const uuid = z.uuid(), count = z.number().int().nonnegative().safe(), positive = count.positive();
const runtime = z.string().regex(/^r1-[a-f0-9]{8,64}$/);
const workspaceSchema = z.object({ organizationId: uuid, workspaceId: uuid }).strict();
export const namePrefixSchema = z.enum(TEST_NAME_PREFIXES);
export const operationSchema = z.object({ version: z.literal(1), operationId: uuid,
  name: z.string() }).strict()
  .refine(value => TEST_NAME_PREFIXES.some(prefix => value.name === `${prefix}-${value.operationId}`));
export const journalSchema = z.object({ version: z.literal(1), operationId: uuid,
  name: z.string(), organizationId: uuid.optional(), workspace: workspaceSchema.optional(),
  actions: z.object({ input: uuid, prompt: uuid, update: uuid, rollback: uuid,
    retryTurn: uuid.optional(), retryPrompt: uuid.optional() }).strict()
    .refine(value => (value.retryTurn === undefined) === (value.retryPrompt === undefined)).optional(),
  phase: z.enum(["allocated", "created", "cleanup_required", "cleaned"]) }).strict()
  .refine(value => operationSchema.safeParse({ version: value.version, operationId: value.operationId, name: value.name }).success)
  .refine(value => !value.organizationId || !value.workspace || value.organizationId === value.workspace.organizationId);
const identitySchema = z.object({ version: z.literal(1), channel: z.literal("alpha"), staff: z.literal(true), organizationId: uuid }).strict();
const preflightSchema = identitySchema.extend({ sourceRuntimeId: runtime, targetRuntimeId: runtime,
  capabilities: z.object({ residentHandoff: z.literal(true), freshProofs: z.literal(true), rollbackPair: z.literal(true),
    heldTurn: z.literal(true), inputAcknowledgements: z.literal(true), healthFailureInjection: z.literal(true),
    idempotentCreateAndCleanup: z.literal(true) }).strict() }).strict()
  .refine(value => value.sourceRuntimeId !== value.targetRuntimeId);
const observationSchema = workspaceSchema.extend({
  engine: z.object({ instanceId: uuid, generation: positive, runtimeId: runtime, authorityEpoch: positive, proofId: uuid,
    residentFence: positive, hostId: uuid, allocationId: uuid, bootId: uuid, controllerRuntimeId: runtime, hostRuntimeId: runtime }).strict(),
  workload: z.object({ terminalPid: positive, serverPid: positive, serverCounter: count,
    fileDigest: z.string().regex(/^[a-f0-9]{64}$/), inputs: z.array(z.object({ operationId: uuid, applications: count }).strict()).max(8) }).strict(),
  turn: z.object({ operationId: uuid, state: z.enum(["running", "completed"]), executions: count, runtimeId: runtime }).strict(),
  commands: z.array(z.object({ operationId: uuid, commandId: uuid, state: z.enum(["queued", "running", "completed"]),
    starts: count, completions: count, runtimeId: runtime.nullable() }).strict()).max(8),
}).strict();
class Failure extends Error { constructor(readonly code: string) { super(code); } }
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Failure(code); }
function parsed<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value); check(result.success, code); return result.data;
}

/** The adapter must cancel I/O on abort. Race every call as a second bound;
 * uncertain mutations remain recoverable by the already-journaled operation. */
async function call<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const local = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  local.throwIfAborted();
  let aborted!: () => void;
  try {
    return await Promise.race([Promise.resolve().then(() => work(local)), new Promise<never>((_resolve, reject) => {
      aborted = () => reject(new Failure("deadline_exceeded")); local.addEventListener("abort", aborted, { once: true });
    })]);
  } finally { local.removeEventListener("abort", aborted); }
}

type Options = { journal(record: Journal): Promise<void>; now?: () => number; timeoutMs?: number;
  probeTimeoutMs?: number; cleanupTimeoutMs?: number; pollMs?: number; signal?: AbortSignal; namePrefix?: TestNamePrefix };

function retainedWorkload(before: Observation, after: Observation): void {
  check(before.workspaceId === after.workspaceId && before.organizationId === after.organizationId, "scope_changed");
  for (const key of ["hostId", "allocationId", "bootId", "controllerRuntimeId", "hostRuntimeId"] as const)
    check(before.engine[key] === after.engine[key], "resident_identity_changed");
  for (const key of ["terminalPid", "serverPid", "fileDigest"] as const)
    check(before.workload[key] === after.workload[key], "workload_changed");
  check(after.workload.serverCounter >= before.workload.serverCounter, "server_counter_regressed");
  check(new Set(after.workload.inputs.map(row => row.operationId)).size === after.workload.inputs.length &&
    after.workload.inputs.every(row => row.applications === 1), "input_replayed");
  check(before.workload.inputs.every(row => after.workload.inputs.some(next =>
    next.operationId === row.operationId && next.applications === row.applications)), "replay_missing");
  check(new Set(after.commands.map(row => row.operationId)).size === after.commands.length, "command_duplicated");
  for (const command of before.commands) if (command.state === "completed") {
    const current = after.commands.find(row => row.operationId === command.operationId);
    check(current?.commandId === command.commandId && current.state === "completed" && current.starts === 1 &&
      current.completions === 1 && current.runtimeId === command.runtimeId, "command_replayed");
  }
}
function retained(before: Observation, after: Observation): void {
  retainedWorkload(before, after);
  check(after.turn.operationId === before.turn.operationId && after.turn.executions === 1 &&
    after.turn.runtimeId === before.turn.runtimeId, "turn_replayed");
}
function unchangedEngine(before: Observation, after: Observation, code: string): void {
  check((Object.keys(before.engine) as Array<keyof Observation["engine"]>)
    .every(key => before.engine[key] === after.engine[key]), code);
}

export async function cleanupAcceptance(adapter: AlphaLiveUpdateAdapter, operation: Operation, options: Options,
  workspace?: Workspace, actions?: Journal["actions"], organizationId?: string): Promise<boolean> {
  const signal = AbortSignal.timeout(options.cleanupTimeoutMs ?? 90_000);
  const expectedOrganizationId = organizationId ?? workspace?.organizationId;
  const record = { ...operation, organizationId: expectedOrganizationId, workspace, actions };
  try {
    parsed(uuid, expectedOrganizationId, "scope_unknown");
    check(!workspace || workspace.organizationId === expectedOrganizationId, "scope_changed");
    const identity = parsed(identitySchema, await call(signal, s => adapter.identity(s), 10_000), "identity_invalid");
    check(expectedOrganizationId === identity.organizationId, "scope_changed");
  } catch {
    await options.journal({ ...record, phase: "cleanup_required" }).catch(() => undefined);
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await call(signal, s => adapter.cleanup(operation, s));
      const evidence = z.object({ complete: z.boolean(), remainingResources: count }).strict().safeParse(result);
      if (evidence.success && evidence.data.complete && evidence.data.remainingResources === 0) {
        await options.journal({ ...record, phase: "cleaned" }); return true;
      }
    } catch { /* Only closed cleanup state is reported; retain the operation. */ }
    if (signal.aborted) break;
  }
  await options.journal({ ...record, phase: "cleanup_required" }).catch(() => undefined);
  return false;
}

/** No default adapter, URLs or live-provider calls. HU implements the reviewed
 * port; this runner owns the invariant checks, timing and cleanup decision. */
export async function runAcceptance(adapter: AlphaLiveUpdateAdapter, options: Options): Promise<Report> {
  const operationId = randomUUID();
  const operation: Operation = { version: 1, operationId, name: `${options.namePrefix ?? "zeros-v2-test-lu"}-${operationId}` };
  const actions = { input: randomUUID(), prompt: randomUUID(), update: randomUUID(), rollback: randomUUID(),
    retryTurn: randomUUID(), retryPrompt: randomUUID() };
  const report: Report = { version: 1, operationId, outcome: "failed", code: "adapter_failed", cleaned: true };
  const now = options.now ?? (() => performance.now());
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 300_000), ...(options.signal ? [options.signal] : [])]);
  const devices: Device[] = [];
  let workspace: Workspace | undefined, organizationId: string | undefined, mustClean = false;
  try {
    parsed(operationSchema, operation, "operation_invalid");
    let preflight;
    try { preflight = parsed(preflightSchema, await call(signal, s => adapter.preflight(s)), "capability_unqualified"); }
    catch { report.outcome = "blocked"; report.code = "capability_unqualified"; return report; }
    organizationId = preflight.organizationId;
    await options.journal({ ...operation, organizationId, actions, phase: "allocated" });
    mustClean = true; report.cleaned = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        workspace = parsed(workspaceSchema, await call(signal, s => adapter.provision(operation, preflight.sourceRuntimeId, s)), "scope_invalid");
        break;
      } catch (error) { if (error instanceof Failure || signal.aborted || attempt === 2) throw error; }
    }
    check(workspace && workspace.organizationId === preflight.organizationId, "scope_invalid");
    report.workspaceId = workspace.workspaceId;
    await options.journal({ ...operation, organizationId, workspace, actions, phase: "created" });
    for (const device of ["a", "b"] as const) devices.push(await call(signal, s => adapter.connect(workspace!, device, s)));
    await call(signal, s => devices[0].startWorkload({ operationId, terminalId: operation.name }, s));
    const observe = async (device: Device): Promise<Observation> => {
      const result = parsed(observationSchema, await call(signal, s => device.observe(s), options.probeTimeoutMs ?? 750), "observation_invalid");
      check(result.organizationId === workspace!.organizationId && result.workspaceId === workspace!.workspaceId, "scope_changed");
      return result;
    };
    const source = await Promise.all(devices.map(observe));
    const instances = new Set(source.map(state => state.engine.instanceId)), proofs = new Set(source.map(state => state.engine.proofId));
    for (const state of source) {
      check(state.engine.runtimeId === preflight.sourceRuntimeId && state.turn.state === "running" &&
        state.turn.operationId === operationId && state.turn.executions === 1, "source_invalid");
      retained(source[0], state);
      unchangedEngine(source[0], state, "device_identity_mismatch");
    }
    const inputId = actions.input;
    const input = async () => {
      const ack = await call(signal, s => devices[0].input(inputId, s));
      check(ack?.operationId === inputId && ack.applications === 1, "input_ack_invalid");
    };
    await input(); await input();
    const stage = async (before: Observation[]) => {
      await call(signal, s => adapter.stage(workspace!, preflight.targetRuntimeId, s));
      for (const [index, device] of devices.entries()) {
        const staged = await observe(device); retained(before[index], staged);
        unchangedEngine(before[index], staged, "staging_interrupted_work");
        check(staged.turn.state === "running", "staging_interrupted_work");
      }
    };
    await stage(source);

    const transition = async (before: Observation[], rollback: boolean, promptId: string): Promise<Observation[]> => {
      const targetRuntimeId = preflight.targetRuntimeId;
      const resultRuntimeId = rollback ? before[0].engine.runtimeId : targetRuntimeId;
      let complete = false, outcome: unknown, failed = false;
      const last = before.map(() => now()), first: Array<number | null> = [null, null];
      const request = { workspace: workspace!, operationId: rollback ? actions.rollback : actions.update, targetRuntimeId, failTargetHealth: rollback };
      // Catch immediately: an adapter failure must not leak through an
      // unhandled rejection while the runner probes or releases the turn.
      const flight = call(signal, s => adapter.handoff(request, s), 240_000).then(value => {
        outcome = value; complete = true;
      }, () => { failed = true; complete = true; });
      const reply = await call(signal, s => devices[1].enqueue(promptId, s));
      parsed(uuid, reply?.commandId, "command_invalid");
      const duplicate = await call(signal, s => devices[1].enqueue(promptId, s));
      check(duplicate.commandId === reply.commandId, "command_duplicated");
      for (const [index, device] of devices.entries()) {
        const draining = await observe(device); last[index] = now();
        retained(before[index], draining); unchangedEngine(before[index], draining, "turn_interrupted");
        check(draining.turn.state === "running", "turn_interrupted");
        const command = draining.commands.find(row => row.operationId === promptId);
        check(command?.commandId === reply.commandId && command.state === "queued" && command.starts === 0 && command.completions === 0,
          "queue_crossed_drain");
      }
      check(!complete, "handoff_did_not_drain");
      await call(signal, s => devices[0].releaseTurn(s));
      let after: Array<Observation | undefined> = [undefined, undefined];
      while (!complete || after.some(value => !value)) {
        signal.throwIfAborted(); check(!failed, "handoff_failed");
        await Promise.all(devices.map(async (device, index) => {
          // A probe started before the adapter confirms health/rollback may
          // describe a provisional attachment. Require another round trip
          // after that confirmation before accepting final evidence.
          const confirmed = complete;
          let state: Observation;
          try { state = await observe(device); }
          catch (error) {
            if (error instanceof Failure && error.code !== "deadline_exceeded") throw error;
            return; // The reconnect outage is measured, never inferred healthy.
          }
          retained(before[index], state);
          if (state.engine.instanceId === before[index].engine.instanceId) {
            check(!confirmed, "fresh_proof_missing");
            check(first[index] === null, "late_source_response"); last[index] = now(); return;
          }
          if (first[index] === null) first[index] = now();
          check(state.engine.runtimeId === resultRuntimeId, "runtime_mismatch");
          check(state.engine.proofId !== before[index].engine.proofId && state.engine.authorityEpoch > before[index].engine.authorityEpoch &&
            state.engine.residentFence > before[index].engine.residentFence && !instances.has(state.engine.instanceId) &&
            !proofs.has(state.engine.proofId), "fresh_proof_missing");
          if (!rollback) check(state.engine.generation > before[index].engine.generation, "generation_not_advanced");
          check(state.turn.state === "completed", "turn_interrupted");
          check(state.workload.inputs.some(row => row.operationId === inputId && row.applications === 1), "replay_missing");
          const command = state.commands.find(row => row.operationId === promptId);
          check(command?.commandId === reply.commandId && command.starts <= 1 && command.completions <= 1, "command_duplicated");
          if (command.state !== "completed") return;
          check(command.starts === 1 && command.completions === 1 && command.runtimeId === resultRuntimeId, "command_runtime_invalid");
          if (confirmed) after[index] = state;
        }));
        if (!complete || after.some(value => !value)) await delay(options.pollMs ?? 50, undefined, { signal });
      }
      await flight;
      check(!failed && outcome === (rollback ? "rolled_back" : "updated"), "handoff_failed");
      const gap = Math.ceil(Math.max(...first.map((time, index) => time! - last[index])));
      check(gap >= 0 && gap <= 2000, "reconnect_gap_exceeded");
      if (rollback) report.rollbackGapMs = gap; else report.updateGapMs = gap;
      const verified = after as Observation[];
      unchangedEngine(verified[0], verified[1], "device_identity_mismatch");
      check(verified.every((state, index) => state.workload.serverCounter > before[index].workload.serverCounter), "server_stalled");
      instances.add(verified[0].engine.instanceId); proofs.add(verified[0].engine.proofId);
      return verified;
    };

    // A rejected B must first recover a fresh A. A healthy retry still selects
    // newer B; accepting an explicit B -> A downgrade is never required.
    const rollback = await transition(source, true, actions.prompt);
    await input(); // Lost-reply retry after an actual engine change.
    const retryPrompt = async (state: Observation, promptId: string) => {
      const command = state.commands.find(row => row.operationId === promptId)!;
      const duplicate = await call(signal, s => devices[1].enqueue(promptId, s));
      check(duplicate.commandId === command.commandId, "command_duplicated");
    };
    await retryPrompt(rollback[0], actions.prompt);
    await call(signal, s => devices[0].holdTurn(actions.retryTurn, s));
    const retry = await Promise.all(devices.map(observe));
    for (const [index, state] of retry.entries()) {
      retainedWorkload(rollback[index], state); unchangedEngine(rollback[index], state, "retry_source_invalid");
      check(state.turn.operationId === actions.retryTurn && state.turn.state === "running" && state.turn.executions === 1 &&
        state.turn.runtimeId === preflight.sourceRuntimeId, "retry_source_invalid");
    }
    await stage(retry);
    const target = await transition(retry, false, actions.retryPrompt);
    await input();
    await retryPrompt(target[0], actions.prompt); await retryPrompt(target[0], actions.retryPrompt);
    for (const [index, device] of devices.entries()) {
      const final = await observe(device); retained(target[index], final);
      unchangedEngine(target[index], final, "device_identity_mismatch"); check(final.turn.state === "completed", "turn_replayed");
    }
    report.outcome = "passed"; report.code = "accepted";
  } catch (error) {
    report.outcome = "failed";
    report.code = error instanceof Failure ? error.code : signal.aborted ? "deadline_exceeded" : "adapter_failed";
  } finally {
    controller.abort(); // Stop probes/uncertain transition calls before cleanup.
    await Promise.allSettled(devices.map(device => call(AbortSignal.timeout(2000), () => device.close(), 2000)));
    if (mustClean) {
      report.cleaned = await cleanupAcceptance(adapter, operation, options, workspace, actions, organizationId);
      if (!report.cleaned) { report.outcome = "cleanup_required"; report.code = "cleanup_unconfirmed"; }
    }
  }
  return report;
}

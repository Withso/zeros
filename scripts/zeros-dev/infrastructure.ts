import { setTimeout as delay } from "node:timers/promises";
import type { Run, RunHandle } from "./receipts";
import type { ZerosDevRuntime } from "./runtime";
import type { InfrastructureNative, InfrastructureNativeIntent, InfrastructureNativeTask } from "./infrastructure-native";
import type { AdmissionObservation } from "./admission-observation";
import type { SetupObservation } from "./setup-observation";
import { InfrastructureSchema, INFRASTRUCTURE_TOTAL_MS, INFRASTRUCTURE_DETACHED_MS, INFRASTRUCTURE_LAUNCH_AUTH_MS,
  INFRASTRUCTURE_DISCONNECT_MS, LaunchAuthObservationSchema, type LaunchAuthObservation } from "./infrastructure-contract";
import { HOURLY_COMPUTER_MS, HOURLY_CLEANUP_MS, prepareHourlyComputer, recordStoragePending, type HourlyOptions } from "./hourly";
import { ZerosDevError } from "./errors";
import { requireComputeCleanup } from "./cleanup-state";
import { beforeDeadline } from "./transport";
import type { Evidence } from "./evidence";

type Runtime = Pick<ZerosDevRuntime, "client" | "scope" | "terminal" | "dispose" | "detachTransport" | "transport" | "admission">;
type Native = Pick<InfrastructureNative, "begin" | "finish" | "cleanup">;
export type InfrastructureOptions = Omit<HourlyOptions, "credentials" | "connect" | "workMs" | "computerMs"> & {
  connect(run: Run, signal: AbortSignal, onAdmissionEvent?: (event: AdmissionObservation) => void): Promise<Runtime>;
  prepareLaunchAuth(requiredMs: number): Promise<LaunchAuthObservation>;
  native(runtime: Runtime, handle: RunHandle, options: { persistIntent(intent: InfrastructureNativeIntent): Promise<void> }): Native;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** Owner option B's native-only fixture scope. It never publishes credentials,
 * prompts an agent, reads chat or upgrades native proof to agent coverage. */
export async function runInfrastructure(options: InfrastructureOptions): Promise<void> {
  const { handle, api, evidence } = options, hourly = handle.run.hourly;
  if (!hourly?.infrastructure || hourly.rehearsal || hourly.startedAt || hourly.complete || hourly.credentials.length || hourly.histories.length ||
    handle.run.create || handle.run.prompts.length || handle.run.lifecycle.length) throw new ZerosDevError("operation_conflict");
  const proof = hourly.infrastructure;
  const clock = options.monotonic ?? (() => performance.now()), now = options.now ?? Date.now;
  const pause = options.sleep ?? (async (ms, signal) => {
    try { await delay(ms, undefined, { signal }); } catch { throw new ZerosDevError("deadline"); }
  });
  const budget = AbortSignal.timeout(Math.min(options.budgetMs ?? INFRASTRUCTURE_TOTAL_MS - HOURLY_CLEANUP_MS, INFRASTRUCTURE_TOTAL_MS - HOURLY_CLEANUP_MS));
  const overall = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  const bound = (ms: number) => AbortSignal.any([overall, AbortSignal.timeout(ms)]);
  const step = <T>(phase: Parameters<Evidence["step"]>[0], ms: number, work: (signal: AbortSignal) => Promise<T>, signal = bound(ms)) =>
    evidence.step(phase, () => {
      if (signal.aborted) throw new ZerosDevError("deadline");
      return beforeDeadline(work(signal), signal);
    });
  const priorEvidence = [...handle.run.evidence];
  const checkpoint = async () => {
    handle.run.evidence = [...priorEvidence, ...evidence.events].slice(-256);
    await handle.save();
  };
  const owned = new Set<Runtime>(), detached = new Set<Runtime>();
  const windows = new Map<Runtime, { start: number; end: number; readyObservedAt: string; workCompletedAt: string }>();
  const observedWork = (runtime: Runtime) => {
    const window = windows.get(runtime);
    if (window) { window.end = clock(); window.workCompletedAt = new Date(now()).toISOString(); }
  };
  const recordWindow = (runtime: Runtime) => {
    const window = windows.get(runtime);
    if (window) {
      hourly.activeWindows.push({ readyObservedAt: window.readyObservedAt, workCompletedAt: window.workCompletedAt,
        durationMs: Math.max(0, window.end - window.start) });
      windows.delete(runtime);
    }
  };
  const recordTransport = (runtime: Runtime) => {
    const transport = runtime.transport(), index = proof.transports.findIndex(row => row.connectionId === transport.connectionId);
    if (index < 0) proof.transports.push(transport); else proof.transports[index] = transport;
    evidence.emit({ phase: "runtime_transport", outcome: "ok", durationMs: 0, transport });
  };
  const assertContinuous = (runtime: Runtime) => {
    const transport = runtime.transport();
    if (transport.coverage !== "complete" || transport.lostConnections || transport.unexplainedAuthorityCloses)
      throw new ZerosDevError("transport_interrupted", undefined, undefined, undefined, undefined, undefined, transport);
  };
  const connect = async (phase: "runtime_connect" | "detached_reconnect" = "runtime_connect") => {
    const started = clock();
    return evidence.step(phase, async () => {
      const signal = bound(30_000);
      if (signal.aborted) throw new ZerosDevError("deadline");
      const pending = new AbortController();
      const cancelPending = () => pending.abort(signal.reason);
      signal.addEventListener("abort", cancelPending, { once: true });
      // The phase may cancel pending admission; only the overall budget owns
      // the admitted runtime's lifetime after connect has completed.
      const lifetime = AbortSignal.any([overall, pending.signal]);
      try {
        return await beforeDeadline(options.connect(handle.run, lifetime, admission => evidence.emit({ phase: "runtime_admission", outcome: "pending",
          durationMs: Math.max(0, clock() - started), code: "runtime_unavailable", count: admission.retryCount, admission })).then(async runtime => {
          signal.removeEventListener("abort", cancelPending);
          if (signal.aborted) {
            await beforeDeadline(runtime.dispose(), AbortSignal.timeout(3000)).catch(() => {});
            throw new ZerosDevError("deadline");
          }
          owned.add(runtime);
          const at = clock(), utc = new Date(now()).toISOString();
          windows.set(runtime, { start: at, end: at, readyObservedAt: utc, workCompletedAt: utc });
          return runtime;
        }), signal);
      } finally {
        signal.removeEventListener("abort", cancelPending);
      }
    }, value => value.admission);
  };
  const close = async (runtime: Runtime) => {
    let failure: unknown;
    try { await step("runtime_disconnect", 3000, () => runtime.dispose(), AbortSignal.timeout(3000)); } catch (error) { failure = error; }
    try { recordWindow(runtime); recordTransport(runtime); await checkpoint(); } catch (error) { failure ??= error; }
    owned.delete(runtime);
    if (failure) throw failure;
  };
  const ready = (phase: "workspace_create_wait" | "workspace_resume_wait") => step(phase, 180_000, async signal => {
    let setup: SetupObservation | undefined;
    await api.waitWorkspace(handle, "running", signal, value => { setup = value; });
    if (!setup || setup.state !== "succeeded") throw new ZerosDevError("setup_observation_unavailable", undefined, undefined, setup);
    if (setup.claimCount !== 1 || setup.errorCode !== null) throw new ZerosDevError("setup_retried", undefined, undefined, setup);
    evidence.emit({ phase: "workspace_setup", outcome: "ok", durationMs: 0, setup }); return setup;
  });
  const directory = `.zeros-dev-${handle.run.runId}`;
  const files = async (runtime: Runtime, index: number) => {
    const prior = Array.from({ length: index }, (_, n) => `test "$(cat '${directory}/marker-${n}.txt')" = '${handle.run.runId}.${n}'`).join("; ");
    const script = `set -eu; git rev-parse --is-inside-work-tree; ${index ? `test -d '${directory}'; ${prior}` : `mkdir '${directory}'`}; ` +
      `(set -C; printf '%s\\n' '${handle.run.runId}.${index}' > '${directory}/marker-${index}.txt'); ` +
      `test "$(cat '${directory}/marker-${index}.txt')" = '${handle.run.runId}.${index}'`;
    await step("file_edit", 60_000, async signal => {
      assertContinuous(runtime);
      const result = await runtime.terminal(handle, { script }, signal);
      if (result.exitCode !== 0 || result.truncated) throw new ZerosDevError("terminal_failed");
      assertContinuous(runtime); observedWork(runtime); proof.fileChecks++; proof.terminalChecks++; await checkpoint();
    });
  };
  const native = (runtime: Runtime) => options.native(runtime, handle, { persistIntent: async intent => {
    if (proof.intent) throw new ZerosDevError("operation_conflict");
    proof.intent = intent; await checkpoint();
  } });
  let failure: unknown, task: InfrastructureNativeTask | undefined, taskRuntime: Runtime | undefined, taskHelper: Native | undefined;
  hourly.startedAt = new Date(now()).toISOString(); await checkpoint();
  try {
    const preparation = bound(HOURLY_COMPUTER_MS);
    await step("prior_cleanup", HOURLY_COMPUTER_MS, signal => api.assertFixtureEmpty(signal, options.predecessors), preparation);
    await step("repository", HOURLY_COMPUTER_MS, signal => api.ensureRepository(signal), preparation);
    const { active, target, assertPin } = await prepareHourlyComputer(options, preparation);
    proof.runtimePin = { buildId: active.id, version: active.version, ...target }; await checkpoint();
    await step("computer_pin", 30_000, signal => assertPin(signal));
    await step("prior_cleanup", 30_000, signal => api.assertFixtureEmpty(signal, options.predecessors));
    await step("workspace_create", 30_000, signal => api.createWorkspace(handle, signal));
    proof.initialSetup = await ready("workspace_create_wait"); await checkpoint();
    let runtime = await connect();
    await files(runtime, 0);
    for (let index = 1; index <= 3; index++) {
      await close(runtime);
      const stopStart = clock();
      await step("workspace_stop", 30_000, signal => api.lifecycle(handle, "stop", signal));
      await step("workspace_stop_wait", 180_000, signal => api.waitWorkspace(handle, "stopped", signal));
      const stopMs = clock() - stopStart, stoppedAt = new Date(now()).toISOString(), wakeAt = clock();
      await step("workspace_resume", 30_000, signal => api.lifecycle(handle, "wake", signal));
      const setup = await ready("workspace_resume_wait"), resumeMs = clock() - wakeAt, readyAt = new Date(now()).toISOString();
      runtime = await connect(); await files(runtime, index);
      proof.cycles.push({ index, stopMs, resumeMs, usableMs: clock() - wakeAt, stoppedAt, readyAt, setup }); await checkpoint();
    }
    const authAt = clock(), launchAuth = await step("detached_auth", 30_000, async () => {
      const observed = LaunchAuthObservationSchema.safeParse(await options.prepareLaunchAuth(INFRASTRUCTURE_LAUNCH_AUTH_MS));
      if (!observed.success || Date.parse(observed.data.expiresAt) - now() <= INFRASTRUCTURE_LAUNCH_AUTH_MS)
        throw new ZerosDevError("detached_auth_window");
      return observed.data;
    });
    taskRuntime = runtime; taskHelper = native(runtime);
    task = await step("detached_start", 90_000, signal => taskHelper!.begin(signal));
    proof.task = task; observedWork(runtime); await checkpoint();
    let detachedAt = 0, detachedStartedAt = "";
    await step("detached_disconnect", INFRASTRUCTURE_DISCONNECT_MS, async () => {
      // Bound launch only. The resident PTY keeps its normal engine/workload
      // lifetime; reconnect must authenticate afresh after the offline wait.
      if (Math.min(launchAuth.remainingMs - (clock() - authAt), Date.parse(launchAuth.expiresAt) - now()) <= INFRASTRUCTURE_DISCONNECT_MS)
        throw new ZerosDevError("detached_auth_window");
      assertContinuous(runtime);
      runtime.detachTransport(); detached.add(runtime);
      detachedAt = clock(); detachedStartedAt = new Date(now()).toISOString();
      recordWindow(runtime); recordTransport(runtime); await checkpoint();
    });
    // Only this monotonic wait runs while disconnected. No token refresh,
    // runtime/CP read, hidden transport or native helper remains scheduled.
    await step("detached_wait", INFRASTRUCTURE_DETACHED_MS + 10_000, async signal => {
      await pause(INFRASTRUCTURE_DETACHED_MS, signal);
      if (clock() - detachedAt < INFRASTRUCTURE_DETACHED_MS)
        throw new ZerosDevError("detached_proof_incomplete");
    });
    const durationMs = clock() - detachedAt, completedAt = new Date(now()).toISOString();
    runtime = await connect("detached_reconnect"); taskRuntime = runtime; taskHelper = native(runtime);
    const detachedProof = await step("detached_native_proof", 180_000, async signal => {
      const nativeProof = await taskHelper!.finish(task!, signal);
      assertContinuous(runtime);
      const candidate = { startedAt: detachedStartedAt, completedAt, durationMs, launchAuth, proof: nativeProof };
      if (!InfrastructureSchema.safeParse({ ...proof, detached: candidate }).success) throw new ZerosDevError("detached_proof_incomplete");
      return candidate;
    });
    observedWork(runtime); proof.detached = detachedProof;
    hourly.activeWindows.push({ readyObservedAt: detachedStartedAt, workCompletedAt: completedAt, durationMs }); await checkpoint();
    await step("computer_pin", 30_000, signal => assertPin(signal));
  } catch (error) {
    failure = error;
    // Preserve the original closed stage before the helper or product cleanup
    // can mutate the resource or fail independently.
    try { await checkpoint(); } catch { /* The first failure remains primary. */ }
  } finally {
    if (task && taskHelper && taskRuntime && !detached.has(taskRuntime)) {
      try { await step("native_cleanup", 10_000, signal => taskHelper!.cleanup(task!, signal), AbortSignal.timeout(10_000)); }
      catch (error) { failure ??= error; }
    }
    for (const runtime of owned) { try { await close(runtime); } catch (error) { failure ??= error; } }
    const cleanupMs = Math.min(options.cleanupMs ?? HOURLY_CLEANUP_MS, HOURLY_CLEANUP_MS);
    try { await step("cleanup", cleanupMs, async signal => {
      await api.cleanup(handle, true, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, cleanupMs - 30_000))]), { allowStoragePending: true });
      requireComputeCleanup(handle.run); recordStoragePending(evidence, handle.run);
    }, AbortSignal.timeout(cleanupMs)); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  await step("infrastructure_proof", 1000, async () => {
    if (!InfrastructureSchema.safeParse({ ...proof, complete: true }).success) throw new ZerosDevError("detached_proof_incomplete");
  }, AbortSignal.timeout(1000));
  proof.complete = true;
  // hourly.complete deliberately remains false; agent/UI coverage is the
  // separately recorded owner's test, never inferred from this native task.
  await checkpoint();
}

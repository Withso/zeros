import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { RELEASE_CANARY_SMOKE_MODELS } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import type { Run, RunHandle } from "./receipts";
import type { ProductApi } from "./product";
import type { ZerosDevRuntime } from "./runtime";
import { Evidence } from "./evidence";
import { ZerosDevError } from "./errors";
import { beforeDeadline } from "./transport";
import { Gate0Runtime } from "./gate0-runtime";
import { Gate0Schema, GATE0_WORK_MS, GATE0_DETACHED_MS, GATE0_TICK_MS, GATE0_TOTAL_MS } from "./gate0-contract";
import { HOURLY_AGENTS, HOURLY_COMPUTER_MS, HOURLY_CLEANUP_MS, historyDigest, prepareHourlyComputer, type HourlyOptions } from "./hourly";
import type { AdmissionObservation } from "./admission-observation";
import type { SetupObservation } from "./setup-observation";

type Runtime = Pick<ZerosDevRuntime, "prompt" | "tail" | "terminal" | "dispose" | "detachTransport" | "transport" | "admission">;
type Probe = Pick<Gate0Runtime, "models" | "begin" | "finish">;
export type Gate0Options = Omit<HourlyOptions, "connect" | "workMs" | "computerMs"> & {
  connect(run: Run, signal: AbortSignal, onAdmissionEvent?: (event: AdmissionObservation) => void): Promise<Runtime>;
  prepareDetachedAuth(requiredMs: number): Promise<number>;
  probe(runtime: Runtime, handle: RunHandle): Probe;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** One owner-dispatched rehearsal. Durations are constants, not dispatch
 * inputs: shortening a run must never create a one-hour/30-minute proof. */
export async function runGate0(options: Gate0Options): Promise<void> {
  const { handle, api, credentials, evidence } = options, hourly = handle.run.hourly;
  if (!hourly || hourly.startedAt || handle.run.create || handle.run.prompts.length || handle.run.lifecycle.length || !hourly.rehearsal)
    throw new ZerosDevError("operation_conflict");
  const gate = hourly.rehearsal, clock = options.monotonic ?? (() => performance.now()), now = options.now ?? Date.now;
  const pause = options.sleep ?? (async (ms, signal) => { try { await delay(ms, undefined, { signal }); } catch { throw new ZerosDevError("deadline"); } });
  const budget = AbortSignal.timeout(Math.min(options.budgetMs ?? GATE0_TOTAL_MS - HOURLY_CLEANUP_MS, GATE0_TOTAL_MS - HOURLY_CLEANUP_MS));
  const overall = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  const phaseBound = (ms: number) => AbortSignal.any([overall, AbortSignal.timeout(ms)]);
  const step = <T>(phase: Parameters<Evidence["step"]>[0], ms: number, work: (signal: AbortSignal) => Promise<T>, bound = phaseBound(ms)) =>
    evidence.step(phase, () => {
      if (bound.aborted) throw new ZerosDevError("deadline");
      return beforeDeadline(work(bound), bound);
    });
  const owned = new Set<Runtime>();
  const recordTransport = (runtime: Runtime) => {
    const transport = runtime.transport(), index = gate.transports.findIndex(row => row.connectionId === transport.connectionId);
    if (index < 0) gate.transports.push(transport); else gate.transports[index] = transport;
    evidence.emit({ phase: "runtime_transport", outcome: "ok", durationMs: 0, transport });
  };
  const assertContinuous = (runtime: Runtime) => {
    const value = runtime.transport();
    if (value.coverage !== "complete" || value.lostConnections || value.unexplainedAuthorityCloses) throw new ZerosDevError("transport_interrupted");
  };
  const connect = async (phase: "runtime_connect" | "detached_reconnect" = "runtime_connect") => {
    const started = clock();
    const runtime = await evidence.step(phase, () => {
      const signal = phaseBound(30_000);
      return beforeDeadline(options.connect(handle.run, overall, admission => evidence.emit({ phase: "runtime_admission", outcome: "pending",
        durationMs: Math.max(0, clock() - started), code: "runtime_unavailable", count: admission.retryCount, admission })).then(async value => {
        if (signal.aborted) {
          await beforeDeadline(value.dispose(), AbortSignal.timeout(3000)).catch(() => {});
          throw new ZerosDevError("deadline");
        }
        owned.add(value); return value;
      }), signal);
    }, value => value.admission);
    return runtime;
  };
  const close = async (runtime: Runtime) => {
    let failure: unknown;
    try { await step("runtime_disconnect", 3000, () => runtime.dispose(), AbortSignal.timeout(3000)); } catch (error) { failure = error; }
    try { recordTransport(runtime); await handle.save(); } catch (error) { failure ??= error; }
    owned.delete(runtime);
    if (failure) throw failure;
  };
  const terminal = async (runtime: Runtime, script: string) => step("terminal_run", 60_000, async signal => {
    const result = await runtime.terminal(handle, { script }, signal);
    if (result.exitCode !== 0 || result.truncated) throw new ZerosDevError("terminal_failed");
  });
  const histories = async (runtime: Runtime) => {
    for (const row of hourly.histories) await step("chat_continuity", 30_000, async signal => {
      if (historyDigest(await runtime.tail(row.promptId, signal)) !== row.sha256) throw new ZerosDevError("history_changed");
    });
  };
  const ready = (phase: "workspace_create_wait" | "workspace_resume_wait") => step(phase, 180_000, async signal => {
    let setup: SetupObservation | undefined;
    await api.waitWorkspace(handle, "running", signal, value => { setup = value; });
    if (!setup || setup.state !== "succeeded") throw new ZerosDevError("setup_observation_unavailable", undefined, undefined, setup);
    if (setup.claimCount !== 1 || setup.errorCode !== null) throw new ZerosDevError("setup_retried", undefined, undefined, setup);
    evidence.emit({ phase: "workspace_setup", outcome: "ok", durationMs: 0, setup });
    return setup;
  });
  hourly.startedAt = new Date(now()).toISOString(); await handle.save();
  let failed: unknown;
  try {
    const preparation = phaseBound(HOURLY_COMPUTER_MS);
    await step("prior_cleanup", HOURLY_COMPUTER_MS, signal => api.assertFixtureEmpty(signal), preparation);
    await step("repository", HOURLY_COMPUTER_MS, signal => api.ensureRepository(signal), preparation);
    const { assertPin } = await prepareHourlyComputer(options, preparation);
    await step("credentials_install", 90_000, signal => credentials.install(handle, signal));
    await step("computer_pin", 30_000, signal => assertPin(signal));
    await step("workspace_create", 30_000, signal => api.createWorkspace(handle, signal));
    gate.initialSetup = await ready("workspace_create_wait"); await handle.save();
    let runtime = await connect();
    gate.models = await step("model_eligibility", 60_000, signal => options.probe(runtime, handle).models(signal)); await handle.save();
    const directory = `.zeros-dev-${handle.run.runId}`;
    await terminal(runtime, `set -eu; git rev-parse --is-inside-work-tree; mkdir '${directory}'`);
    const workStart = clock(), startedAt = new Date(now()).toISOString();
    const work = gate.workload = { startedAt, completedAt: startedAt, durationMs: 0, samples: 0,
      agentTurns: { claude: 0, codex: 0, cursor: 0 }, fileChecks: 0, historyChecks: 0 };
    await step("workload", GATE0_WORK_MS + 180_000, async signal => {
      const part = <T>(phase: Parameters<Evidence["step"]>[0], ms: number, work: (signal: AbortSignal) => Promise<T>) =>
        step(phase, ms, work, AbortSignal.any([signal, phaseBound(ms)]));
      for (let index = 0; index <= GATE0_WORK_MS / GATE0_TICK_MS; index++) {
        const wait = workStart + index * GATE0_TICK_MS - clock();
        if (wait > 0) await beforeDeadline(pause(wait, signal), signal);
        assertContinuous(runtime);
        const agent = HOURLY_AGENTS[index % HOURLY_AGENTS.length]!, file = `${directory}/${agent}-${index}.txt`;
        const marker = `ZEROS_DEV_${handle.run.runId}_${index}`;
        const prompt = await part(`agent_${agent}`, 90_000, bound => runtime.prompt(handle, { id: randomUUID(), agent,
          model: RELEASE_CANARY_SMOKE_MODELS[agent], permissionMode: "auto",
          text: `Create the file ${file} containing exactly ${marker} and a newline, using your normal file tools. Do not change other files or use the network. Then reply exactly ZEROS_DEV_OK.` }, bound));
        work.agentTurns[agent]++;
        await part("file_edit", 60_000, async bound => {
          const result = await runtime.terminal(handle, { script: `set -eu; test -f '${file}'; test "$(cat '${file}')" = '${marker}'` }, bound);
          if (result.exitCode !== 0 || result.truncated) throw new ZerosDevError("workload_incomplete");
        });
        work.fileChecks++;
        const sha256 = await part("chat_tail", 30_000, async bound => historyDigest(await runtime.tail(prompt.id, bound)));
        const prior = hourly.histories.find(row => row.agent === agent);
        if (prior) { prior.promptId = prompt.id; prior.sha256 = sha256; } else hourly.histories.push({ agent, promptId: prompt.id, sha256 });
        work.historyChecks++; work.samples++; work.durationMs = Math.max(0, clock() - workStart); work.completedAt = new Date(now()).toISOString();
        evidence.emit({ phase: "workload_tick", outcome: "ok", durationMs: work.durationMs, count: work.samples });
        assertContinuous(runtime); await handle.save();
      }
      if (work.durationMs < GATE0_WORK_MS) throw new ZerosDevError("workload_incomplete");
    });
    hourly.activeWindows.push({ readyObservedAt: work.startedAt, workCompletedAt: work.completedAt, durationMs: work.durationMs }); await handle.save();
    for (let index = 1; index <= 3; index++) {
      await close(runtime);
      const stopStart = clock();
      await step("workspace_stop", 30_000, signal => api.lifecycle(handle, "stop", signal));
      await step("workspace_stop_wait", 180_000, signal => api.waitWorkspace(handle, "stopped", signal));
      const stopMs = clock() - stopStart, stoppedAt = new Date(now()).toISOString(), wakeStart = clock();
      await step("workspace_resume", 30_000, signal => api.lifecycle(handle, "wake", signal));
      const setup = await ready("workspace_resume_wait");
      const resumeMs = clock() - wakeStart, readyAt = new Date(now()).toISOString();
      runtime = await connect();
      await terminal(runtime, `set -eu; test -d '${directory}'; test "$(find '${directory}' -maxdepth 1 -type f -name '*.txt' | wc -l)" -eq 13`);
      await histories(runtime); assertContinuous(runtime);
      gate.cycles.push({ index, stopMs, resumeMs, usableMs: clock() - wakeStart, stoppedAt, readyAt, setup }); await handle.save();
    }
    const authAt = clock(), authRemainingMs = await step("detached_auth", 30_000, () => options.prepareDetachedAuth(35 * 60_000));
    const probe = options.probe(runtime, handle);
    const task = await step("detached_start", 90_000, async signal => {
      const value = await probe.begin(signal);
      if (authRemainingMs - (clock() - authAt) <= GATE0_DETACHED_MS + 180_000) throw new ZerosDevError("detached_auth_window");
      return value;
    });
    const remaining = authRemainingMs - (clock() - authAt);
    const detachedAt = clock(), detachedStartedAt = new Date(now()).toISOString(), detachedRuntime = runtime;
    // No CP read, accessToken call, broker retirement, native cancel or hidden
    // client remains active during this interval. The VM owns accepted work.
    await step("detached_disconnect", 3000, async signal => {
      runtime.detachTransport();
      await beforeDeadline(task.completion.catch(error => {
        if (!(error instanceof ZerosDevError) || error.code !== "command_uncertain") throw error;
      }), signal);
      recordTransport(runtime); await handle.save();
    });
    await step("detached_wait", GATE0_DETACHED_MS + 10_000, async signal => {
      await pause(GATE0_DETACHED_MS, signal);
      if (clock() - detachedAt < GATE0_DETACHED_MS || clock() - detachedAt >= remaining) throw new ZerosDevError("detached_proof_incomplete");
    });
    const durationMs = clock() - detachedAt, completedAt = new Date(now()).toISOString();
    runtime = await connect("detached_reconnect");
    const proof = await step("detached_history", 180_000, signal => options.probe(runtime, handle).finish(task, signal));
    // The proof's VM duration and the client's disconnected duration are
    // independent clocks. Do not overwrite one with the other's measurement.
    const { durationMs: taskDurationMs, ...details } = proof;
    gate.detached = { startedAt: detachedStartedAt, completedAt, durationMs, authRemainingMs: remaining,
      ...details, taskDurationMs };
    await close(detachedRuntime); await close(runtime);
    await step("rehearsal_proof", 1000, async () => {
      if (!Gate0Schema.safeParse({ ...gate, complete: true }).success) throw new ZerosDevError("detached_proof_incomplete");
    });
  } catch (error) { failed = error; }
  finally {
    for (const runtime of owned) { try { await close(runtime); } catch (error) { failed ??= error; } }
    const cleanupMs = Math.min(options.cleanupMs ?? HOURLY_CLEANUP_MS, HOURLY_CLEANUP_MS), cleanup = AbortSignal.timeout(cleanupMs);
    try { await step("cleanup", cleanupMs, async signal => {
      await api.cleanup(handle, true, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, cleanupMs - 30_000))]));
      if (handle.run.create && !handle.run.deletionConfirmed) throw new ZerosDevError("cleanup_pending");
    }, cleanup); } catch (error) { failed ??= error; }
    try { await step("credentials_cleanup", cleanupMs, signal => credentials.cleanup(handle, signal), cleanup); }
    catch (error) { failed ??= error; }
  }
  if (failed) throw failed;
  gate.complete = true; hourly.complete = true; await handle.save();
}

export const productGate0Probe = (api: ProductApi) => (runtime: Runtime, handle: RunHandle) => new Gate0Runtime(runtime as ZerosDevRuntime, api, handle);

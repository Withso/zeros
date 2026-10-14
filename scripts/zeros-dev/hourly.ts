import { createHash, randomUUID } from "node:crypto";
import { RELEASE_CANARY_SMOKE_MODELS } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import type { Run, RunHandle } from "./receipts";
import type { ProductApi } from "./product";
import type { ZerosDevRuntime } from "./runtime";
import { Evidence } from "./evidence";
import { ZerosDevError } from "./errors";
import { beforeDeadline } from "./transport";
import type { AdmissionObservation } from "./admission-observation";

export const HOURLY_WORK_MS = 350_000;
export const HOURLY_COMPUTER_MS = 300_000;
export const HOURLY_CLEANUP_MS = 140_000;
export const HOURLY_TOTAL_MS = 850_000;
export const HOURLY_PROMPT = "Reply exactly ZEROS_DEV_OK. Do not call any tools.";
export const HOURLY_AGENTS = ["claude", "codex", "cursor"] as const;
type Runtime = Pick<ZerosDevRuntime, "prompt" | "tail" | "terminal" | "dispose" | "admission" | "transport">;
type CredentialPort = { install(handle: RunHandle, signal: AbortSignal): Promise<void>; cleanup(handle: RunHandle, signal: AbortSignal): Promise<void> };
export type HourlyOptions = {
  handle: RunHandle;
  api: Pick<ProductApi, "assertFixtureEmpty" | "ensureRepository" | "computerState" | "readComputerRuntime" | "verifyComputerRuntime" | "buildComputer" | "waitComputer" | "createWorkspace" | "waitWorkspace" | "lifecycle" | "cleanup">;
  credentials: CredentialPort; connect(run: Run, signal: AbortSignal, onAdmissionEvent?: (event: AdmissionObservation) => void): Promise<Runtime>; evidence: Evidence;
  signal?: AbortSignal; budgetMs?: number; computerMs?: number; workMs?: number; cleanupMs?: number; now?: () => number; monotonic?: () => number;
};

export async function recoverHourlyRun(options: {
  handle: RunHandle; api: Pick<ProductApi, "cleanup">; credentials: Pick<CredentialPort, "cleanup">;
  evidence: Evidence; signal: AbortSignal; revokeMs?: number;
}): Promise<void> {
  const { handle, api, credentials, signal, evidence } = options;
  let failed: unknown;
  try {
    await evidence.step("prior_cleanup", async () => {
      if (signal.aborted) throw new ZerosDevError("deadline");
      await beforeDeadline(api.cleanup(handle, true, signal), signal);
      if (handle.run.create && !handle.run.deletionConfirmed) throw new ZerosDevError("cleanup_pending");
    });
  } catch (error) { failed = error; }
  // The preceding delete/read can exhaust its budget. Revocation has its own
  // short reserve and cannot replace that first failure or authorize create.
  const revoke = AbortSignal.timeout(Math.min(options.revokeMs ?? 30_000, 30_000));
  try { await evidence.step("credentials_cleanup", () => beforeDeadline(credentials.cleanup(handle, revoke), revoke)); }
  catch (error) { failed ??= error; }
  if (failed) throw failed;
}

/** Hash durable product messages, never include their content in evidence. An
 * echoed user prompt is not proof that the actual provider answered. */
export function historyDigest(rows: Awaited<ReturnType<Runtime["tail"]>>): string {
  const answer = rows.some(row => {
    try { const value = JSON.parse(row.payload); return row.kind === "text" && value.role === "assistant" && value.text?.trim() === "ZEROS_DEV_OK"; }
    catch { return false; }
  });
  if (!answer) throw new ZerosDevError("agent_failed");
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** The hourly and longer manual rehearsal choose once and share the same
 * one-build intent and persisted qualified-runtime proof. */
export async function prepareHourlyComputer(options: Pick<HourlyOptions, "handle" | "api" | "evidence">, preparation: AbortSignal) {
  const { handle, api, evidence } = options;
  const step = <T>(phase: Parameters<Evidence["step"]>[0], task: () => Promise<T>) => evidence.step(phase, () => {
    if (preparation.aborted) throw new ZerosDevError("deadline");
    return beforeDeadline(task(), preparation);
  });
  const selected = await step("computer_selection", async () => {
    const { active } = await api.computerState(preparation);
    if (!active || active.state !== "succeeded" || active.templateState !== "ready") throw new ZerosDevError("computer_required");
    const proof = await api.readComputerRuntime(active, preparation);
    if (!proof.selected) throw new ZerosDevError("runtime_selection_unavailable");
    if (!proof.runtimeId || !proof.baseImageId) throw new ZerosDevError("runtime_pin_unconfirmed");
    const target = { runtimeId: proof.selected.runtimeId, baseImageId: proof.selected.baseImageId };
    return { active, target, rebuild: proof.runtimeId !== target.runtimeId || proof.baseImageId !== target.baseImageId };
  });
  const { target } = selected;
  const active = selected.rebuild ? await step("computer_build", async () => {
    await api.buildComputer(handle, preparation);
    return api.waitComputer(handle.run, preparation, target);
  }) : selected.active;
  const assertPin = async (bound: AbortSignal) => {
    const state = await api.computerState(bound);
    if (state.active?.id !== active.id || state.active.version !== active.version || state.active.state !== "succeeded" || state.active.templateState !== "ready")
      throw new ZerosDevError("runtime_pin_unconfirmed");
    await api.verifyComputerRuntime(active, bound, target);
  };
  await step("computer_pin", () => assertPin(preparation));
  return { active, target, assertPin };
}

/** Actions calls this with a fresh signed run after reconciling its predecessor.
 * All access/commands are the same product API and desktop RuntimeClient used
 * by the interactive harness. It never edits VM state through provider APIs. */
export async function runHourly(options: HourlyOptions): Promise<void> {
  const { handle, api, credentials, connect, evidence } = options, hourly = handle.run.hourly;
  if (!hourly || hourly.startedAt || handle.run.create || handle.run.prompts.length || handle.run.lifecycle.length)
    throw new ZerosDevError("operation_conflict");
  const now = options.now ?? Date.now, clock = options.monotonic ?? (() => performance.now());
  const workMs = Math.min(options.workMs ?? HOURLY_WORK_MS, HOURLY_WORK_MS);
  const computerMs = Math.min(options.computerMs ?? HOURLY_COMPUTER_MS, HOURLY_COMPUTER_MS);
  const cleanupMs = Math.min(options.cleanupMs ?? HOURLY_CLEANUP_MS, HOURLY_CLEANUP_MS);
  const budget = AbortSignal.timeout(Math.min(options.budgetMs ?? computerMs + workMs, computerMs + workMs));
  const overall = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  const preparation = AbortSignal.any([overall, AbortSignal.timeout(computerMs)]);
  hourly.startedAt = new Date(now()).toISOString(); await handle.save();
  const boundedStep = <T>(phase: Parameters<Evidence["step"]>[0], task: () => Promise<T>, bound: AbortSignal,
    admission?: (value: T) => AdmissionObservation | undefined) =>
    evidence.step(phase, () => {
      if (bound.aborted) throw new ZerosDevError("deadline");
      return beforeDeadline(task(), bound);
    }, admission);
  await boundedStep("prior_cleanup", () => api.assertFixtureEmpty(preparation), preparation);
  await boundedStep("repository", () => api.ensureRepository(preparation), preparation);
  const { assertPin } = await prepareHourlyComputer(options, preparation);
  // A refresh never consumes the lifecycle's phase allowance or cleanup's
  // reserve, but all phases remain inside the workflow's original budget.
  const signal = AbortSignal.any([overall, AbortSignal.timeout(workMs)]);
  const step = <T>(phase: Parameters<Evidence["step"]>[0], task: () => Promise<T>, bound = signal) =>
    boundedStep(phase, task, bound);
  const connected = async (task: (runtime: Runtime) => Promise<void>) => {
    const started = clock(), readyObservedAt = new Date(now()).toISOString();
    const runtime = await boundedStep("runtime_connect", () => connect(handle.run, signal, admission => evidence.emit({
      phase: "runtime_admission", outcome: "pending", code: "runtime_unavailable", count: admission.retryCount,
      durationMs: Math.max(0, clock() - started), admission,
    })), signal, value => value.admission);
    let failed: unknown;
    try {
      await task(runtime);
      hourly.activeWindows.push({ readyObservedAt, workCompletedAt: new Date(now()).toISOString(), durationMs: Math.max(0, clock() - started) });
      await handle.save();
    } catch (error) { failed = error; }
    try { await step("runtime_disconnect", () => runtime.dispose(), AbortSignal.timeout(3000)); }
    catch (error) { failed ??= error; }
    if (runtime.transport) evidence.emit({ phase: "runtime_transport", outcome: "ok", durationMs: 0, transport: runtime.transport() });
    if (failed) throw failed;
  };
  let failed: unknown;
  try {
    await step("credentials_install", () => credentials.install(handle, signal));
    await step("computer_pin", () => assertPin(signal));
    await step("workspace_create", () => api.createWorkspace(handle, signal));
    await step("workspace_create_wait", () => api.waitWorkspace(handle, "running", signal));
    const marker = `.zeros-dev-${handle.run.runId}`;
    await connected(async runtime => {
      await step("terminal_run", async () => {
        const result = await runtime.terminal(handle, {
          script: `set -e; git rev-parse --is-inside-work-tree; printf '%s' '${handle.run.runId}' > '${marker}'`,
        }, signal);
        if (result.exitCode !== 0 || result.truncated) throw new ZerosDevError("terminal_failed");
      });
      for (const agent of HOURLY_AGENTS) {
        const prompt = await step(`agent_${agent}`, () => runtime.prompt(handle, {
          id: randomUUID(), agent, model: RELEASE_CANARY_SMOKE_MODELS[agent], text: HOURLY_PROMPT,
        }, AbortSignal.any([signal, AbortSignal.timeout(60_000)])));
        const sha256 = await step("chat_tail", async () => historyDigest(await runtime.tail(prompt.id, signal)));
        hourly.histories.push({ agent, promptId: prompt.id, sha256 }); await handle.save();
      }
    });
    await step("workspace_stop", () => api.lifecycle(handle, "stop", signal));
    await step("workspace_stop_wait", () => api.waitWorkspace(handle, "stopped", signal));
    await step("workspace_resume", () => api.lifecycle(handle, "wake", signal));
    await step("workspace_resume_wait", () => api.waitWorkspace(handle, "running", signal));
    await connected(async runtime => {
      await step("terminal_run", async () => {
        const result = await runtime.terminal(handle, {
          script: `set -e; git rev-parse --is-inside-work-tree; test "$(cat '${marker}')" = '${handle.run.runId}'`,
        }, signal);
        if (result.exitCode !== 0 || result.truncated) throw new ZerosDevError("terminal_failed");
      });
      for (const previous of hourly.histories) await step("chat_continuity", async () => {
        const rows = await runtime.tail(previous.promptId, signal);
        try { if (historyDigest(rows) === previous.sha256) return; } catch { /* closed continuity failure */ }
        throw new ZerosDevError("history_changed");
      });
    });
    await step("computer_pin", () => assertPin(signal));
  } catch (error) { failed = error; }
  finally {
    // A work deadline or SIGTERM does not cancel its own cleanup. Split the
    // reserve so a stuck provider deletion cannot consume revocation's budget.
    const cleanup = AbortSignal.timeout(cleanupMs);
    try {
      await step("cleanup", async () => {
        await api.cleanup(handle, true, AbortSignal.any([cleanup, AbortSignal.timeout(Math.max(1, cleanupMs - 30_000))]));
        if (handle.run.create && !handle.run.deletionConfirmed) throw new ZerosDevError("cleanup_pending");
      }, cleanup);
    } catch (error) { failed ??= error; }
    try { await step("credentials_cleanup", () => credentials.cleanup(handle, cleanup), cleanup); }
    catch (error) { failed ??= error; }
  }
  if (failed) throw failed;
  hourly.complete = true; await handle.save();
}

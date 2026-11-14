import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { RuntimeAdoption } from "./runtime-adoption.js";
import type { RuntimeHandoffStore } from "./runtime-handoff-store.js";
import type { CloudV2WorkerSession } from "./store.js";

function fixture() {
  let workspace: CloudV2WorkerSession | null = {
    id: randomUUID(), state: "running", executionMode: "active", boatSandboxId: "bx_stagingfixture",
    accessEpoch: "2", loginRevision: "3", organizationId: randomUUID(), creatorUserId: randomUUID(),
  } as CloudV2WorkerSession;
  let target = "b".repeat(64);
  const token = "zw2w_" + "a".repeat(43), boot = randomUUID();
  const workerSession = vi.fn(async () => workspace);
  const stageRoute = vi.fn(async () => workspace ? ({ workspace, accessEpoch: workspace.accessEpoch,
    bootId: boot, workerTokenHash: "d".repeat(64), url: null, portToken: null }) : null);
  const handoffs = { runtime: vi.fn(async () => "a".repeat(64)), prepare: vi.fn() };
  const execLong = vi.fn(async (_id: string, _command: string, _timeout: number, _input?: string, _signal?: AbortSignal) =>
    ({ exitCode: 0, timedOut: false, stdout: "" }));
  const runtimeForWorkspace = vi.fn(async () => ({ sha256: target, url: async () => "https://fixture.example.test/runtime" }));
  const logger = { warn: vi.fn() };
  const adoption = new RuntimeAdoption({
    store: { workerSession, get: vi.fn(), accessEpoch: vi.fn(), loginRevision: vi.fn() },
    handoffs: handoffs as unknown as RuntimeHandoffStore, compute: { execLong }, runtimeForWorkspace, logger, stageRoute,
  });
  return { adoption, token, boot, execLong, handoffs, workerSession, logger, stageRoute, workspace: workspace!,
    request: () => adoption.request(token, boot, { op: "stage" }),
    stop: () => { workspace = null; },
    cut: () => { workspace = { ...workspace!, accessEpoch: "4" }; },
    repin: () => { target = "c".repeat(64); },
  };
}

it("stages the release-owned target during shared execution without a quiet handoff", async () => {
  const f = fixture();
  expect(await f.adoption.request(f.token, f.boot, { op: "status" })).toEqual({ status: "target", sha256: "b".repeat(64) });
  expect(await f.request()).toEqual({ status: "staged", sha256: "b".repeat(64) });
  expect(f.execLong).toHaveBeenCalledOnce();
  expect(f.execLong.mock.calls[0]![0]).toBe("bx_stagingfixture");
  expect(f.execLong.mock.calls[0]![1]).not.toMatch(/systemctl (?:start|restart|try-restart|stop) |worker\.next|runtime-handoffs/);
  expect(f.handoffs.prepare).not.toHaveBeenCalled();
  f.adoption.close();
});

it("shares concurrent preparation for the same workspace, boot and target", async () => {
  const f = fixture(), held = Promise.withResolvers<{ exitCode: number; timedOut: boolean; stdout: string }>();
  f.execLong.mockImplementation(() => held.promise);
  const first = f.request(), second = f.request();
  try {
    await expect.poll(() => f.execLong.mock.calls.length).toBe(1);
    held.resolve({ exitCode: 0, timedOut: false, stdout: "" });
    expect(await first).toEqual({ status: "staged", sha256: "b".repeat(64) });
    expect(await second).toEqual({ status: "staged", sha256: "b".repeat(64) });
    expect(f.execLong).toHaveBeenCalledOnce();
  } finally { held.resolve({ exitCode: 0, timedOut: false, stdout: "" }); f.adoption.close(); }
});

it.each(["stop", "cut", "repin"] as const)("does not acknowledge staging after %s during provider I/O", async change => {
  const f = fixture(), held = Promise.withResolvers<{ exitCode: number; timedOut: boolean; stdout: string }>();
  f.execLong.mockImplementation(() => held.promise);
  const task = f.request();
  try {
    await expect.poll(() => f.execLong.mock.calls.length).toBe(1);
    f[change](); held.resolve({ exitCode: 0, timedOut: false, stdout: "" });
    expect(await task).toEqual({ status: "unavailable" });
  } finally { held.resolve({ exitCode: 0, timedOut: false, stdout: "" }); f.adoption.close(); }
});

it("aborts bounded staging on disposal and contains provider error text", async () => {
  const f = fixture(), entered = Promise.withResolvers<AbortSignal>();
  f.execLong.mockImplementation(async (_id, _command, seconds, _input, signal) => {
    expect(seconds).toBeLessThanOrEqual(300);
    entered.resolve(signal!);
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("private-provider-detail")), { once: true }));
    return { exitCode: 0, timedOut: false, stdout: "" };
  });
  const task = f.request();
  await expect.poll(() => f.execLong.mock.calls.length).toBe(1);
  const signal = await entered.promise;
  f.adoption.close();
  expect(signal.aborted).toBe(true);
  expect(await task).toEqual({ status: "unavailable" });
  expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain("private-provider-detail");
});

it("makes a bounded best-effort idle-stop attempt without a worker credential or a handoff", async () => {
  const f = fixture();
  await f.adoption.beforeIdleStop(f.workspace);
  expect(f.execLong).toHaveBeenCalledOnce();
  expect(f.execLong.mock.calls[0]![2]).toBe(30);
  expect(f.workerSession).not.toHaveBeenCalled();
  expect(f.handoffs.prepare).not.toHaveBeenCalled();
  expect(f.stageRoute).toHaveBeenCalledTimes(3);
  f.adoption.close();
});

it("cancels a shared staging flight on Stop without returning a staged acknowledgement", async () => {
  const f = fixture(), held = Promise.withResolvers<{ exitCode: number; timedOut: boolean; stdout: string }>();
  f.execLong.mockImplementation(() => held.promise);
  const task = f.request();
  try {
    await expect.poll(() => f.execLong.mock.calls.length).toBe(1);
    f.adoption.cancelStaging(f.workspace.id);
    expect(f.execLong.mock.calls[0]![4]!.aborted).toBe(true);
    held.resolve({ exitCode: 0, timedOut: false, stdout: "" });
    expect(await task).toEqual({ status: "unavailable" });
  } finally { held.resolve({ exitCode: 0, timedOut: false, stdout: "" }); f.adoption.close(); }
});

it("never stages a lifecycle snapshot whose current boot has already stopped", async () => {
  const f = fixture(); f.stop();
  await f.adoption.beforeIdleStop(f.workspace);
  expect(f.execLong).not.toHaveBeenCalled();
  f.adoption.close();
});

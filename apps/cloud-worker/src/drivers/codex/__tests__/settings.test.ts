import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcProcessOptions } from "../../shared/json-rpc-process";

const native = vi.hoisted(() => ({
  options: undefined as RpcProcessOptions | undefined,
  request: vi.fn(), dispose: vi.fn(async () => {}),
}));
vi.mock("../../shared/json-rpc-process", () => ({
  JsonRpcProcess: class {
    constructor(options: RpcProcessOptions) { native.options = options; }
    request = native.request;
    notify() {}
    dispose = native.dispose;
  },
  RpcError: class extends Error {},
}));

import { CodexDriver } from "../driver";

const drivers: CodexDriver[] = [];
const notify = (method: string, params: unknown) => native.options!.onNotification(method, params);
const settings = () => native.request.mock.calls.filter(([method]) => method === "turn/settings/update").map(([, params]) => params);
const turnParams = () => native.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1];
beforeEach(() => {
  native.request.mockReset().mockImplementation(async (method: string) => method.startsWith("thread/")
    ? { thread: { id: "thread-settings" }, model: "gpt-6.1-sol" } : {});
  native.dispose.mockClear();
});
afterEach(async () => { await Promise.all(drivers.splice(0).map(driver => driver.dispose())); vi.restoreAllMocks(); });

async function setup() {
  const driver = new CodexDriver({ command: "offline-codex", args: [], environment: {} });
  drivers.push(driver);
  await driver.open({ sessionId: "execution-settings", cwd: process.cwd(), model: "gpt-6.1-sol", effort: "low",
    proxy: { baseUrl: "http://127.0.0.1:1/v1", token: "offline-placeholder" } });
  async function start(id = "turn-1", acknowledge = true) {
    let accept!: (status?: string) => void;
    native.request.mockImplementationOnce(() => new Promise(resolve => { accept = (status = "inProgress") => resolve({ turn: { id, status } }); }));
    const result = driver.prompt([{ type: "text", text: "Work" }]);
    void result.catch(() => {}); // Failed assertions still dispose an unfinished fixture turn.
    const terminal = (turnId = id) => notify("turn/completed", { threadId: "thread-settings", turn: { id: turnId, status: "completed" } });
    if (acknowledge) { accept(); await Promise.resolve(); }
    const finish = async () => { terminal(); return result; };
    return { result, accept, terminal, finish };
  }
  return { driver, start };
}

describe("cloud Codex active-turn settings", () => {
  it("updates the exact active turn, resets Fast with null, and retains both knobs for later turns", async () => {
    const { driver, start } = await setup(), turn = await start();
    await driver.updateConfig({ effort: "ultracode", fast: true });
    expect(settings()).toEqual([{ threadId: "thread-settings", turnId: "turn-1", effort: "ultra", serviceTier: "fast" }]);
    await driver.updateConfig({ effort: "ultracode", fast: true });
    expect(settings()).toHaveLength(1);
    await driver.updateConfig({ effort: "ultracode", fast: false });
    expect(settings()[1]).toEqual({ threadId: "thread-settings", turnId: "turn-1", serviceTier: null });
    await turn.finish();
    const next = await start("turn-2");
    expect(turnParams()).toMatchObject({ effort: "ultra", serviceTierForTurn: "default" });
    await next.finish();
  });

  it("coalesces configuration changes before acknowledgement onto the newly identified active turn", async () => {
    const { driver, start } = await setup(), turn = await start("turn-pending", false);
    await driver.updateConfig({ effort: "high", fast: true });
    await driver.updateConfig({ effort: "max", fast: false });
    expect(settings()).toEqual([]);
    turn.accept();
    await vi.waitFor(() => expect(settings()).toEqual([{ threadId: "thread-settings", turnId: "turn-pending", effort: "max" }]));
    await turn.finish();
  });

  it("does not lose a change immediately after an unchanged snapshot", async () => {
    const { driver, start } = await setup(), turn = await start();
    const unchanged = driver.updateConfig({ effort: "low", fast: false });
    const changed = driver.updateConfig({ effort: "high", fast: true });
    await Promise.all([unchanged, changed]);
    expect(settings()).toEqual([{ threadId: "thread-settings", turnId: "turn-1", effort: "high", serviceTier: "fast" }]);
    await turn.finish();
  });

  it("retains a config change when acknowledgement is already queued", async () => {
    const { driver, start } = await setup(), turn = await start("turn-pending", false);
    turn.accept();
    await driver.updateConfig({ effort: "high", fast: true });
    expect(settings()).toEqual([{ threadId: "thread-settings", turnId: "turn-pending", effort: "high", serviceTier: "fast" }]);
    await turn.finish();
  });

  it("serializes in-flight updates and publishes only the latest queued selection", async () => {
    const { driver, start } = await setup(), turn = await start();
    let release!: () => void;
    native.request.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = driver.updateConfig({ effort: "high", fast: false });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const middle = driver.updateConfig({ effort: "max", fast: true });
    const latest = driver.updateConfig({ effort: "ultracode", fast: false });
    expect(settings()).toHaveLength(1);
    release(); await Promise.all([first, middle, latest]);
    expect(settings()).toEqual([
      { threadId: "thread-settings", turnId: "turn-1", effort: "high" },
      { threadId: "thread-settings", turnId: "turn-1", effort: "ultra" },
    ]);
    await turn.finish();
  });

  it.each(["notification", "ack"])("does not update a turn completed before its %s is consumed", async terminal => {
    const { driver, start } = await setup(), turn = await start("turn-done", false);
    await driver.updateConfig({ effort: "high", fast: true });
    if (terminal === "notification") turn.terminal();
    turn.accept(terminal === "ack" ? "completed" : "inProgress");
    await turn.result;
    await driver.updateConfig({ effort: "max", fast: false });
    expect(settings()).toEqual([]);
  });

  it("ignores stale and foreign completion while retaining exact-turn liveness", async () => {
    const { driver, start } = await setup(), turn = await start();
    turn.terminal("retired-turn");
    notify("turn/completed", { threadId: "other-thread", turn: { id: "turn-1", status: "completed" } });
    await driver.updateConfig({ effort: "high", fast: false });
    expect(settings()).toHaveLength(1);
    await turn.finish();
    await driver.updateConfig({ effort: "max", fast: true });
    expect(settings()).toHaveLength(1);
  });

  it.each(["model picker", "config snapshot"])("keeps model changes from the %s and their knobs for the next turn", async courier => {
    const { driver, start } = await setup(), turn = await start();
    if (courier === "model picker") await driver.setModel("gpt-6.1-terra");
    await driver.updateConfig({ ...(courier === "config snapshot" ? { model: "gpt-6.1-terra" } : {}), effort: "max", fast: true });
    expect(settings()).toEqual([]);
    await turn.finish();
    const next = await start("turn-2");
    expect(turnParams()).toMatchObject({ model: "gpt-6.1-terra", effort: "max", serviceTierForTurn: "fast" });
    await next.finish();
  });

  it("logs a native refusal without failing the turn, and applies the retained choice on the next turn", async () => {
    const { driver, start } = await setup(), turn = await start();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.request.mockRejectedValueOnce(new Error("Model does not support reasoning effort updates; private-fixture-detail"));
    await expect(driver.updateConfig({ effort: "high", fast: true })).resolves.toBeUndefined();
    expect(settings()).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-fixture-detail");
    expect(native.dispose).not.toHaveBeenCalled();
    await expect(turn.finish()).resolves.toMatchObject({ stopReason: "end_turn" });
    const next = await start("turn-2");
    expect(turnParams()).toMatchObject({ effort: "high", serviceTierForTurn: "fast" });
    await next.finish();
  });

  it("does not apply queued settings to a successor after an old update completes", async () => {
    const { driver, start } = await setup(), turn = await start();
    let release!: () => void;
    native.request.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = driver.updateConfig({ effort: "high", fast: false });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const queued = driver.updateConfig({ effort: "max", fast: true });
    expect(settings()).toHaveLength(1);
    await turn.finish();
    const next = await start("turn-2");
    release(); await Promise.all([first, queued]);
    expect(settings()).toHaveLength(1);
    expect(turnParams()).toMatchObject({ effort: "max", serviceTierForTurn: "fast" });
    await next.finish();
  });

  it("retains Stop before acknowledgement and never updates that turn", async () => {
    const { driver, start } = await setup(), turn = await start("turn-stopped", false);
    const stopped = driver.interrupt();
    void stopped.catch(() => {});
    await driver.updateConfig({ effort: "high", fast: true });
    turn.accept();
    await vi.waitFor(() => expect(native.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "thread-settings", turnId: "turn-stopped" }));
    await turn.finish(); await stopped;
    expect(settings()).toEqual([]);
  });
});

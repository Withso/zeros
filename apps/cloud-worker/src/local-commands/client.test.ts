import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalCommandUnknownError, requestLocalCommand, type LocalCommandCall } from "./client";

const requestId = "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const iso = "2026-11-10T12:00:00.000Z";
const receipt = (state: "pending" | "claimed" | "terminal", result: unknown = null) =>
  ({ requestId, state, approvalDeadline: iso, runDeadline: null, mac: "Studio", result, outputAvailable: state === "terminal" });
class Failure extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }
afterEach(() => { vi.useRealTimers(); });

function server(script: Array<(path: string, body: unknown) => unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown; timeoutMs: number }> = [];
  const call: LocalCommandCall = async (method, path, body, timeoutMs, signal) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }), timeoutMs });
    signal?.throwIfAborted();
    const next = script.shift();
    if (!next) throw new Error("No scripted reply");
    const value = next(path, body);
    if (value instanceof Error) throw value;
    return value as Record<string, unknown>;
  };
  return { calls, call };
}
const request = { chatId: "chat", executionId: "exec", input: { command: "ls" } };
const sleep = async () => {};

describe("worker local command client", () => {
  it("creates with a fresh request id, long-polls to the terminal receipt, and acknowledges only when asked", async () => {
    const s = server([() => receipt("pending"), () => receipt("claimed"), () => receipt("terminal", { outcome: "completed", code: 0, stdout: "ok", mac: "Studio" }), () => ({})]);
    const done = await requestLocalCommand(s.call, request, new AbortController().signal, { requestId, sleep });
    expect(done.result).toEqual({ outcome: "completed", code: 0, stdout: "ok", mac: "Studio" });
    expect(s.calls.map(c => `${c.method} ${c.path}`)).toEqual(["POST local-commands", `GET local-commands/${requestId}?waitMs=25000`, `GET local-commands/${requestId}?waitMs=25000`]);
    expect(s.calls[0]!.body).toEqual({ requestId, ...request });
    await done.acknowledge();
    expect(s.calls.at(-1)).toMatchObject({ method: "POST", path: `local-commands/${requestId}/ack`, body: {} });
  });

  it("retries a lost create and a failed poll with the same request id, and never invents an outcome", async () => {
    const s = server([() => new Failure(503), () => new Error("socket hang up"), () => receipt("pending"), () => new Failure(502),
      () => receipt("terminal", { outcome: "mac_not_connected", connectedMacs: [] })]);
    const done = await requestLocalCommand(s.call, request, new AbortController().signal, { requestId, sleep });
    expect(done.result.outcome).toBe("mac_not_connected");
    expect(s.calls.filter(c => c.path === "local-commands").map(c => (c.body as { requestId: string }).requestId)).toEqual([requestId, requestId, requestId]);
  });

  it("treats a create the server refuses as unknown, not as a command outcome", async () => {
    const s = server([() => new Failure(400)]);
    await expect(requestLocalCommand(s.call, request, new AbortController().signal, { requestId, sleep })).rejects.toBeInstanceOf(LocalCommandUnknownError);
    const limited = server([() => new Failure(429), () => receipt("terminal", { outcome: "disabled" })]);
    expect((await requestLocalCommand(limited.call, request, new AbortController().signal, { requestId, sleep })).result.outcome).toBe("disabled");
  });

  it("cancels on Stop with the same id and reports the server's terminal receipt", async () => {
    const controller = new AbortController();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const call: LocalCommandCall = async (method, path, _body, _timeout, signal) => {
      calls.push(`${method} ${path}`);
      if (path === "local-commands") return receipt("pending");
      if (path.endsWith("/cancel")) return receipt("terminal", { outcome: "cancelled" });
      if (path.includes("?waitMs=25000")) { release(); await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })); }
      return receipt("terminal", { outcome: "cancelled" });
    };
    const running = requestLocalCommand(call, request, controller.signal, { requestId, sleep });
    await held; controller.abort();
    expect((await running).result).toEqual({ outcome: "cancelled" });
    expect(calls).toContain(`POST local-commands/${requestId}/cancel`);
  });

  it("gives up as unknown after its ceiling, cancelling first", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const call: LocalCommandCall = async (method, path, _body, _timeout, signal) => {
      calls.push(`${method} ${path}`);
      if (path === "local-commands") return receipt("pending");
      if (path.endsWith("/cancel")) return receipt("claimed");
      await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 25_000); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
      return receipt("pending");
    };
    const running = requestLocalCommand(call, { ...request, input: { command: "ls", timeoutMs: 1_000 } }, new AbortController().signal, { requestId, sleep }).catch(error => error);
    await vi.advanceTimersByTimeAsync(120_000 + 1_000 + 30_000 + 30_000);
    expect(await running).toBeInstanceOf(LocalCommandUnknownError);
    expect(calls).toContain(`POST local-commands/${requestId}/cancel`);
  });
});

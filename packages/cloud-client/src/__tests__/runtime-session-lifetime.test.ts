import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectRuntime, type RuntimeSessionOptions, type RuntimeSocketHandlers } from "../runtime-session";
import type { ConnectResponse } from "../generated/rest";
import { BOOT_SCOPE, CLIENT_SESSION, RUNTIME_BINDING, WORKSPACE } from "./fixtures";

const now = 1_800_000_000_000;
function capability(aud: string) {
  const claims = { aud, wsp: WORKSPACE, jti: "a".repeat(22), iat: now / 1000, exp: now / 1000 + 300 };
  return { token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${"s".repeat(86)}`, expiresAt: new Date(now + 300_000).toISOString() };
}
const connect: ConnectResponse = { workspaceId: WORKSPACE, generation: 7, engineInstanceId: BOOT_SCOPE.engineInstanceId,
  runtimeBinding: RUNTIME_BINDING, capabilities: { engine: capability("zeros:engine"), realtime: capability("zeros:realtime") },
  routes: [{ kind: "direct", url: "wss://direct.example.test/ws", priority: 0 }, { kind: "relay", url: "wss://relay.example.test/v1/relay", priority: 1 }],
  renewAt: new Date(now + 180_000).toISOString(), relayHedgeMs: 400 };
const authOk = JSON.stringify({ t: "auth.ok", d: { sessionId: CLIENT_SESSION, scopes: ["ws:read"], expiresAtMs: now + 300_000 } });
function fixture(signal?: AbortSignal, signProof = vi.fn(async (_message: string) => "s".repeat(86))) {
  const sockets: Array<{ handlers: RuntimeSocketHandlers; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const options: RuntimeSessionOptions & { signal?: AbortSignal } = { clientSessionId: CLIENT_SESSION, signal, signProof, now: () => now,
    createSocket: (_url, _protocols, handlers) => { const socket = { handlers, send: vi.fn(), close: vi.fn() }; sockets.push(socket); return socket; } };
  const result = connectRuntime(connect, options); void result.catch(() => {});
  return { result, sockets, signProof };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe("runtime connection lifetime", () => {
  it("refuses an already-cancelled race before creating any sockets", async () => {
    const stop = new AbortController(); stop.abort();
    const run = fixture(stop.signal);
    expect(run.sockets).toHaveLength(0);
    await expect(run.result).rejects.toMatchObject({ code: "runtime_cancelled" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts both routes and prevents a late proof from sending or scheduling another attempt", async () => {
    let finish!: (signature: string) => void;
    const sign = vi.fn((_message: string) => new Promise<string>(resolve => { finish = resolve; }));
    const stop = new AbortController(), run = fixture(stop.signal, sign);
    run.sockets[0]!.handlers.open("zeros-cap.v1");
    await vi.advanceTimersByTimeAsync(400);
    expect(run.sockets).toHaveLength(2);
    stop.abort();
    expect(run.sockets.every(socket => socket.close.mock.calls.length === 1)).toBe(true);
    await expect(run.result).rejects.toMatchObject({ code: "runtime_cancelled" });
    finish("s".repeat(86)); await vi.advanceTimersByTimeAsync(30_000);
    expect(run.sockets.every(socket => socket.send.mock.calls.length === 0)).toBe(true);
    expect(run.sockets).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a socket returned by a factory that synchronously cancels its race", async () => {
    const stop = new AbortController(), close = vi.fn();
    const options: RuntimeSessionOptions & { signal: AbortSignal } = { clientSessionId: CLIENT_SESSION, signal: stop.signal,
      signProof: async () => "s".repeat(86), createSocket: () => { stop.abort(); return { close, send: vi.fn() }; } };
    const result = connectRuntime(connect, options); void result.catch(() => {});
    expect(close).toHaveBeenCalledOnce();
    await expect(result).rejects.toMatchObject({ code: "runtime_cancelled" }); expect(vi.getTimerCount()).toBe(0);
  });

  it("settles renewal and drops buffered or late engine messages when closed without a socket callback", async () => {
    const run = fixture(); run.sockets[0]!.handlers.open("zeros-cap.v1");
    await vi.advanceTimersByTimeAsync(0); run.sockets[0]!.handlers.message(authOk);
    const result = await run.result; if (result.kind !== "connected") throw new Error("expected a connection");
    const { connection } = result;
    run.sockets[0]!.handlers.message('{"type":"buffered"}');
    const renewal = connection.renew(connect.capabilities); void renewal.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const ended = vi.fn(); connection.onClose(ended); connection.close();
    expect(ended).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    await expect(renewal).rejects.toThrow(/closed/);
    const message = vi.fn(); connection.onMessage(message);
    run.sockets[0]!.handlers.message('{"type":"late"}'); expect(message).not.toHaveBeenCalled();
  });

  it("stops draining queued engine frames when the first callback retires the connection", async () => {
    const run = fixture(); run.sockets[0]!.handlers.open("zeros-cap.v1"); await vi.advanceTimersByTimeAsync(0);
    run.sockets[0]!.handlers.message(authOk);
    const result = await run.result; if (result.kind !== "connected") throw new Error("expected a connection");
    run.sockets[0]!.handlers.message("first"); run.sockets[0]!.handlers.message("second");
    const messages: string[] = [];
    result.connection.onMessage(text => { messages.push(text); result.connection.close(); });
    expect(messages).toEqual(["first"]);
  });
});

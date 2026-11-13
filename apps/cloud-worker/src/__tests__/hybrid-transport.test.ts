import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { HybridTransport } from "../hybrid-transport";
import { InboundBridge } from "../inbound-bridge";
import { config } from "./worker-fixtures";
import * as workerToken from "../worker-token";
import { PromptInbox } from "../prompt-inbox";
import type { Agents } from "../agents";
import type { SessionStore } from "../sessions/session-store";
import * as relayProtocol from "@zeros/protocol/cloud-v2-relay";
import * as notifyProtocol from "@zeros/protocol/notify-user";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });
async function fixture(options: { hello?: Promise<void>; onFrame?: (frame: any) => void; heartbeatPhase?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-transport-")), tokenFile = join(directory, "token");
  let expected = "synthetic-worker-token", revision = "0", failHistory = false, lostReply = false;
  await writeFile(tokenFile, expected, { mode: 0o600 });
  const requests: Array<{ path: string; body: any; authorized: boolean }> = [], incoming: any[] = [];
  const keys = generateKeyPairSync("ed25519");
  const publicKeys = [keys.publicKey.export({ type: "spki", format: "pem" }).toString()];
  const start = InboundBridge.prototype.start;
  let port = 0;
  vi.spyOn(InboundBridge.prototype, "start").mockImplementationOnce(async function (this: InboundBridge, receive) {
    const address = await start.call(this, receive); port = address.port; return address;
  });
  const fetcher: typeof fetch = vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname.split("/").at(-1)!;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path, body, authorized: new Headers(init?.headers).get("authorization") === `Bearer ${expected}` });
    if (path === "hello") await options.hello;
    if (path === "hello" || path === "config") return Response.json({ config: { ...config, loginRevision: revision } });
    if (path === "activity") return Response.json({ state: "running", loginRevision: revision });
    if (path === "pull") return Response.json({ prompts: [], stops: [] });
    if (path === "history") {
      if (lostReply) { lostReply = false; throw new Error("Lost committed response"); }
      return failHistory ? new Response(null, { status: 503 }) : Response.json({ sequence: body.sequence });
    }
    if (path === "github-token") return Response.json({ token: "synthetic-github-token", expiresAt: Date.now() + 60_000 });
    return new Response(null, { status: 404 });
  });
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64),
    // The first safety heartbeat is a full minute away: no test sees an unplanned activity.
    tokenFile, publicKeys, port: 0, fetch: fetcher, retryBaseMs: 10, retryMaxMs: 20, heartbeatPhase: options.heartbeatPhase ?? Date.now() });
  transport.start({ open: async () => {}, close: () => {}, frame: async frame => { incoming.push(frame); options.onFrame?.(frame); } });
  cleanups.push(async () => { await transport.dispose(); await rm(directory, { recursive: true, force: true }); });
  await expect.poll(() => options.hello ? requests.length > 0 : incoming.some(frame => frame.t === "config")).toBe(true);
  return { transport, requests, incoming, fetcher, port, keys, revise: (next: string) => { revision = next; },
    rotate: async () => { expected = "synthetic-rotated-worker-token"; await writeFile(tokenFile, expected, { mode: 0o600 }); },
    failHistory: (value: boolean) => { failHistory = value; }, loseReply: () => { lostReply = true; } };
}

async function connectRelay(f: Awaited<ReturnType<typeof fixture>>) {
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(JSON.stringify({ iss: "zeros-cp", aud: config.workspace.id, boot: f.transport.bootId,
    iat: now, exp: now + 60, jti: randomUUID() })).toString("base64url");
  const payload = `v1.${claims}`;
  const grant = `${payload}.${sign(null, Buffer.from(payload), f.keys.privateKey).toString("base64url")}`;
  const socket = new WebSocket(`ws://127.0.0.1:${f.port}/v2/worker/bridge`, "zeros.cloud.v2.worker", { headers: { "X-Zeros-Worker-Auth": grant } });
  cleanups.push(async () => { socket.terminate(); });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return socket;
}

const socketBoundary = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
  const closed = () => { socket.off("pong", pong); reject(new Error("Socket closed before boundary")); };
  const pong = () => { socket.off("close", closed); resolve(); };
  socket.once("pong", pong); socket.once("close", closed); socket.ping();
});

async function idleInbox() {
  let hint = () => {}, parked!: () => void;
  let waiting = new Promise<void>(resolve => { parked = resolve; });
  const f = await fixture({ onFrame: frame => { if (frame.t === "prompts") hint(); } });
  const socket = await connectRelay(f);
  socket.send(JSON.stringify({ t: "push", prompts: true })); await socketBoundary(socket);
  const store = { onChange: () => () => {}, outboxEntries: () => [] } as unknown as SessionStore;
  const agents = { setOutboxDispatch: () => {} } as unknown as Agents;
  const inbox = new PromptInbox(store, agents, async (operation, body, signal) => {
    if (operation === "pull" && (body as { waitMs: number }).waitMs) parked();
    return f.transport.promptRequest(operation, body, signal);
  });
  hint = () => inbox.hint();
  cleanups.push(() => inbox.dispose());
  inbox.start(); await waiting;
  return { ...f, socket, inbox, wait: () => waiting, nextWait: () => { waiting = new Promise<void>(resolve => { parked = resolve; }); } };
}

it("parks idle HTTPS pulls and uses only relay activity after a negotiated push offer", async () => {
  const f = await fixture(), socket = await connectRelay(f), frames: any[] = [];
  socket.on("message", raw => {
    const frame = JSON.parse(String(raw)); frames.push(frame);
    if (frame.t === "activity") socket.send(JSON.stringify({ t: "activity-reply", id: frame.id,
      loginRevision: "0", state: "running", prompts: false }));
  });
  socket.send(JSON.stringify({ t: "push", prompts: true }));
  const received = new Promise<void>(resolve => {
    socket.once("pong", () => resolve()); socket.once("close", () => resolve());
  });
  socket.ping(); await received;
  const controller = new AbortController();
  const pending = f.transport.promptRequest("pull", { waitMs: 25_000, held: [] }, controller.signal).catch(() => {});
  try {
    await f.transport.send({ t: "idle", idle: true });
    await expect.poll(() => frames.some(frame => frame.t === "activity") || f.requests.some(request => request.path === "activity")).toBe(true);
    console.info("Negotiated idle HTTP requests", f.requests.filter(request => ["activity", "pull"].includes(request.path)).length);
    expect(f.requests.filter(request => ["activity", "pull"].includes(request.path))).toEqual([]);
    expect(frames.filter(frame => frame.t === "activity")).toHaveLength(1);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally { controller.abort(); await pending; }
});

it("drains on hints and repairs a missed hint from the safety status reply", async () => {
  const f = await idleInbox();
  expect(f.requests.filter(request => request.path === "pull").map(request => request.body.waitMs)).toEqual([0]);
  f.nextWait(); f.socket.send(JSON.stringify({ t: "prompts" })); await f.wait();
  expect(f.requests.filter(request => request.path === "pull").map(request => request.body.waitMs)).toEqual([0, 0]);
  f.socket.on("message", raw => {
    const frame = JSON.parse(String(raw));
    if (frame.t === "activity") f.socket.send(JSON.stringify({ t: "activity-reply", id: frame.id,
      loginRevision: "0", state: "running", prompts: true }));
  });
  f.nextWait(); await f.transport.send({ t: "idle", idle: true }); await f.wait();
  expect(f.requests.filter(request => request.path === "pull").map(request => request.body.waitMs)).toEqual([0, 0, 0]);
  expect(f.requests.some(request => request.path === "activity")).toBe(false);
});

it.each(["listener-gap", "socket-close"])("resumes HTTPS promptly after %s and drains on a new subscription", async loss => {
  const f = await idleInbox();
  f.nextWait();
  if (loss === "listener-gap") f.socket.send(JSON.stringify({ t: "push", prompts: false }));
  else f.socket.terminate();
  await f.wait();
  await expect.poll(() => f.requests.some(request => request.path === "pull" && request.body.waitMs === 25_000)).toBe(true);
  const socket = loss === "socket-close" ? await connectRelay(f) : f.socket;
  f.nextWait(); socket.send(JSON.stringify({ t: "push", prompts: true })); await f.wait();
  expect(f.requests.filter(request => request.path === "pull").at(-1)!.body.waitMs).toBe(0);
});

it("keeps one safety pulse per minute at a stable random boot phase without idle HTTPS work", async () => {
  const f = await fixture(), socket = await connectRelay(f), pulses: number[] = [];
  socket.on("message", raw => {
    const frame = JSON.parse(String(raw));
    if (frame.t !== "activity") return;
    pulses.push(Date.now());
    socket.send(JSON.stringify({ t: "activity-reply", id: frame.id, loginRevision: "0", state: "running", prompts: false }));
  });
  socket.send(JSON.stringify({ t: "push", prompts: true })); await socketBoundary(socket);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await f.transport.send({ t: "idle", idle: true });
  await expect.poll(() => pulses.length).toBe(1); await socketBoundary(socket);
  const started = Date.now();
  for (let count = 2; count <= 7; count++) {
    await vi.advanceTimersToNextTimerAsync();
    await expect.poll(() => pulses.length).toBe(count); await socketBoundary(socket);
  }
  expect(pulses[1]! - started).toBeGreaterThan(0);
  expect(pulses[1]! - started).toBeLessThanOrEqual(60_000);
  expect(pulses.slice(2).map((at, index) => at - pulses[index + 1]!)).toEqual(Array(5).fill(60_000));
  expect(f.requests.filter(request => request.path === "activity")).toEqual([]);
});

it("R1 push-signals-v1: once accepted, the safety pulse runs every 5 min (no 1-min pulse) and busy repeats every 5 min", async () => {
  const f = await fixture(), socket = await connectRelay(f), pulses: number[] = [];
  socket.on("message", raw => {
    const frame = JSON.parse(String(raw));
    if (frame.t !== "activity") return;
    pulses.push(Date.now());
    socket.send(JSON.stringify({ t: "activity-reply", id: frame.id, loginRevision: "0", state: "running", prompts: false }));
  });
  socket.send(JSON.stringify({ t: "push", prompts: true })); await socketBoundary(socket);
  f.transport.setPushSignals(true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await f.transport.send({ t: "idle", idle: true });
  await expect.poll(() => pulses.length).toBe(1); await socketBoundary(socket);
  for (let count = 2; count <= 4; count++) {
    await vi.advanceTimersToNextTimerAsync();
    await expect.poll(() => pulses.length).toBe(count); await socketBoundary(socket);
  }
  expect(pulses.slice(2).map((at, index) => at - pulses[index + 1]!)).toEqual(Array(2).fill(300_000));
});

it("falls back to authenticated HTTPS after losing the activity ACK socket", async () => {
  const f = await fixture(), socket = await connectRelay(f);
  socket.on("message", raw => { if (JSON.parse(String(raw)).t === "activity") socket.terminate(); });
  socket.send(JSON.stringify({ t: "push", prompts: true })); await socketBoundary(socket);
  await f.rotate(); await f.transport.send({ t: "idle", idle: false });
  await expect.poll(() => f.requests.filter(request => request.path === "activity")).toEqual([{ path: "activity", body: { idle: false }, authorized: true }]);
});

it("uses HTTPS during a slow relay activity without detaching the app or adopting its late reply", async () => {
  const f = await fixture(), socket = await connectRelay(f), frames: any[] = [];
  socket.on("message", raw => { frames.push(JSON.parse(String(raw))); });
  socket.send(JSON.stringify({ t: "push", prompts: true })); await socketBoundary(socket);
  vi.spyOn(workerToken, "readWorkerToken").mockResolvedValue("synthetic-worker-token");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await f.transport.send({ t: "idle", idle: true });
  await expect.poll(() => frames.filter(frame => frame.t === "activity").length).toBe(1);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect.poll(() => f.requests.filter(request => request.path === "activity").length).toBe(1);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  await socketBoundary(socket);
  await f.transport.send({ t: "idle", idle: true });
  await expect.poll(() => f.requests.filter(request => request.path === "activity").length).toBe(2);
  expect(f.requests.filter(request => request.path === "activity").every(request => request.authorized)).toBe(true);
  expect(frames.filter(frame => frame.t === "activity")).toHaveLength(1);
  socket.send(JSON.stringify({ t: "activity-reply", id: frames.find(frame => frame.t === "activity").id,
    loginRevision: "99", state: "stopped", prompts: true }));
  await socketBoundary(socket);
  expect(f.requests.some(request => request.path === "config")).toBe(false);
  expect(f.incoming.filter(frame => frame.t === "prompts")).toHaveLength(1);
  await f.transport.send({ t: "idle", idle: true });
  await expect.poll(() => frames.filter(frame => frame.t === "activity").length).toBe(2);
  const next = frames.filter(frame => frame.t === "activity")[1];
  socket.send(JSON.stringify({ t: "activity-reply", id: next.id, loginRevision: "0", state: "running", prompts: false }));
  await socketBoundary(socket);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(f.requests.filter(request => request.path === "activity")).toHaveLength(2);
});

it("repairs a missed login notification from the relay status without a second activity request", async () => {
  const f = await fixture(), socket = await connectRelay(f); f.revise("4");
  socket.on("message", raw => {
    const frame = JSON.parse(String(raw));
    if (frame.t === "activity") socket.send(JSON.stringify({ t: "activity-reply", id: frame.id,
      loginRevision: "4", state: "running", prompts: false }));
  });
  socket.send(JSON.stringify({ t: "push", prompts: true })); await socketBoundary(socket);
  await f.transport.send({ t: "idle", idle: true });
  await expect.poll(() => f.incoming.at(-1)?.loginRevision).toBe("4");
  expect(f.requests.some(request => request.path === "config")).toBe(true);
  expect(f.requests.some(request => request.path === "activity")).toBe(false);
});
it("authenticates a checkout failure with the current worker token and boot, without source or error text", async () => {
  const f = await fixture();
  const original = vi.mocked(f.fetcher).getMockImplementation()!;
  vi.mocked(f.fetcher).mockImplementation(async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/checkout-failed")) {
      expect(new Headers(init?.headers).get("x-zeros-worker-boot")).toBe(f.transport.bootId);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-rotated-worker-token");
      expect(JSON.parse(String(init?.body))).toEqual({});
      return Response.json({ ok: true });
    }
    return original(url, init);
  });
  await f.rotate();
  await expect(f.transport.reportCheckoutFailure()).resolves.toBeUndefined();
  expect(vi.mocked(f.fetcher).mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith("/checkout-failed"))).toBe(true);
});

it("tolerates an old control plane without the checkout failure endpoint", async () => {
  const f = await fixture();
  await expect(f.transport.reportCheckoutFailure()).resolves.toBeUndefined();
  expect(f.requests.find(request => request.path === "checkout-failed")).toEqual({ path: "checkout-failed", body: {}, authorized: true });
});

it("retries an unacknowledged checkout failure before requesting another configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-checkout-failure-")), tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  let reports = 0, configurations = 0, configReads = 0, finish!: () => void;
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  const keys = generateKeyPairSync("ed25519");
  const publicKeys = [keys.publicKey.export({ type: "spki", format: "pem" }).toString()];
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id,
    runtimeSha256: "a".repeat(64), tokenFile, publicKeys, port: 0, retryBaseMs: 10, retryMaxMs: 10,
    onStatus: status => { if (status === "stopped") finish(); },
    fetch: async url => {
      const path = new URL(String(url)).pathname.split("/").at(-1);
      if (path === "checkout-failed") return ++reports === 1 ? new Response(null, { status: 503 }) : Response.json({ ok: true });
      if (path === "config") configReads++;
      return Response.json({ config });
    },
  });
  cleanups.push(async () => { await transport.dispose(); await rm(directory, { recursive: true, force: true }); });
  transport.start({ open: async () => {}, close: () => {}, frame: async frame => {
    if ((frame as { t: string }).t !== "config") return;
    configurations++;
    await transport.reportCheckoutFailure().catch(() => {});
    throw new Error("Checkout failed");
  } });
  await stopped;
  expect(reports).toBe(2);
  expect(configurations).toBe(1);
  expect(configReads).toBe(0);
});

it("holds dial-in config and app admission until the initial HTTPS hello has been applied", async () => {
  let release!: () => void;
  const hello = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ hello });
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(JSON.stringify({ iss: "zeros-cp", aud: config.workspace.id, boot: f.transport.bootId, iat: now, exp: now + 60, jti: randomUUID() })).toString("base64url");
  const payload = `v1.${claims}`;
  const grant = `${payload}.${sign(null, Buffer.from(payload), f.keys.privateKey).toString("base64url")}`;
  const socket = new WebSocket(`ws://127.0.0.1:${f.port}/v2/worker/bridge`, "zeros.cloud.v2.worker", { headers: { "X-Zeros-Worker-Auth": grant } });
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ ...config, loginRevision: "1" }));
    socket.send(JSON.stringify({ t: "open", clientId: randomUUID() }));
    // The pong follows both data frames, proving the listener has seen them.
    const pong = new Promise(resolve => socket.once("pong", resolve)); socket.ping(); await pong;
    expect(f.incoming).toEqual([]);
    release();
    await expect.poll(() => f.incoming.map(frame => frame.t)).toEqual(["config", "config", "open"]);
    expect(f.incoming.filter(frame => frame.t === "config").map(frame => frame.loginRevision)).toEqual(["0", "1"]);
  } finally { release(); socket.terminate(); }
});
it("registers its process boot and rereads the worker credential on every HTTP call", async () => {
  const f = await fixture();
  expect(f.requests[0]).toMatchObject({ path: "hello", body: { protocol: 2, runtimeSha256: "a".repeat(64) }, authorized: true });
  expect(f.requests[0]!.body.bootId).toEqual(expect.any(String));
  await f.rotate();
  const id = randomUUID(); await f.transport.send({ t: "request", id, kind: "github-token" });
  await expect.poll(() => f.incoming.some(frame => frame.t === "reply" && frame.id === id)).toBe(true);
  expect(f.requests.every(request => request.authorized)).toBe(true);
});
it("finishes a replacement hello slower than ten seconds without abandoning its boot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-slow-hello-")), tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const keys = generateKeyPairSync("ed25519"), statuses: string[] = [];
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const open = vi.fn(async () => {}), frame = vi.fn(async () => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    entered();
    await new Promise<void>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("Hello timed out")), { once: true });
      void held.then(resolve);
    });
    return Response.json({ config });
  });
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id,
    runtimeSha256: "a".repeat(64), tokenFile, port: 0, publicKeys: [keys.publicKey.export({ type: "spki", format: "pem" }).toString()],
    runtimeHandoff: { id: randomUUID(), bootId: randomUUID() }, fetch: fetcher, onStatus: status => statuses.push(status) });
  cleanups.push(async () => { release(); await transport.dispose(); await rm(directory, { recursive: true, force: true }); });
  transport.start({ open, frame, close: () => {} });
  await waiting;
  await vi.advanceTimersByTimeAsync(11_000);
  expect(statuses).toEqual([]);
  release();
  await expect.poll(() => statuses).toEqual(["connected"]);
  expect(open).toHaveBeenCalledOnce(); expect(frame).toHaveBeenCalledExactlyOnceWith(config);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(["finish", "cancel", "deadline"])("bounds a slow private-ready request including token I/O (%s)", async outcome => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let reading!: () => void, releaseToken!: () => void, fetching!: () => void, releaseFetch!: () => void;
  const tokenRead = new Promise<void>(resolve => { reading = resolve; }), tokenHeld = new Promise<void>(resolve => { releaseToken = resolve; });
  const fetched = new Promise<void>(resolve => { fetching = resolve; }), fetchHeld = new Promise<void>(resolve => { releaseFetch = resolve; });
  const read = vi.spyOn(workerToken, "readWorkerToken").mockImplementationOnce(async () => { reading(); await tokenHeld; return "synthetic-worker-token"; });
  const id = randomUUID(), controller = new AbortController();
  vi.mocked(f.fetcher).mockImplementationOnce(async (_url, init) => {
    fetching();
    await new Promise<void>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("Ready cancelled")), { once: true });
      void fetchHeld.then(resolve);
    });
    return Response.json({ status: "completed", id });
  });
  const pending = f.transport.runtimeUpdate({ op: "ready", id }, controller.signal);
  const result = pending.then(value => ({ value }), () => ({ refused: true }));
  try {
    await tokenRead; await vi.advanceTimersByTimeAsync(2000); releaseToken(); await fetched;
    await vi.advanceTimersByTimeAsync(9000);
    if (outcome === "cancel") controller.abort();
    else if (outcome === "deadline") await vi.advanceTimersByTimeAsync(19_000);
    else releaseFetch();
    expect(await result).toEqual(outcome === "finish" ? { value: { status: "completed", id } } : { refused: true });
  } finally { releaseToken(); releaseFetch(); read.mockRestore(); }
});

it.each(["cancel", "deadline", "dispose"])("ends a private-ready wait while the credential read is still held (%s)", async outcome => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const read = vi.spyOn(workerToken, "readWorkerToken").mockImplementationOnce(async () => { entered(); await held; return "synthetic-worker-token"; });
  const controller = new AbortController(), refused = vi.fn(), before = vi.mocked(f.fetcher).mock.calls.length;
  const pending = f.transport.runtimeUpdate({ op: "ready", id: randomUUID() }, controller.signal).catch(refused);
  try {
    await waiting;
    if (outcome === "deadline") await vi.advanceTimersByTimeAsync(30_000);
    else if (outcome === "cancel") controller.abort();
    else await f.transport.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(refused).toHaveBeenCalledOnce();
    expect(vi.mocked(f.fetcher).mock.calls).toHaveLength(before);
  } finally { release(); await pending; read.mockRestore(); }
  expect(vi.mocked(f.fetcher).mock.calls).toHaveLength(before);
});
it("allows a credential response slower than ten seconds and retains its typed refusal", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let release!: () => void, observed = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(f.fetcher).mockImplementationOnce(async (_url, init) => {
    observed = true;
    await new Promise<void>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("request timeout")), { once: true });
      void held.then(resolve);
    });
    return Response.json({ token: "fixture-slow", expiresAt: Date.now() + 120_000 });
  });
  const id = randomUUID();
  await f.transport.send({ t: "request", id, kind: "github-token" });
  await expect.poll(() => observed).toBe(true);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(f.incoming.filter(frame => frame.id === id)).toEqual([]);
  release();
  await expect.poll(() => f.incoming.some(frame => frame.t === "reply" && frame.id === id)).toBe(true);
  vi.mocked(f.fetcher).mockImplementationOnce(async () => Response.json({ error: {
    code: "github_token_unavailable", reason: "connection-expired", message: "PRIVATE_DETAIL" }, debug: "PRIVATE_DETAIL" }, { status: 409 }));
  const refused = randomUUID();
  await f.transport.send({ t: "request", id: refused, kind: "github-token" });
  await expect.poll(() => f.incoming.some(frame => frame.id === refused)).toBe(true);
  expect(f.incoming.find(frame => frame.id === refused)).toEqual({ t: "refusal", id: refused, code: "connection-expired" });
});
it("includes worker credential reads in the remaining HTTP request budget", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let release!: () => void, reading = false, fetching = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(workerToken, "readWorkerToken").mockImplementationOnce(async () => { reading = true; await held; return "synthetic-worker-token"; });
  vi.mocked(f.fetcher).mockImplementationOnce(async (_url, init) => {
    fetching = true;
    return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }); });
  });
  const id = randomUUID();
  await f.transport.send({ t: "request", id, kind: "github-token" }, { timeoutMs: 3000 });
  await expect.poll(() => reading).toBe(true);
  await vi.advanceTimersByTimeAsync(2000); release();
  await expect.poll(() => fetching).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.incoming.find(frame => frame.id === id)).toEqual({ t: "refusal", id, code: "unavailable" });
});
it.each([
  { status: 409, code: "mcp_auth_required", reason: "sign-in-required" },
  { status: 403, code: "mcp_access_denied", reason: "sign-in-refused" },
  { status: 503, code: "upstream_unavailable", reason: "server-error" },
  { status: 401, code: "unauthorized", reason: "unreachable" },
  { status: 409, code: "unrecognized_failure", reason: "server-error" },
])("retains only the confirmed MCP $reason category from HTTP $status/$code", async ({ status, code, reason }) => {
  const f = await fixture(), serverId = randomUUID();
  vi.mocked(f.fetcher).mockImplementationOnce(async () => Response.json({ error: { code,
    message: "PRIVATE_CONTROL_PLANE_DIAGNOSTIC" }, debug: { secret: "PRIVATE_CONTROL_PLANE_DIAGNOSTIC" } }, { status }));
  const failure = await f.transport.mcpAuthorization(serverId).catch(error => error);
  expect(failure).toMatchObject({ cloud: { source: "mcp", serverId, reason } });
  expect(failure.message).not.toContain("PRIVATE_CONTROL_PLANE_DIAGNOSTIC");
  expect(JSON.stringify(failure)).not.toContain("PRIVATE_CONTROL_PLANE_DIAGNOSTIC");
});
it("bounds optional timing reports per phase and ignores an older control plane's missing endpoint", async () => {
  const f = await fixture();
  for (let i = 0; i < 20; i++) f.transport.reportTiming({ phase: "worker_checkout", durationMs: 10 });
  await expect.poll(() => f.requests.filter(request => request.path === "timing").length).toBe(1);
  await f.transport.send({ t: "idle", idle: false });
  await expect.poll(() => f.requests.some(request => request.path === "activity")).toBe(true);
  expect(f.requests.filter(request => request.path === "hello")).toHaveLength(1);
  expect(f.requests.find(request => request.path === "timing")).toMatchObject({ body: { phase: "worker_checkout", durationMs: 10 }, authorized: true });
});
it("ignores an older control plane that rejects a newer timing phase", async () => {
  const f = await fixture();
  let rejected = 0;
  vi.mocked(f.fetcher).mockImplementationOnce(async () => { rejected++; return Response.json({ error: { code: "invalid_input" } }, { status: 400 }); });
  f.transport.reportTiming({ phase: "worker_workspace_watch", durationMs: 12 });
  await expect.poll(() => rejected).toBe(1);
  f.transport.reportTiming({ phase: "worker_workspace_watch", durationMs: 12 });
  await f.transport.send({ t: "idle", idle: false });
  await expect.poll(() => f.requests.some(request => request.path === "activity")).toBe(true);
  expect(rejected).toBe(1);
  expect(f.requests.filter(request => request.path === "timing")).toHaveLength(0);
});
it("advertises outbox support without changing the strict hello body, and rereads credentials on pull", async () => {
  const f = await fixture();
  expect(new Headers(vi.mocked(f.fetcher).mock.calls[0]![1]?.headers).get("x-zeros-worker-features")).toBe("prompt-outbox-v1,mcp-v1,workspace-setup-v1,checkout-v2,agent-interactions-v1,github-pr-v1,git-identity-v1,github-user-token-v1,code-review-v1,history-replace-v1,workspace-environment-v1,repository-setup-v1,runtime-update-v1,worker-push-v1,workspace-api-v1,session-name-v1,chat-edit-v1,local-commands-v1,setup-status-v1,notify-user-v1,sync-v1,local-commands-reason-v1,acting-user-v1,sync-context-v1,creator-agent-logins-v1,creator-agent-models-v1,creator-commit-identity-v1,push-signals-v1,recovery-quiesce-v1");
  expect(Object.keys(f.requests[0]!.body).sort()).toEqual(["bootId", "protocol", "runtimeSha256"]);
  await f.rotate();
  vi.mocked(f.fetcher).mockImplementationOnce(async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-rotated-worker-token");
    expect(new Headers(init?.headers).get("x-zeros-worker-boot")).toBe(f.transport.bootId);
    return Response.json({ prompts: [], stops: [] });
  });
  expect(await f.transport.promptRequest("pull", { waitMs: 25_000 })).toEqual({ prompts: [], stops: [] });
});
it("retries a lost history acknowledgement with the same boot, sequence and rows before sending a new snapshot", async () => {
  const f = await fixture(); f.loseReply();
  expect(await f.transport.send({ t: "history", chats: [{ id: "chat" }] })).toBe(false);
  await expect.poll(() => f.requests.filter(request => request.path === "history").length).toBe(2);
  const writes = f.requests.filter(request => request.path === "history");
  expect(writes[0]!.body).toEqual(writes[1]!.body);
  expect(writes[0]!.body.sequence).toBe(1);
  await f.transport.send({ t: "history", chatDeletions: ["other"] });
  expect(f.requests.filter(request => request.path === "history").at(-1)!.body.sequence).toBe(2);
  expect(f.incoming.filter(frame => frame.t === "config").length).toBeGreaterThan(1);
});
it("repairs missed login pushes through activity and replaces credentials with the latest revision", async () => {
  const f = await fixture(); f.revise("4");
  await f.transport.send({ t: "idle", idle: false });
  await expect.poll(() => f.incoming.at(-1)?.loginRevision).toBe("4");
  expect(f.requests.some(request => request.path === "config")).toBe(true);
});
it("retains a history retry whose timer fires during an earlier configuration repair", async () => {
  const f = await fixture(), original = vi.mocked(f.fetcher).getMockImplementation()!;
  let release!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(f.fetcher).mockImplementation(async (url, init) => {
    if (String(url).endsWith("/config") && !held) { held = true; await gate; }
    return original(url, init);
  });
  try {
    f.loseReply();
    expect(await f.transport.send({ t: "history", chats: [{ id: "first" }] })).toBe(false);
    await expect.poll(() => held).toBe(true);
    f.loseReply();
    expect(await f.transport.send({ t: "history", chats: [{ id: "second" }] })).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 40));
    release();
    await expect.poll(() => f.requests.filter(request => request.path === "history" && request.body.sequence === 2).length).toBe(2);
  } finally { release(); }
});
it("throttles busy activity and still heartbeats while idle", async () => {
  const f = await fixture();
  vi.spyOn(workerToken, "readWorkerToken").mockResolvedValue("synthetic-worker-token");
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
  // Sending idle also schedules the unconditional heartbeat after bootstrap.
  await f.transport.send({ t: "idle", idle: false });
  for (let i = 0; i < 100; i++) await f.transport.send({ t: "idle", idle: false });
  await expect.poll(() => f.requests.filter(request => request.path === "activity").length).toBe(1);
  await f.transport.send({ t: "idle", idle: true });
  await expect.poll(() => f.requests.filter(request => request.path === "activity").length).toBe(2);
  await new Promise(resolve => setImmediate(resolve));
  const before = f.requests.filter(request => request.path === "activity").length;
  await vi.advanceTimersByTimeAsync(60_000);
  await expect.poll(() => f.requests.filter(request => request.path === "activity").length).toBeGreaterThan(before);
});
it("requires HTTPS away from loopback and rejects credentials or query parameters in API URLs", () => {
  for (const apiUrl of ["http://elsewhere.test", "https://user:password@api.test", "https://api.test?token=synthetic"])
    expect(() => new HybridTransport({ apiUrl, workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64) })).toThrow("Invalid worker API URL");
});
it("asks the control plane for an activated context's own GitHub credential: the request keeps its contextId", async () => {
  const f = await fixture();
  const contextId = randomUUID(), id = randomUUID();
  await f.transport.send({ t: "request", id, kind: "github-token", purpose: "git", contextId });
  await expect.poll(() => f.incoming.some(frame => frame.t === "reply" && frame.id === id)).toBe(true);
  expect(f.requests.find(request => request.path === "github-token")!.body).toEqual({ purpose: "git", contextId });
});
it("sends its safety heartbeat at its phase: a phase due now adds exactly one more activity", async () => {
  // The flake's mechanism, made deterministic: a random boot phase could fall inside a test.
  const f = await fixture({ heartbeatPhase: Date.now() - 59_950 });
  await expect.poll(() => f.requests.filter(request => request.path === "activity").length, { timeout: 3_000 }).toBeGreaterThanOrEqual(1);
});

/** Transport parity (PR #1055): an activated GitHub request lost its contextId only on the real HTTP carrier. Every
 * worker → control-plane request the protocol lets carry a context must reach the HTTP body unchanged. The set is
 * enumerated from the protocol's schemas, so a new context-carrying schema fails here until it is classified. */
describe("worker → control plane context parity", () => {
  const contextual = () => {
    const found = new Set<string>();
    const walk = (schema: any, label: string, seen = new Set<unknown>()): void => {
      if (!schema?._zod || seen.has(schema)) return; seen.add(schema);
      const def = schema._zod.def;
      if (def.type === "object") {
        const keys = Object.keys(def.shape);
        const t = def.shape.t?._zod?.def?.values ? `[t=${[...def.shape.t._zod.def.values].join("|")}]` : "";
        if (keys.includes("contextId") || keys.includes("contextIds")) found.add(`${label}${t}`);
        for (const [key, value] of Object.entries(def.shape)) walk(value, `${label}.${key}`, seen);
      } else if (def.type === "union") for (const option of def.options) walk(option, label, seen);
      else for (const key of ["in", "out", "innerType", "element"]) if (def[key]) walk(def[key], label, seen);
    };
    for (const [name, value] of Object.entries({ ...relayProtocol, ...notifyProtocol })) walk(value, name);
    return found;
  };
  const C = "66666666-6666-4666-8666-666666666666", M = "77777777-7777-4777-8777-777777777777";
  /** Control plane → worker shapes (replies and control frames): nothing to forward. */
  const INBOUND = new Set(["CloudV2BeginActiveReplySchema", "CloudV2BootstrapLeaseSchema", "CloudV2ClientLeaseSchema", "CloudV2ControlFrameSchema[t=open]",
    "CloudV2ControlFrameSchema[t=revoke-context]", "CloudV2RenewReplySchema.leases", "CloudV2TerminalLeaseSchema", "CloudV2TurnLeaseSchema"]);
  type Case = { schema: any; sample: Record<string, unknown>; framing?: string[]; path: string; send: (transport: HybridTransport, sample: any) => Promise<unknown> };
  const REQUESTS: Record<string, Case> = {
    "CloudV2WorkerFrameSchema[t=request]": { schema: relayProtocol.CloudV2WorkerFrameSchema, framing: ["t", "id", "kind"], path: "github-token",
      sample: { t: "request", id: M, kind: "github-token", purpose: "gh", failedTokenSha256: "a".repeat(64), contextId: C },
      send: (transport, sample) => transport.send(sample) },
    "CloudV2BootstrapLeaseRequestSchema": { schema: relayProtocol.CloudV2BootstrapLeaseRequestSchema, path: "bootstrap-lease", sample: { contextId: C },
      send: (transport, sample) => transport.contextRequest("bootstrap-lease", sample) },
    "CloudV2RenewRequestSchema": { schema: relayProtocol.CloudV2RenewRequestSchema, path: "renew", sample: { contextIds: [C, M] },
      send: (transport, sample) => transport.contextRequest("execution-leases/renew", sample) },
    "CloudV2TurnLeaseRequestSchema": { schema: relayProtocol.CloudV2TurnLeaseRequestSchema, path: "turn-lease",
      sample: { chatId: "chat", userMessageId: M, dispatchId: M, generation: "1", contextId: C },
      send: (transport, sample) => transport.contextRequest("turn-lease", sample) },
    "NotifyUserWorkerRequestSchema": { schema: notifyProtocol.NotifyUserWorkerRequestSchema, path: "notifications",
      sample: { title: "Done", message: "Ready", kind: "review", notificationId: M, chatId: "chat", userMessageId: M, executionId: "execution", contextId: C },
      send: (transport, sample) => transport.notifyUser(sample) },
  };

  it("classifies every context-carrying protocol schema as forwarded (with a case below) or control plane → worker", () => {
    const found = contextual();
    expect([...found].filter(label => !INBOUND.has(label) && !REQUESTS[label])).toEqual([]);
    expect([...INBOUND, ...Object.keys(REQUESTS)].filter(label => !found.has(label))).toEqual([]);
  });

  it.each(Object.keys(REQUESTS))("forwards %s to the control plane with every field, contextId included", async label => {
    const { schema, sample, framing = [], path, send } = REQUESTS[label]!;
    expect(schema.safeParse(sample).success).toBe(true);
    const shape = (schema._zod.def.type === "object" ? schema : schema._zod.def.options.find((option: any) => [...(option._zod.def.shape.t?._zod.def.values ?? [])].includes(sample.t)))._zod.def.shape;
    // The sample sets every field the schema allows, so a new field is compared too.
    expect(Object.keys(shape).filter(key => !(key in sample))).toEqual([]);
    const f = await fixture();
    await send(f.transport, sample).catch(() => {});
    await expect.poll(() => f.requests.find(request => request.path === path)).toBeDefined();
    const expected = Object.fromEntries(Object.entries(sample).filter(([key]) => !framing.includes(key)));
    expect(f.requests.find(request => request.path === path)!.body).toEqual(expected);
  });

  it("forwards the context of the requests whose shapes live outside the protocol: terminal, client and retirement leases, local commands, MCP authorization", async () => {
    const f = await fixture();
    const cases: Array<[string, () => Promise<unknown>, Record<string, unknown>]> = [
      ["terminal-lease", () => f.transport.contextRequest("terminal-lease", { clientId: M, terminalId: "t", requestId: "r" }), { clientId: M, terminalId: "t", requestId: "r" }],
      ["client-lease", () => f.transport.contextRequest("client-lease", { clientId: M, requestId: "r", operation: "git.push" }), { clientId: M, requestId: "r", operation: "git.push" }],
      ["retired", () => f.transport.contextRequest(`execution-leases/${C}/retired`, { retirementId: M, reason: "operation_done", processes: 0 }), { retirementId: M, reason: "operation_done", processes: 0 }],
      ["authorization", () => f.transport.mcpAuthorization(M, true, undefined, C), { force: true, contextId: C }],
    ];
    for (const [path, send, body] of cases) {
      await send().catch(() => {});
      await expect.poll(() => f.requests.find(request => request.path === path)?.body).toEqual(body);
    }
    const controller = new AbortController();
    const local = f.transport.localCommand({ chatId: "chat", executionId: "execution", input: { command: "pwd" } as never, contextId: C }, controller.signal).catch(() => {});
    await expect.poll(() => f.requests.find(request => request.path === "local-commands")?.body).toMatchObject({ chatId: "chat", executionId: "execution", contextId: C });
    controller.abort(); await local;
  });
});

it("R1: a negotiated 60 s pull keeps its HTTP request open past 35 s and is bounded just past its wait", async () => {
  const f = await fixture();
  let abortedAt: number | undefined;
  const started = { at: 0 };
  vi.mocked(f.fetcher).mockImplementationOnce(async (_url, init) => new Promise<Response>((_, reject) => {
    started.at = Date.now();
    init!.signal!.addEventListener("abort", () => { abortedAt = Date.now(); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  }));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const pending = f.transport.promptRequest("pull", { waitMs: 60_000, held: [] }).catch(() => "aborted");
    for (let i = 0; i < 50 && !started.at; i++) { await vi.advanceTimersByTimeAsync(0); await new Promise(resolve => setImmediate(resolve)); }
    expect(started.at).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(abortedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(abortedAt! - started.at).toBeGreaterThanOrEqual(60_000);
    expect(abortedAt! - started.at).toBeLessThanOrEqual(75_000);
    expect(await pending).toBe("aborted");
  } finally { vi.useRealTimers(); }
});

it("history-digest-v1: the digests read is authenticated exactly like the history POST", async () => {
  const f = await fixture();
  vi.mocked(f.fetcher).mockImplementationOnce(async (url, init) => {
    expect(new URL(String(url)).pathname).toBe("/v2/cloud/worker/history/digests");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-worker-token");
    expect(new Headers(init?.headers).get("x-zeros-worker-boot")).toBe(f.transport.bootId);
    return Response.json({ chats: [] });
  });
  expect(await f.transport.historyDigests()).toEqual({ chats: [] });
});

import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { HybridTransport } from "../hybrid-transport";
import { InboundBridge } from "../inbound-bridge";
import { config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });
async function fixture(options: { hello?: Promise<void> } = {}) {
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
    if (path === "history") {
      if (lostReply) { lostReply = false; throw new Error("Lost committed response"); }
      return failHistory ? new Response(null, { status: 503 }) : Response.json({ sequence: body.sequence });
    }
    if (path === "github-token") return Response.json({ token: "synthetic-github-token", expiresAt: Date.now() + 60_000 });
    return new Response(null, { status: 404 });
  });
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64),
    tokenFile, publicKeys, port: 0, fetch: fetcher, retryBaseMs: 10, retryMaxMs: 20 });
  transport.start({ open: async () => {}, close: () => {}, frame: async frame => { incoming.push(frame); } });
  cleanups.push(async () => { await transport.dispose(); await rm(directory, { recursive: true, force: true }); });
  await expect.poll(() => options.hello ? requests.length > 0 : incoming.some(frame => frame.t === "config")).toBe(true);
  return { transport, requests, incoming, fetcher, port, keys, revise: (next: string) => { revision = next; },
    rotate: async () => { expected = "synthetic-rotated-worker-token"; await writeFile(tokenFile, expected, { mode: 0o600 }); },
    failHistory: (value: boolean) => { failHistory = value; }, loseReply: () => { lostReply = true; } };
}
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
it("bounds optional timing reports per phase and ignores an older control plane's missing endpoint", async () => {
  const f = await fixture();
  for (let i = 0; i < 20; i++) f.transport.reportTiming({ phase: "worker_checkout", durationMs: 10 });
  await expect.poll(() => f.requests.filter(request => request.path === "timing").length).toBe(1);
  await f.transport.send({ t: "idle", idle: false });
  await expect.poll(() => f.requests.some(request => request.path === "activity")).toBe(true);
  expect(f.requests.filter(request => request.path === "hello")).toHaveLength(1);
  expect(f.requests.find(request => request.path === "timing")).toMatchObject({ body: { phase: "worker_checkout", durationMs: 10 }, authorized: true });
});
it("advertises outbox support without changing the strict hello body, and rereads credentials on pull", async () => {
  const f = await fixture();
  expect(new Headers(vi.mocked(f.fetcher).mock.calls[0]![1]?.headers).get("x-zeros-worker-features")).toBe("prompt-outbox-v1,mcp-v1,workspace-setup-v1,checkout-v2");
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

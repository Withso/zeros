import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { afterEach, expect, it } from "vitest";
import type { CloudV2ControlFrame } from "@zeros/protocol/cloud-v2-relay";
import { InboundBridge } from "../inbound-bridge";

const key = generateKeyPairSync("ed25519"), workspaceId = randomUUID(), bootId = randomUUID();
const device = "22222222-2222-4222-8222-222222222222";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
let clock = Date.now();
function grant(extra: Record<string, unknown> = { scope: "sync", sub: "user_1", dev: device }, iatOffset = 0): string {
  const now = Math.floor(clock / 1000) + iatOffset;
  const body = `v1.${Buffer.from(JSON.stringify({ iss: "zeros-cp", aud: workspaceId, boot: bootId, iat: now, exp: now + 60, jti: randomUUID(), ...extra })).toString("base64url")}`;
  return `${body}.${sign(null, Buffer.from(body), key.privateKey).toString("base64url")}`;
}
const control = () => grant({});

async function fixture() {
  clock = Date.now();
  const incoming: CloudV2ControlFrame[] = [];
  const bridge = new InboundBridge({ workspaceId, bootId, port: 0, publicKeys: [key.publicKey.export({ type: "spki", format: "pem" }).toString()], now: () => clock });
  const address = await bridge.start(async frame => { incoming.push(frame); });
  cleanups.push(() => bridge.dispose());
  const base = `ws://127.0.0.1:${address.port}`;
  const dial = (path: string, protocol: string, auth: string) => new Promise<{ ws: WebSocket; status: number; frames: unknown[] }>(resolve => {
    const ws = new WebSocket(`${base}${path}`, protocol, { headers: { "X-Zeros-Worker-Auth": auth, Cookie: "_port_auth=synthetic-port-auth-value" } });
    const frames: unknown[] = [];
    ws.on("error", () => {});
    ws.on("message", raw => frames.push(JSON.parse(raw.toString())));
    ws.on("unexpected-response", (_request, response) => { response.resume(); resolve({ ws, status: response.statusCode!, frames }); });
    ws.on("open", () => resolve({ ws, status: 101, frames }));
  });
  return { bridge, incoming, dial };
}

it("opens the sync path only with a sync grant and only the sync protocol; a sync grant opens nothing else", async () => {
  const f = await fixture();
  expect((await f.dial("/v2/worker/sync", "zeros.worker.sync.v1", control())).status).toBe(401);
  expect((await f.dial("/v2/worker/bridge", "zeros.cloud.v2.worker", grant())).status).toBe(401);
  expect((await f.dial("/v2/worker/sync", "zeros.worker.sync.v1", grant({ scope: "control", sub: "user_1", dev: device }))).status).toBe(401);
  expect((await f.dial("/v2/worker/sync", "zeros.cloud.v2.worker", grant())).status).toBe(400);
  const used = grant();
  expect((await f.dial("/v2/worker/sync", "zeros.worker.sync.v1", used)).status).toBe(101);
  expect((await f.dial("/v2/worker/sync", "zeros.worker.sync.v1", used)).status).toBe(401); // single use
});

it("gives each sync socket one passive client, carries plain bridge messages, and keeps broadcasts away from it", async () => {
  const f = await fixture();
  const sync = await f.dial("/v2/worker/sync", "zeros.worker.sync.v1", grant());
  await expect.poll(() => f.incoming.find(frame => frame.t === "open")).toMatchObject({ t: "open", passive: true });
  const clientId = (f.incoming.find(frame => frame.t === "open") as { clientId: string }).clientId;
  sync.ws.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: "r1", op: "sync.snapshot", params: {} }));
  await expect.poll(() => f.incoming.find(frame => frame.t === "frame")).toEqual({ t: "frame", clientId, frame: { type: "WORKSPACE_REQUEST", id: "r1", op: "sync.snapshot", params: {} } });
  await f.bridge.send({ t: "frame", clientId, frame: { type: "WORKSPACE_RESPONSE", requestId: "r1" } } as never);
  await f.bridge.send({ t: "frame", clientId: "*", frame: { type: "DB_CHANGED", kinds: ["chats"] } } as never);
  await expect.poll(() => sync.frames).toEqual([{ type: "WORKSPACE_RESPONSE", requestId: "r1" }]);
  sync.ws.close();
  await expect.poll(() => f.incoming.at(-1)).toEqual({ t: "close", clientId });
});

const sync = (f: Awaited<ReturnType<typeof fixture>>, auth: string) => f.dial("/v2/worker/sync", "zeros.worker.sync.v1", auth);
const request = (ws: WebSocket, id: string) => ws.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id, op: "sync.snapshot", params: {} }));
const closedWith = async (ws: WebSocket) => ws.readyState === WebSocket.CLOSED ? null : (await once(ws, "close") as [number])[0];

it("ends a sync socket at its grant's signed iat + 600 s less 30 s, checked on each request, whatever the clock skew", async () => {
  for (const skew of [25, -25]) {
    const f = await fixture();
    const socket = await sync(f, grant(undefined, skew));
    const deadline = (Math.floor(clock / 1000) + skew + 570) * 1000;
    clock = deadline - 1; request(socket.ws, "before");
    await expect.poll(() => f.incoming.filter(frame => frame.t === "frame")).toHaveLength(1);
    clock = deadline; request(socket.ws, "after");
    expect(await closedWith(socket.ws)).toBe(4001);
    expect(f.incoming.filter(frame => frame.t === "frame")).toHaveLength(1);
  }
});

it("lets only a newer signed grant move the deadline: a held or late renewal cannot, and another Mac's closes it", async () => {
  const f = await fixture();
  const start = clock, first = await sync(f, grant());
  const held = grant(undefined, -20);                  // minted earlier, presented later
  clock = start + 100_000; first.ws.send(JSON.stringify({ t: "renew", grant: held }));
  clock = (Math.floor(start / 1000) + 570) * 1000; request(first.ws, "x");
  expect(await closedWith(first.ws)).toBe(4001);
  const second = await sync(f, grant());
  clock = (Math.floor(clock / 1000) + 570) * 1000;  // its deadline: a renewal now is too late
  second.ws.send(JSON.stringify({ t: "renew", grant: grant() }));
  expect(await closedWith(second.ws)).toBe(4001);
  const third = await sync(f, grant()), base = clock;
  clock = base + 500_000; third.ws.send(JSON.stringify({ t: "renew", grant: grant() }));   // fresh: extends to its own iat + 570 s
  request(third.ws, "probe");   // frames are handled in order: the renewal is in once the probe arrives
  await expect.poll(() => f.incoming.some(frame => frame.t === "frame" && (frame as { frame: { id?: string } }).frame.id === "probe")).toBe(true);
  clock = base + 600_000; request(third.ws, "y");
  await expect.poll(() => f.incoming.filter(frame => frame.t === "frame" && (frame as { frame: { id?: string } }).frame.id === "y")).toHaveLength(1);
  for (const bad of [grant({ scope: "sync", sub: "user_1", dev: "33333333-3333-4333-8333-333333333333" }), grant({ scope: "sync", sub: "user_2", dev: device }), control(), "nonsense"]) {
    const socket = await sync(f, grant());
    socket.ws.send(JSON.stringify({ t: "renew", grant: bad }));
    expect(await closedWith(socket.ws)).toBe(4001);
  }
});

it("never delivers a reply after the deadline, even for a request made in time", async () => {
  const f = await fixture();
  const socket = await sync(f, grant());
  request(socket.ws, "in-flight");
  await expect.poll(() => f.incoming.find(frame => frame.t === "open")).toBeDefined();
  const clientId = (f.incoming.find(frame => frame.t === "open") as { clientId: string }).clientId;
  await expect.poll(() => f.incoming.filter(frame => frame.t === "frame")).toHaveLength(1);
  clock = (Math.floor(clock / 1000) + 570) * 1000;
  expect(await f.bridge.send({ t: "frame", clientId, frame: { type: "WORKSPACE_RESPONSE", requestId: "in-flight" } } as never)).toBe(false);
  expect(await closedWith(socket.ws)).toBe(4001);
  expect(socket.frames).toEqual([]);
});

it("holds a slow Mac's sync replies (backpressure) instead of terminating its socket, and delivers them in order once it reads", async () => {
  const f = await fixture();
  const socket = await sync(f, grant());
  await expect.poll(() => f.incoming.find(frame => frame.t === "open")).toBeDefined();
  const clientId = (f.incoming.find(frame => frame.t === "open") as { clientId: string }).clientId;
  // A slow link: the Mac stops reading, so the worker's send buffer fills.
  const raw = (socket.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
  raw.pause();
  const big = (index: number) => ({ type: "WORKSPACE_RESPONSE", requestId: `r${index}`, result: { base64: String(index).repeat(3 * 1024 * 1024) } });
  const sends = [0, 1, 2, 3].map(index => f.bridge.send({ t: "frame", clientId, frame: big(index) } as never));
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(socket.ws.readyState).toBe(WebSocket.OPEN);
  raw.resume();
  expect(await Promise.all(sends)).toEqual([true, true, true, true]);
  await expect.poll(() => socket.frames.length, { timeout: 10_000 }).toBe(4);
  expect(socket.frames.map(frame => (frame as { requestId: string }).requestId)).toEqual(["r0", "r1", "r2", "r3"]);
}, 30_000);

/** Team sharing 3A (sync-context-v1): an activated workspace's sync socket carries a control-plane handle (ctx). */
const ctx = "66666666-6666-4666-8666-666666666666";
async function scopedFixture(admit: (ctx: string, sub: string) => Promise<boolean> = async () => true, live: (ctx: string) => boolean = () => true) {
  clock = Date.now();
  const incoming: CloudV2ControlFrame[] = [], admitted: string[] = [], released: string[] = [];
  const ends = new Map<string, () => void>();
  const bridge = new InboundBridge({ workspaceId, bootId, port: 0, publicKeys: [key.publicKey.export({ type: "spki", format: "pem" }).toString()], now: () => clock,
    syncContexts: { required: () => true, admit: async (context, sub) => { admitted.push(context); return admit(context, sub); },
      ended: (context, listener) => { ends.set(context, listener); return () => ends.delete(context); }, release: context => { released.push(context); }, live } });
  const address = await bridge.start(async frame => { incoming.push(frame); });
  cleanups.push(() => bridge.dispose());
  const dial = (auth: string) => new Promise<{ ws: WebSocket; status: number }>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v2/worker/sync`, "zeros.worker.sync.v1", { headers: { "X-Zeros-Worker-Auth": auth } });
    ws.on("error", () => {});
    ws.on("unexpected-response", (_request, response) => { response.resume(); resolve({ ws, status: response.statusCode! }); });
    ws.on("open", () => resolve({ ws, status: 101 }));
  });
  return { bridge, incoming, admitted, released, ends, dial };
}
const scoped = (extra: Record<string, unknown> = {}) => grant({ scope: "sync", sub: "44444444-4444-4444-8444-444444444444", dev: device, ctx, ...extra });

it("refuses an activated workspace's sync grant without its handle, and reads nothing before the handle's first renewal succeeds", async () => {
  const f = await scopedFixture();
  expect((await f.dial(grant())).status).toBe(401);
  expect((await f.dial(scoped({ ctx: "not-a-uuid" }))).status).toBe(401);
  let allow!: (value: boolean) => void;
  const g = await scopedFixture(() => new Promise(resolve => { allow = resolve; }));
  const socket = await g.dial(scoped());
  expect(socket.status).toBe(101);
  request(socket.ws, "early");
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(g.admitted).toEqual([ctx]);
  expect(g.incoming).toEqual([]);
  allow(true);
  await expect.poll(() => g.incoming.map(frame => frame.t)).toEqual(["open", "frame"]);
});

it("closes the socket 4001 when the handle's first renewal is refused, when the handle ends, or when a renewal names another handle", async () => {
  const refused = await scopedFixture(async () => false);
  const denied = await refused.dial(scoped());
  expect(await closedWith(denied.ws)).toBe(4001);
  expect(refused.incoming).toEqual([]);
  const f = await scopedFixture();
  const first = await f.dial(scoped());
  await expect.poll(() => f.incoming.length).toBe(1);
  f.ends.get(ctx)!();
  expect(await closedWith(first.ws)).toBe(4001);
  const second = await f.dial(scoped());
  await expect.poll(() => f.incoming.filter(frame => frame.t === "open").length).toBe(2);
  second.ws.send(JSON.stringify({ t: "renew", grant: scoped({ ctx: "77777777-7777-4777-8777-777777777777" }) }));
  expect(await closedWith(second.ws)).toBe(4001);
});

it("keeps one live socket per handle: a new one replaces its predecessor, and only the last close releases it", async () => {
  const f = await scopedFixture();
  const first = await f.dial(scoped());
  await expect.poll(() => f.incoming.length).toBe(1);
  const second = await f.dial(scoped());
  expect(await closedWith(first.ws)).toBe(1000);
  expect(f.released).toEqual([]);
  second.ws.close();
  await expect.poll(() => f.released).toEqual([ctx]);
});

it("J-3A1: checks the handle's own deadline before every read and every reply, closing 4001 at it even between renewal ticks", async () => {
  let alive = true;
  const f = await scopedFixture(async () => true, () => alive);
  const socket = await f.dial(scoped());
  request(socket.ws, "in-time");
  await expect.poll(() => f.incoming.map(frame => frame.t)).toEqual(["open", "frame"]);
  const clientId = (f.incoming.find(frame => frame.t === "open") as { clientId: string }).clientId;
  // The control plane's (shortened) deadline passed; no renewal tick or end push has run yet. The signed grant is still far from its own.
  alive = false;
  expect(await f.bridge.send({ t: "frame", clientId, frame: { type: "WORKSPACE_RESPONSE", requestId: "in-time" } } as never)).toBe(false);
  expect(await closedWith(socket.ws)).toBe(4001);
  const late = await f.dial(scoped());
  await expect.poll(() => f.incoming.filter(frame => frame.t === "open").length).toBe(2);
  request(late.ws, "expired-read");
  expect(await closedWith(late.ws)).toBe(4001);
  expect(f.incoming.filter(frame => frame.t === "frame")).toHaveLength(1);
});

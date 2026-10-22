import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { afterEach, expect, it } from "vitest";
import { InboundBridge } from "../inbound-bridge";
import type { CloudV2ControlFrame } from "@zeros/protocol/cloud-v2-relay";

const key = generateKeyPairSync("ed25519"), workspaceId = randomUUID(), bootId = randomUUID();
const protocol = "zeros.cloud.v2.worker";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
function token(boot = bootId): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `v1.${Buffer.from(JSON.stringify({ iss: "zeros-cp", aud: workspaceId, boot, iat: now, exp: now + 60, jti: randomUUID() })).toString("base64url")}`;
  return `${body}.${sign(null, Buffer.from(body), key.privateKey).toString("base64url")}`;
}
async function fixture(options: { failedAuthLimit?: number; pingIntervalMs?: number } = {}) {
  const incoming: CloudV2ControlFrame[] = [];
  const listener = new InboundBridge({ workspaceId, bootId, port: 0,
    publicKeys: [key.publicKey.export({ type: "spki", format: "pem" }).toString()], ...options });
  const address = await listener.start(async frame => { incoming.push(frame); });
  cleanups.push(() => listener.dispose());
  const url = `ws://127.0.0.1:${address.port}/v2/worker/bridge`;
  async function connect(auth = token()) {
    const ws = new WebSocket(url, protocol, { headers: { "X-Zeros-Worker-Auth": auth } });
    ws.on("error", () => {});
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", raw => frames.push(JSON.parse(raw.toString())));
    await once(ws, "open");
    return { ws, frames };
  }
  const refusal = (auth?: string, target = url) => new Promise<number>(resolve => {
    const ws = new WebSocket(target, protocol, { headers: auth ? { "X-Zeros-Worker-Auth": auth } : {} });
    ws.on("error", () => {});
    ws.on("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode!); ws.terminate(); });
    ws.on("open", () => { resolve(101); ws.terminate(); });
  });
  return { listener, address, url, incoming, connect, refusal };
}

it("binds only loopback and authenticates before upgrading or accepting a frame", async () => {
  const f = await fixture();
  expect(f.address.address).toBe("127.0.0.1");
  expect(await f.refusal()).toBe(401);
  expect(await f.refusal(token(randomUUID()))).toBe(401);
  expect(await f.refusal(token(), f.url.replace("/bridge", "/other"))).toBe(404);
  expect(f.incoming).toEqual([]);
  const auth = token(), connected = await f.connect(auth);
  expect(connected.ws.protocol).toBe(protocol);
  expect(connected.ws.extensions).toBe("");
  expect(await f.refusal(auth)).toBe(401);
});

it("isolates equal client ids across two control-plane replicas and broadcasts to both", async () => {
  const f = await fixture(), one = await f.connect(), two = await f.connect(), clientId = randomUUID();
  for (const { ws } of [one, two]) ws.send(JSON.stringify({ t: "open", clientId }));
  await expect.poll(() => f.incoming.length).toBe(2);
  const opens = f.incoming.filter((frame): frame is Extract<CloudV2ControlFrame, { t: "open" }> => frame.t === "open");
  expect(opens[0]!.clientId).not.toBe(opens[1]!.clientId);
  one.ws.send(JSON.stringify({ t: "frame", clientId, frame: { request: "one" } }));
  two.ws.send(JSON.stringify({ t: "frame", clientId, frame: { request: "two" } }));
  await expect.poll(() => f.incoming.length).toBe(4);
  for (const frame of f.incoming) if (frame.t === "frame")
    await f.listener.send({ t: "frame", clientId: frame.clientId, frame: frame.frame });
  await f.listener.send({ t: "frame", clientId: "*", frame: { broadcast: true } });
  await expect.poll(() => one.frames.length + two.frames.length).toBe(4);
  expect(one.frames).toEqual([{ t: "frame", clientId, frame: { request: "one" } }, { t: "frame", clientId: "*", frame: { broadcast: true } }]);
  expect(two.frames).toEqual([{ t: "frame", clientId, frame: { request: "two" } }, { t: "frame", clientId: "*", frame: { broadcast: true } }]);
  one.ws.terminate();
  await expect.poll(() => f.incoming.filter(frame => frame.t === "close").length).toBe(1);
  expect(two.ws.readyState).toBe(WebSocket.OPEN);
});

it("routes Stop acknowledgements to the requesting replica only", async () => {
  const f = await fixture(), one = await f.connect(), two = await f.connect(), id = randomUUID();
  one.ws.send(JSON.stringify({ t: "stop", id }));
  await expect.poll(() => f.incoming.length).toBe(1);
  const stop = f.incoming[0];
  expect(stop?.t).toBe("stop");
  if (stop?.t !== "stop") throw new Error("No Stop request");
  await f.listener.send({ t: "stop-ack", id: stop.id });
  await expect.poll(() => one.frames.length).toBe(1);
  expect(one.frames).toEqual([{ t: "stop-ack", id }]);
  expect(two.frames).toEqual([]);
});

it("bounds connections and failed authentication without parsing untrusted bodies", async () => {
  const f = await fixture({ failedAuthLimit: 3 });
  for (let i = 0; i < 8; i++) await f.connect();
  expect(await f.refusal(token())).toBe(503);
  for (let i = 0; i < 3; i++) expect(await f.refusal("invalid")).toBe(401);
  expect(await f.refusal("invalid")).toBe(429);
  expect(f.incoming).toEqual([]);
});

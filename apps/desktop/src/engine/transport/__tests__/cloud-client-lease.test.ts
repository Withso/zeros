import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudTransport } from "../cloud";
import type { CloudRuntimeClientAdmission } from "../../cloud-runtime-registration";

const admitted = {
  accountUserId: "11111111-1111-4111-8111-111111111111",
  authorityEpoch: 1,
};
const firstToken = `zws_${"A".repeat(43)}`;
const secondToken = `zws_${"B".repeat(43)}`;
const transports: CloudTransport[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const transport of transports.splice(0)) await transport.stop();
  vi.useRealTimers();
});

async function start(
  renewToken: (token: string) => Promise<CloudRuntimeClientAdmission | null>,
  identity:CloudRuntimeClientAdmission=admitted,
  leaseMs = 200,
) {
  const transport = new CloudTransport({
    port: 0,
    token: "image-qualification-token",
    verifyToken: async () => identity,
    renewToken,
    clientAuthorityLeaseMs: leaseMs,
  });
  transports.push(transport);
  transport.onMessage(() => {});
  await transport.start();
  return transport;
}
async function connect(transport: CloudTransport, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${transport.boundPort}/ws`, {
    headers: { "x-zeros-cloud-token": token },
  });
  sockets.push(socket);
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      id: "lease-connect",
      timestamp: Date.now(),
      type: "CONNECTED",
      source: "browser",
      capabilities: [],
    }),
  );
  return socket;
}

describe("cloud engine client authority leases", () => {
  it("expires at 10s when a renewal started at 5s takes 7s, without overlapping or accepting its late success", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const renew = vi.fn(async () => { await new Promise<void>(resolve => setTimeout(resolve, 7_000)); return admitted; });
    const transport = await start(renew, admitted, 10_000), socket = await connect(transport, firstToken);
    const closed = once(socket, "close");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).toHaveBeenCalledOnce(); expect(socket.readyState).toBe(WebSocket.OPEN);
    await vi.advanceTimersByTimeAsync(5_000);
    const [code, reason] = await closed;
    expect(code).toBe(1008); expect(reason.toString()).toBe("client authority expired");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(renew).toHaveBeenCalledOnce(); expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
  it("keeps a transient renewal failure only until the last confirmed lease expires", async () => {
    const renew = vi.fn(async () => { throw Object.assign(new Error("private upstream error"), { code: "cloud_client_authority_transient", status: 503 }); });
    const transport = await start(renew), socket = await connect(transport, firstToken);
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce(), { interval: 5 });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const [code, reason] = await once(socket, "close");
    expect(code).toBe(1008); expect(reason.toString()).toBe("client authority expired");
    expect(renew).toHaveBeenCalledTimes(3);
  });
  it("retries a typed transient within the confirmed deadline and keeps a recovered socket open", async () => {
    const renew = vi.fn(async () => admitted).mockRejectedValueOnce(
      Object.assign(new Error("private upstream error"), { code: "cloud_client_authority_transient", status: 503 }));
    const transport = await start(renew), socket = await connect(transport, firstToken);
    await vi.waitFor(() => expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2), { interval: 5, timeout: 350 });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
  it("does not retry an unclassified renewal failure", async () => {
    const renew = vi.fn(async () => { throw new Error("private unknown failure"); });
    const transport = await start(renew), socket = await connect(transport, firstToken);
    const [code, reason] = await once(socket, "close");
    expect(code).toBe(1008); expect(reason.toString()).toBe("client authority unavailable");
    expect(renew).toHaveBeenCalledOnce();
  });
  it("cannot revive an expired socket with a late successful renewal", async () => {
    let resolve!: (value: CloudRuntimeClientAdmission) => void;
    const held = new Promise<CloudRuntimeClientAdmission>(yes => { resolve = yes; });
    const renew = vi.fn(() => held), transport = await start(renew), socket = await connect(transport, firstToken);
    const [code, reason] = await once(socket, "close");
    expect(code).toBe(1008); expect(reason.toString()).toBe("client authority expired");
    resolve(admitted); await new Promise<void>(done => setImmediate(done));
    expect(socket.readyState).toBe(WebSocket.CLOSED); expect(renew).toHaveBeenCalledOnce();
  });
  it("closes an explicit rejected renewal immediately with the revoked category", async () => {
    const transport = await start(async () => { throw Object.assign(new Error("private"), { status: 403 }); });
    const socket = await connect(transport, firstToken), [code, reason] = await once(socket, "close");
    expect(code).toBe(1008); expect(reason.toString()).toBe("client authority revoked");
  });
  it("never retries an explicit denial even if it also carries a transient marker", async () => {
    const renew = vi.fn(async () => { throw Object.assign(new Error("private"), { status: 403, code: "cloud_client_authority_transient" }); });
    const transport = await start(renew), socket = await connect(transport, firstToken);
    const [code, reason] = await once(socket, "close");
    expect(code).toBe(1008); expect(reason.toString()).toBe("client authority revoked");
    expect(renew).toHaveBeenCalledOnce();
  });
  it("closes one revoked device while renewing another device independently", async () => {
    let revoked = false;
    const renew = vi.fn(async (token: string) =>
      token === firstToken && revoked ? null : admitted,
    );
    const transport = await start(renew);
    const a = await connect(transport, firstToken);
    const b = await connect(transport, secondToken);
    revoked = true;
    expect((await once(a, "close"))[0]).toBe(1008);
    await vi.waitFor(() => expect(renew).toHaveBeenCalledWith(secondToken));
    expect(b.readyState).toBe(WebSocket.OPEN);
  });

  it("expires a connection even when renewal never returns", async () => {
    const renew = vi.fn(() => new Promise<null>(() => {}));
    const transport = await start(renew);
    const socket = await connect(transport, firstToken);
    expect((await once(socket, "close"))[0]).toBe(1008);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it("rejects a successful renewal for another account or authority epoch", async () => {
    const transport = await start(async () => ({
      ...admitted,
      authorityEpoch: 2,
    }));
    const socket = await connect(transport, firstToken);
    expect((await once(socket, "close"))[0]).toBe(1008);
  });

  it("passes actor authority to the handler and closes a role-changing renewal",async()=>{
    const actor={sessionId:"22222222-2222-4222-8222-222222222222",deviceId:"33333333-3333-4333-8333-333333333333",role:"viewer" as const,fingerprint:"a".repeat(64)};
    const identity={...admitted,actor};
    const transport=await start(async()=>({...identity,actor:{...actor,role:"developer"}}),identity);
    const connected=vi.fn();transport.onConnect(connected);
    const socket=await connect(transport,`zwa_${"C".repeat(43)}`);
    expect(connected.mock.calls[0]?.[0].cloudActor).toEqual(actor);
    expect((await once(socket,"close"))[0]).toBe(1008);
  });
});

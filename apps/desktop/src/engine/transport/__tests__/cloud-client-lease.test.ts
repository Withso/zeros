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
});

async function start(
  renewToken: (token: string) => Promise<CloudRuntimeClientAdmission | null>,
  identity:CloudRuntimeClientAdmission=admitted,
) {
  const transport = new CloudTransport({
    port: 0,
    token: "image-qualification-token",
    verifyToken: async () => identity,
    renewToken,
    clientAuthorityLeaseMs: 200,
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

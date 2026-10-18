import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createContractMock, type ContractMock } from "../../test/contract-mock";
import type { Capabilities, ConnectResponse } from "../generated/rest";
import { CloudRestClient } from "../rest-client";
import {
  connectRuntime,
  type RuntimeConnection,
  type RuntimeSocketFactory,
} from "../runtime-session";
import { CLIENT_SESSION, DEVICE, DEVICE_SESSION, ORGANIZATION, TOKEN, WORKSPACE } from "./fixtures";

let mock: ContractMock | undefined;
let openConnection: RuntimeConnection | undefined;

afterEach(async () => {
  openConnection?.close();
  openConnection = undefined;
  await mock?.close();
  mock = undefined;
});

const createSocket: RuntimeSocketFactory = (url, protocols, handlers) => {
  const socket = new WebSocket(url.replace(/^wss:/, "ws:"), [...protocols]);
  socket.on("open", () => handlers.open(socket.protocol));
  socket.on("message", (data, isBinary) => {
    if (!isBinary) handlers.message(String(data));
  });
  socket.on("close", (code, reason) => handlers.close(code, reason.toString()));
  socket.on("error", () => undefined);
  return {
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  };
};

/** Connects through the mock's runtime/connect route and the runtime session. */
async function connectMock(): Promise<{ connection: RuntimeConnection; capabilities: Capabilities }> {
  const m = await createContractMock();
  mock = m;
  const rest = new CloudRestClient({
    baseUrl: m.restUrl,
    getAccessToken: () => TOKEN,
    getDeviceProof: () => ({
      deviceId: DEVICE,
      keyVersion: 1,
      timestampMs: 1760000000000,
      nonce: "A".repeat(32),
      signature: "A".repeat(86),
    }),
  });
  const { body } = await rest.invoke<ConnectResponse>("connectCloudWorkspaceRuntime", {
    pathParams: { organization: ORGANIZATION, workspace: WORKSPACE },
    body: { deviceSessionId: DEVICE_SESSION, clientSessionId: CLIENT_SESSION, routes: ["direct", "relay"] },
    deviceProof: true,
  });
  const result = await connectRuntime(body, {
    clientSessionId: CLIENT_SESSION,
    createSocket,
    signProof: async () => "A".repeat(86),
  });
  if (result.kind !== "connected") throw new Error(`expected a connection, got ${result.kind}`);
  openConnection = result.connection;
  return { connection: result.connection, capabilities: body.capabilities };
}

describe("runtime session against the contract mock", () => {
  it("connects through the direct route and receives the mock's session", async () => {
    const { connection } = await connectMock();
    expect(connection.route).toBe("direct");
    expect(connection.sessionId).toBe("66666666-6666-4666-8666-666666666666");
    expect(connection.scopes).toEqual(["ws:read", "ws:edit"]);
  });

  it("renews in band and resolves with the new expiry", async () => {
    const { connection, capabilities } = await connectMock();
    await expect(connection.renew(capabilities)).resolves.toBe(1760000000300);
    expect(connection.expiresAtMs).toBe(1760000000300);
  });

  it("closes with 4400 when an unexpected handshake frame arrives after auth.ok", async () => {
    const { connection } = await connectMock();
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      connection.onClose((code, reason) => resolve({ code, reason }));
    });
    connection.send('{"t":"auth.bogus","d":{}}');
    await expect(closed).resolves.toEqual({ code: 4400, reason: "unexpected_handshake_frame" });
  });
});

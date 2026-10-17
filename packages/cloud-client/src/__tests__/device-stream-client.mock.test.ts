import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createContractMock, type ContractMock } from "../../test/contract-mock";
import {
  DeviceStreamClient,
  type DeviceStreamEvent,
} from "../device-stream-client";
import { CloudRestClient } from "../rest-client";
import { DEVICE, TOKEN, WORKSPACE, WORKSPACE_DOCUMENT } from "./fixtures";

let mock: ContractMock | undefined;
let client: DeviceStreamClient | undefined;

afterEach(async () => {
  client?.stop();
  client = undefined;
  await mock?.close();
  mock = undefined;
});

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the device stream");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("DeviceStreamClient against the contract mock", () => {
  it("connects, receives a pushed event and resumes after a restart", async () => {
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
    const events: DeviceStreamEvent[] = [];
    const ofType = <T extends DeviceStreamEvent["type"]>(type: T) =>
      events.filter((event): event is Extract<DeviceStreamEvent, { type: T }> => event.type === type);
    const c = new DeviceStreamClient({
      openSession: async (held) => {
        const { body } = await rest.invoke<{
          deviceSessionId: string;
          stream: { url: string; ticket: string };
        }>("createDeviceSession", {
          body: {
            deviceId: DEVICE,
            ...(held ? { deviceSessionId: held } : {}),
            client: { platform: "macos", appVersion: "1.2.3", contract: { min: 1, max: 1 } },
          },
          deviceProof: true,
        });
        return { deviceSessionId: body.deviceSessionId, url: body.stream.url, ticket: body.stream.ticket };
      },
      createSocket: (url, handlers) => {
        const socket = new WebSocket(url.replace(/^wss:/, "ws:"));
        socket.on("open", () => handlers.open());
        socket.on("message", (data, isBinary) => {
          if (!isBinary) handlers.message(String(data));
        });
        socket.on("close", (code, reason) => handlers.close(code, reason.toString()));
        socket.on("error", () => undefined);
        return {
          send: (text) => socket.send(text),
          close: (code, reason) => socket.close(code, reason),
        };
      },
      resumeBase: () => ({ catalogVersion: 10, workspaces: { [WORKSPACE]: 42 } }),
      onEvent: (event) => events.push(event),
      random: () => 0,
    });
    client = c;

    c.start();
    await waitFor(() => ofType("ready").length === 1 && ofType("snapshot_required").length === 1);
    expect(ofType("ready")[0]!.ready.resumed).toBe(false);

    m.pushStreamFrame({
      t: "catalog.changed",
      c: "c-2",
      d: {
        workspaceId: WORKSPACE,
        version: 42,
        catalogVersion: 10,
        op: "upsert",
        workspace: { ...WORKSPACE_DOCUMENT, version: 42 },
      },
    });
    await waitFor(() => ofType("frame").length === 1);

    m.closeStreams(1012, "restart");
    await waitFor(() => ofType("ready").length === 2);
    expect(ofType("ready")[1]!.ready.resumed).toBe(true);
    expect(ofType("snapshot_required")).toHaveLength(1);
  });
});

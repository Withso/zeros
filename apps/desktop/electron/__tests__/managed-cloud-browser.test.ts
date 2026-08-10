import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import { connectManagedCloudBrowser } from "../shared-chrome-browser";

describe("managed cloud browser transport", () => {
  it("uses the encrypted bearer token for discovery and WebSocket authorization", async () => {
    const fetchRequest = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          webSocketDebuggerUrl:
            "wss://cloud.example.test/devtools/browser/session?providerSession=opaque",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const socket = new FakeWebSocket();
    const createWebSocket = vi.fn(() => {
      queueMicrotask(() => socket.emit("open"));
      return socket as unknown as WebSocket;
    });

    const connectionPromise = connectManagedCloudBrowser(
      "https://cloud.example.test/cdp",
      "encrypted-vault-token",
      { fetch: fetchRequest, createWebSocket },
    );
    const connection = await connectionPromise;

    expect(fetchRequest).toHaveBeenCalledWith(
      "https://cloud.example.test/cdp/json/version",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer encrypted-vault-token",
        }),
      }),
    );
    expect(createWebSocket).toHaveBeenCalledWith(
      "wss://cloud.example.test/devtools/browser/session?providerSession=opaque",
      expect.objectContaining({
        headers: { authorization: "Bearer encrypted-vault-token" },
      }),
    );

    await connection.close();
  });

  it("never forwards the bearer token to a cross-host or insecure advertised socket", async () => {
    const createWebSocket = vi.fn();
    const crossHostFetch = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        webSocketDebuggerUrl: "wss://attacker.example.test/devtools/browser/session",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(connectManagedCloudBrowser(
      "https://cloud.example.test/cdp",
      "vault-token",
      { fetch: crossHostFetch, createWebSocket },
    )).rejects.toThrow(/same host/i);
    expect(createWebSocket).not.toHaveBeenCalled();

    const insecureFetch = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        webSocketDebuggerUrl: "ws://cloud.example.test/devtools/browser/session",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(connectManagedCloudBrowser(
      "https://cloud.example.test/cdp",
      "vault-token",
      { fetch: insecureFetch, createWebSocket },
    )).rejects.toThrow(/secure WSS/i);
    expect(createWebSocket).not.toHaveBeenCalled();
  });
});

class FakeWebSocket extends EventEmitter {
  readonly readyState = 1;

  close(): void {
    this.emit("close");
  }

  send(): void {}
}

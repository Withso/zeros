import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuthAccessToken } from "../../../features/auth/auth-token";
import {
  invalidateEnginePort,
  invalidateEngineToken,
  RuntimeClient,
} from "../ws-client";

class LocalSocket {
  static OPEN = 1;
  static instances: LocalSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    LocalSocket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  open() {
    this.readyState = LocalSocket.OPEN;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  answer(message: Record<string, unknown>) {
    this.onmessage?.({
      data: JSON.stringify({
        id: `reply-${message.id}`,
        type: "WORKSPACE_RESPONSE",
        source: "engine",
        timestamp: Date.now(),
        requestId: message.id,
        op: message.op,
        result: { ok: true },
      }),
    });
  }
}

let client: RuntimeClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", LocalSocket);
  vi.stubGlobal("window", {
    __ZEROS_PORT__: 29920,
    __ZEROS_WS_TOKEN__: "local-upgrade-fixture",
    setTimeout,
    clearTimeout,
  });
  invalidateEnginePort();
  invalidateEngineToken();
  LocalSocket.instances = [];
  client = new RuntimeClient();
});
afterEach(() => {
  client.dispose();
  setAuthAccessToken(null);
  invalidateEnginePort();
  invalidateEngineToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("local sidecar transport after the cloud handshake changes", () => {
  it("sends CONNECTED before synchronous listeners and becomes ready without a probe", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    setAuthAccessToken("local-account-fixture");
    let listenerRequest: Promise<unknown> | undefined;
    client.onStatusChange((status) => {
      if (status === "connected") {
        expect(client.extensionConnected).toBe(true);
        listenerRequest = client.request({
          type: "WORKSPACE_REQUEST",
          op: "git.status",
          params: { cwd: "/local/personal" },
        });
      }
    });
    await client.connect();
    const socket = LocalSocket.instances[0];
    socket.open();

    expect(client.status).toBe("connected");
    expect(socket.sent).toEqual([
      expect.objectContaining({
        type: "CONNECTED",
        authToken: "local-account-fixture",
      }),
      expect.objectContaining({ type: "WORKSPACE_REQUEST", op: "git.status" }),
    ]);
    socket.answer(socket.sent[1]);
    await listenerRequest;
    socket.close();
    expect(warning).not.toHaveBeenCalled();
  });

  it("flushes the local queue in order without the cloud 16-request limit", async () => {
    await client.connect();
    const requests = Array.from({ length: 40 }, (_, index) =>
      client.request({
        type: "WORKSPACE_REQUEST",
        op: "file.read",
        params: { cwd: "/local/organization", path: `${index}.ts` },
      }),
    );
    const socket = LocalSocket.instances[0];
    expect(socket.sent).toEqual([]);
    socket.open();

    expect(socket.sent).toHaveLength(41);
    expect(socket.sent[0].type).toBe("CONNECTED");
    expect(socket.sent.slice(1).map((message) => message.params)).toEqual(
      Array.from({ length: 40 }, (_, index) => ({
        cwd: "/local/organization",
        path: `${index}.ts`,
      })),
    );
    for (const message of socket.sent.slice(1)) socket.answer(message);
    await Promise.all(requests);
  });

  it("rejects accepted requests on disconnect and flushes only unsent work on reconnect", async () => {
    await client.connect();
    const first = LocalSocket.instances[0];
    first.open();
    const sent = client.request({
      type: "WORKSPACE_REQUEST",
      op: "git.pull",
      params: { workspaceId: "ws_local" },
    });
    const disconnected = expect(sent).rejects.toThrow("engine disconnected");
    first.close();
    await disconnected;
    const queued = client.request({
      type: "WORKSPACE_REQUEST",
      op: "git.status",
      params: { workspaceId: "ws_local" },
    });
    await client.connect();
    const replacement = LocalSocket.instances[1];
    replacement.open();

    expect(replacement.sent.map((message) => message.type)).toEqual([
      "CONNECTED",
      "WORKSPACE_REQUEST",
    ]);
    expect(replacement.sent[1].op).toBe("git.status");
    replacement.answer(replacement.sent[1]);
    await queued;
  });

  it("keeps cancellation and deadline semantics for unsent local requests", async () => {
    await client.connect();
    const controller = new AbortController();
    const cancelled = client.request(
      { type: "WORKSPACE_REQUEST", op: "file.read", params: {} },
      { signal: controller.signal },
    );
    const cancellation = expect(cancelled).rejects.toMatchObject({
      code: "REQUEST_ABORTED",
    });
    controller.abort();
    await cancellation;
    const expired = client.request(
      { type: "WORKSPACE_REQUEST", op: "git.status", params: {} },
      10,
    );
    const expiration = expect(expired).rejects.toThrow(/timeout/i);
    let settled = false;
    void expired
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    // Queue deadlines use the existing reconnect grace, independently of the
    // response timeout that starts only after the request reaches the wire.
    await vi.advanceTimersByTimeAsync(11);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(19_990);
    LocalSocket.instances[0].open();
    await expiration;

    expect(
      LocalSocket.instances[0].sent.map((message) => message.type),
    ).toEqual(["CONNECTED"]);
  });
});

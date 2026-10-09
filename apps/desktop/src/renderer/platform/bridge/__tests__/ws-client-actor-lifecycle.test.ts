import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wireCloudRuntimeRetirement } from "../active-bridge";
import { RuntimeClient } from "../ws-client";

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    Socket.instances.push(this);
  }
  send(value: string) {
    const message = JSON.parse(value);
    if (message.type === "WORKSPACE_REQUEST" && message.op === "workspace.list")
      this.onmessage?.({ data: JSON.stringify({ id: randomUUID(), source: "engine", timestamp: Date.now(),
        type: "WORKSPACE_RESPONSE", op: message.op, requestId: message.id, result: { workspaces: [] } }) });
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}
const now = 1_800_000_000_000;
let runtimeIds: Record<number, string> = {};
function target(n = 1) {
  return {
    kind: "cloud" as const,
    channel: "control-plane-websocket" as const,
    runtimeId: runtimeIds[n] ?? (runtimeIds[n] = randomUUID()),
    organizationId: "22222222-2222-4222-8222-222222222222",
    workspaceId: `${n}3333333-3333-4333-8333-333333333333`,
    generation: 1,
    authorityEpoch: 1,
    engineInstanceId: `${n}4444444-4444-4444-8444-444444444444`,
    connectionSequence: 1,
    url: "wss://api.zeros.test/v1/cloud-workspaces/bridge",
    cloudToken: `zwa_${String(n).repeat(43)}`,
    expiresAt: now + 120_000,
  };
}
let client: RuntimeClient | undefined;
function setup() {
  runtimeIds = {};
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("VITE_CONTROL_PLANE_URL", "https://api.zeros.test");
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("window", globalThis);
  Socket.instances = [];
}
afterEach(() => {
  client?.dispose();
  client = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("actor runtime socket lifecycle", () => {
  it("latches a forwarded native revocation without issuing another admission", async () => {
    setup(); const refresh = vi.fn(async current => ({ ...current, connectionSequence: current.connectionSequence + 1 }));
    client = new RuntimeClient(target(), { refreshCloudConnectionTarget: refresh });
    await client.connect(); const socket = Socket.instances[0]; socket.open(); await Promise.resolve();
    socket.close(); socket.onclose?.({ code: 1008, reason: "client authority revoked" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).not.toHaveBeenCalled(); expect(client.lastRejection).toMatchObject({ reason: "cloud-revoked", code: "cloud_workspace_access_revoked" });
    expect(client.executionIdentity.kind).toBe("cloud");
    await client.forceReconnect();
    expect(refresh).not.toHaveBeenCalled(); expect(Socket.instances).toHaveLength(1);
  });
  it("bounds repeated abnormal upgrade failures even when minting each admission succeeds", async () => {
    setup(); const refresh = vi.fn(async current => ({ ...current, connectionSequence: current.connectionSequence + 1, expiresAt: Date.now() + 120_000 }));
    client = new RuntimeClient(target(), { refreshCloudConnectionTarget: refresh }); await client.connect();
    for (let i = 0; i < 8; i++) { const socket = Socket.instances.at(-1)!; socket.close(); socket.onclose?.({ code: 1006, reason: "" }); await vi.advanceTimersByTimeAsync(15_000); }
    expect(Socket.instances.length).toBeLessThanOrEqual(5); expect(client.lastRejection).toMatchObject({ reason: "cloud-transient" });
  });
  it.each(["cloud_workspace_access_superseded", "cloud_actor_admission_rejected", "cloud_workspace_client_update_required", "cloud_workspace_v2_required"])("latches typed %s refresh failures instead of reconnecting forever", async code => {
    setup(); const refresh = vi.fn(async () => { throw Object.assign(new Error("private-native-detail"), { code, status: 409 }); });
    client = new RuntimeClient(target(), { refreshCloudConnectionTarget: refresh }); vi.setSystemTime(now + 120_001);
    await client.connect(); await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledOnce(); expect(Socket.instances).toHaveLength(0);
    expect(client.lastRejection).toMatchObject({ code }); expect(client.lastRejection?.message).not.toContain("private-native-detail");
    expect(client.executionIdentity.kind).toBe("cloud");
  });
  it("bounds transient refresh failures and keeps their category", async () => {
    setup(); const refresh = vi.fn(async () => { throw Object.assign(new Error("offline"), { code: "cloud_actor_runtime_unavailable", status: 503 }); });
    client = new RuntimeClient(target(), { refreshCloudConnectionTarget: refresh }); vi.setSystemTime(now + 120_001);
    await client.connect(); await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(5); expect(client.lastRejection).toMatchObject({ reason: "cloud-transient" });
  });
  it("bounds timeout logs and classifies arbitrary request operations without retaining their content", async () => {
    setup();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    client = new RuntimeClient(target());
    try {
      await client.connect(); Socket.instances[0].open(); await Promise.resolve();
      for (let index = 0; index < 12; index++) {
        const failed = expect(client.request({ type: "WORKSPACE_REQUEST", op: "private-operation", params: { private: "private-content" } }, 100)).rejects.toThrow(/timeout/);
        await vi.advanceTimersByTimeAsync(100);
        await failed;
      }
      const lines = log.mock.calls.flat().filter(line => String(line).includes('"event":"request_failed"'));
      expect(lines).toHaveLength(8);
      expect(lines[0]).toContain('"class":"timeout"');
      expect(lines[0]).toContain('"operation":"other"');
      expect(lines.join(" ")).not.toMatch(/private-operation|private-content/);
    } finally { log.mockRestore(); }
  });
  it("logs closed socket/request/reconnect diagnostics with exact workspace identity and no bearer or URL", async () => {
    setup();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    client = new RuntimeClient(target(), { refreshCloudConnectionTarget: async current => ({ ...current, connectionSequence: current.connectionSequence + 1 }) });
    try {
      await client.connect(); Socket.instances[0].open(); await Promise.resolve();
      const request = client.request({ type: "WORKSPACE_REQUEST", op: "git.status", params: { private: "private-params" } }, 100);
      const failed = expect(request).rejects.toThrow(/disconnected/);
      Socket.instances[0].close(); Socket.instances[0].onclose?.({ code: 1008, reason: "private-close-text" });
      await failed;
      const lines = log.mock.calls.flat().join(" ");
      expect(lines).toContain(target().workspaceId);
      expect(lines).toContain('"generation":1');
      expect(lines).toContain('"code":1008');
      expect(lines).toContain('"class":"other"');
      expect(lines).toContain('"operation":"git.status"');
      expect(lines).toContain('"delayMs":1000');
      for (const privateText of ["private-close-text", "private-params", target().cloudToken, target().url]) expect(lines).not.toContain(privateText);
    } finally { log.mockRestore(); }
  });
  it.each([true, false])(
    "refuses a delayed descriptor after retirement (previously installed=%s)",
    async (installed) => {
      setup();
      client = new RuntimeClient(installed ? target() : { kind: "local" });
      client.retireCloudRuntime(target().runtimeId);
      await expect(client.setConnectionTarget(target())).rejects.toThrow(
        /retired/,
      );
      expect(() => new RuntimeClient(target())).toThrow(/retired/);
      expect(client.executionIdentity.kind).toBe("local");
    },
  );
  it("consumes the native payload directly and unsubscribes the exact listener", async () => {
    setup();
    client = new RuntimeClient(target());
    await client.connect();
    const socket = Socket.instances[0];
    socket.open();
    let receive!: (event: unknown) => void;
    const off = vi.fn();
    vi.stubGlobal("window", {
      __ZEROS_NATIVE__: {
        on: (name: string, handler: (event: unknown) => void) => {
          expect(name).toBe("cloud-workspace-access-retired");
          receive = handler;
          return off;
        },
      },
    });
    const stop = await wireCloudRuntimeRetirement(client);
    receive({ runtimeIds: [target().runtimeId] });
    expect(socket.readyState).toBe(Socket.CLOSED);
    stop();
    expect(off).toHaveBeenCalledOnce();
  });
  it("synchronously retires only the exact native handle and ignores queued old events", async () => {
    setup();
    client = new RuntimeClient(target());
    await client.connect();
    const socket = Socket.instances[0];
    socket.open();
    const seen = vi.fn();
    client.on("DB_CHANGED", seen);
    client.retireCloudRuntime("unrelated");
    expect(socket.readyState).toBe(Socket.OPEN);
    client.retireCloudRuntime(target().runtimeId);
    expect(socket.readyState).toBe(Socket.CLOSED);
    expect(client.executionIdentity.kind).toBe("local");
    socket.onmessage?.({
      data: JSON.stringify({
        id: "stale-account",
        source: "engine",
        timestamp: now,
        type: "DB_CHANGED",
        kinds: ["chats"],
      }),
    });
    expect(seen).not.toHaveBeenCalled();
  });
  it("does not extend an unused actor admission past its deadline", async () => {
    setup();
    client = new RuntimeClient(target());
    await client.connect();
    const socket = Socket.instances[0];
    await vi.advanceTimersByTimeAsync(120_001);
    socket.open();
    expect(socket.readyState).toBe(Socket.CLOSED);
  });
  it("uses a fresh grant after an admitted stream disconnects", async () => {
    setup();
    const refresh = vi.fn(async () => ({
      ...target(),
      connectionSequence: 2,
      cloudToken: `zwa_${"e".repeat(43)}`,
    }));
    client = new RuntimeClient(target(), {
      refreshCloudConnectionTarget: refresh,
    });
    await client.connect();
    const socket = Socket.instances[0];
    socket.open();
    socket.close();
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(Socket.instances[1].protocols).not.toEqual(socket.protocols);
  });
  it("retries an initial upgrade failure instead of waiting for grant expiry", async () => {
    setup();
    const refresh = vi.fn(async () => ({ ...target(), connectionSequence: 2 }));
    client = new RuntimeClient(target(), {
      refreshCloudConnectionTarget: refresh,
    });
    await client.connect();
    Socket.instances[0].close();
    Socket.instances[0].onclose?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(Socket.instances.length).toBeGreaterThan(1);
  });
  it("ignores queued events from a retired workspace socket", async () => {
    setup();
    client = new RuntimeClient(target());
    const seen = vi.fn();
    client.on("DB_CHANGED", seen);
    await client.connect();
    const stale = Socket.instances[0];
    stale.open();
    await client.setConnectionTarget(target(2));
    Socket.instances[1].open();
    stale.onmessage?.({
      data: JSON.stringify({
        id: "old-workspace-event",
        source: "engine",
        timestamp: now,
        type: "DB_CHANGED",
        kinds: ["chats"],
      }),
    });
    expect(seen).not.toHaveBeenCalled();
  });
  it("keeps a healthy admitted socket open past one-use upgrade expiry", async () => {
    setup();
    client = new RuntimeClient(target());
    await client.connect();
    const socket = Socket.instances[0];
    socket.open();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(socket.readyState).toBe(Socket.OPEN);
  });
});

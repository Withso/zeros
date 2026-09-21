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
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    Socket.instances.push(this);
  }
  send(_value: string) {}
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

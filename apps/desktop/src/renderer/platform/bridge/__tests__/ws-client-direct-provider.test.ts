import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, parseRuntimeConnectionTarget, runtimeExecutionIdentity, runtimeExecutionKey } from "../ws-client";
import type { CloudAgentBootConversation } from "@zeros/protocol/cloud-agent-bootstrap";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = 1_800_000_000_000;
const scope = { organizationId: uuid(1), workspaceId: uuid(2), generation: 2, engineInstanceId: uuid(3),
  bootId: uuid(4), writerEpoch: uuid(5), fundingOwnerUserId: uuid(6), fundingOwnerEpoch: 3 };
const binding: CloudAgentBootConversation = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
  authorityEpoch: 7, cacheRevision: 1, desiredCacheRevision: 1,
  initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) as CloudAgentBootConversation["initialAdoptions"] };
const target = () => ({ ...scope, kind: "cloud" as const, channel: "direct-provider-websocket" as const,
  runtimeId: uuid(7), authorityEpoch: 7, connectionSequence: 1, remotePort: 24193,
  url: "wss://workspace-24193.on.boat.dev/ws", cloudToken: `zwa_${"a".repeat(43)}`, expiresAt: now + 120_000,
  bootScope: { ...scope } });
// Only public target fields are returned; boot scope is never flattened into
// the connection descriptor supplied by the broker.
const descriptor = () => { const { bootId: _boot, writerEpoch: _writer, fundingOwnerUserId: _owner, fundingOwnerEpoch: _epoch, ...value } = target(); return value; };
class Socket {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; static instances: Socket[] = [];
  readyState = 0; sent: Record<string, unknown>[] = []; closeCount = 0;
  onopen: (() => void) | null = null; onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
  constructor(readonly url: string, readonly protocols?: string[]) { Socket.instances.push(this); }
  send(value: string) { const message = JSON.parse(value); this.sent.push(message);
    if (message.type === "WORKSPACE_REQUEST" && message.op === "workspace.list") this.receive({ type: "WORKSPACE_RESPONSE", op: message.op, requestId: message.id, result: { workspaces: [] } }); }
  receive(value: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify({ id: uuid(99), source: "engine", timestamp: now, ...value }) }); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.closeCount++; this.readyState = 3; }
}
let client: RuntimeClient | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal("window", globalThis); vi.stubGlobal("WebSocket", Socket);
  vi.stubEnv("VITE_CONTROL_PLANE_URL", "https://api.zeros.test"); Socket.instances = []; });
afterEach(() => { client?.dispose(); client = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
async function open(value = descriptor()) { client = new RuntimeClient(value); await client.connect(); const socket = Socket.instances[0]!; socket.open(); await Promise.resolve(); return socket; }

describe("negotiated direct cloud connection", () => {
  it("accepts and freezes the public Boat target and exact nested boot scope", () => {
    const parsed = parseRuntimeConnectionTarget(descriptor(), now);
    expect(parsed).toEqual(descriptor()); expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.kind === "cloud" && "bootScope" in parsed && Object.isFrozen(parsed.bootScope)).toBe(true);
  });
  it.each(["wss://provider.test/ws", "wss://workspace-24193.on.boat.dev/ws?token=private", "ws://workspace-24193.on.boat.dev/ws", "wss://workspace-22222.on.boat.dev/ws"])("refuses unsafe direct URL %s", url => {
    expect(() => parseRuntimeConnectionTarget({ ...descriptor(), url }, now)).toThrow();
  });
  it("binds execution state to the exact boot and writer, preserving legacy keys", () => {
    const first = runtimeExecutionKey(runtimeExecutionIdentity(descriptor()));
    const next = runtimeExecutionKey(runtimeExecutionIdentity({ ...descriptor(), bootScope: { ...scope, writerEpoch: uuid(8) } }));
    expect(first).not.toBe(next);
    expect(runtimeExecutionKey(runtimeExecutionIdentity({ kind: "local" }))).toBe("local:sidecar");
  });
  it("waits for activated exact boot and actor confirmation before publishing connected or flushing work", async () => {
    const socket = await open();
    const request = client!.request({ type: "WORKSPACE_REQUEST", op: "file.list", params: {} });
    void request.catch(() => {});
    expect(client!.status).toBe("connecting"); expect(client!.activatedCloudAgentBootBinding).toBeNull();
    expect(socket.sent.some(message => message.op === "file.list")).toBe(false);
    socket.receive({ type: "ENGINE_READY", capabilities: ["cloud.localCommands.v1"], cloudLocalCommands: binding });
    await Promise.resolve();
    expect(client!.status).toBe("connected"); expect(client!.activatedCloudAgentBootBinding).toEqual(binding);
    expect(socket.sent.filter(message => message.op === "file.list")).toHaveLength(1);
    expect(socket.protocols?.join(",")).not.toContain(descriptor().cloudToken);
    expect(new URL(socket.url).search).toBe("");
  });
  it.each(["generation", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch", "authorityEpoch"] as const)("rejects ENGINE_READY with a foreign %s", async field => {
    const socket = await open(); const foreign = { ...binding, [field]: typeof binding[field] === "number" ? Number(binding[field]) + 1 : uuid(90) };
    socket.receive({ type: "ENGINE_READY", capabilities: ["cloud.localCommands.v1"], cloudLocalCommands: foreign });
    await Promise.resolve(); expect(client!.status).toBe("disconnected"); expect(client!.lastRejection?.code).toBe("cloud_workspace_access_superseded");
    expect(client!.activatedCloudAgentBootBinding).toBeNull();
  });
  it("keeps unavailable/malformed negotiation closed instead of selecting legacy", async () => {
    const socket = await open(); socket.receive({ type: "ENGINE_READY", capabilities: [], cloudLocalCommands: binding });
    await Promise.resolve(); expect(client!.status).toBe("disconnected"); expect(client!.lastRejection?.code).toBe("cloud_workspace_client_update_required");
  });
  it("uses a fresh same-boot relay grant after an upgrade failure and never copies work onto it", async () => {
    const first = descriptor(); const { remotePort: _port, ...relay } = first; const refresh = vi.fn(async () => ({ ...relay, channel: "control-plane-websocket" as const,
      url: "wss://api.zeros.test/v1/cloud-workspaces/bridge", cloudToken: `zwa_${"b".repeat(43)}`, connectionSequence: 2 }));
    client = new RuntimeClient(first, { refreshCloudConnectionTarget: refresh }); await client.connect();
    const socket = Socket.instances[0]!; socket.close(); socket.onclose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(1_000); expect(refresh).toHaveBeenCalledOnce();
    expect(Socket.instances[1]?.url).toBe("wss://api.zeros.test/v1/cloud-workspaces/bridge");
    expect(Socket.instances[1]?.protocols).not.toEqual(socket.protocols);
  });
  it.each([false, true])("falls back within five seconds when direct readiness stalls (socket open: %s)", async transportOpen => {
    const first = descriptor(); const { remotePort: _port, ...relay } = first;
    const refresh = vi.fn(async () => ({ ...relay, channel: "control-plane-websocket" as const,
      url: "wss://api.zeros.test/v1/cloud-workspaces/bridge", cloudToken: `zwa_${"b".repeat(43)}`, connectionSequence: 2 }));
    client = new RuntimeClient(first, { refreshCloudConnectionTarget: refresh }); await client.connect();
    const direct = Socket.instances[0]!;
    if (transportOpen) { direct.open(); await Promise.resolve(); }
    await vi.advanceTimersByTimeAsync(4_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(first);
    expect(direct.closeCount).toBe(1);
    const fallback = Socket.instances[1]!;
    expect(fallback.url).toBe("wss://api.zeros.test/v1/cloud-workspaces/bridge");
    direct.open(); direct.receive({ type: "ENGINE_READY", capabilities: ["cloud.localCommands.v1"], cloudLocalCommands: binding });
    expect(client!.status).not.toBe("connected");
    fallback.open(); fallback.receive({ type: "ENGINE_READY", capabilities: ["cloud.localCommands.v1"], cloudLocalCommands: binding });
    await Promise.resolve();
    expect(client!.status).toBe("connected");
  });
  it("breaks the exact boot-scoped stream before refreshing and never replays its in-flight work", async () => {
    const first = descriptor(); const { remotePort: _port, ...relay } = first;
    const next = { ...relay, channel: "control-plane-websocket" as const,
      url: "wss://api.zeros.test/v1/cloud-workspaces/bridge", cloudToken: `zwa_${"b".repeat(43)}`, connectionSequence: 2 };
    let deliver!: (value: typeof next) => void;
    const refresh = vi.fn(() => new Promise<typeof next>(resolve => { deliver = resolve; }));
    client = new RuntimeClient(first, { refreshCloudConnectionTarget: refresh });
    await client.connect(); const original = Socket.instances[0]!; original.open();
    original.receive({ type: "ENGINE_READY", capabilities: ["cloud.localCommands.v1"], cloudLocalCommands: binding });
    await Promise.resolve();
    const pending = client.request({ type: "WORKSPACE_REQUEST", op: "file.write", params: { path: "a", content: "one" } });
    void pending.catch(() => {});
    const reconnecting = client.forceReconnect();
    expect(original.closeCount).toBe(1);
    await expect(pending).rejects.toMatchObject({ code: "ENGINE_SWAPPING" });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(first); expect(Socket.instances).toHaveLength(1);
    expect(client.status).not.toBe("connected");
    deliver(next); await reconnecting;
    const successor = Socket.instances[1]!; successor.open();
    successor.receive({ type: "ENGINE_READY", capabilities: ["cloud.localCommands.v1"], cloudLocalCommands: binding });
    await Promise.resolve();
    original.onclose?.({ code: 1008, reason: "client authority revoked" });
    expect(client.status).toBe("connected"); expect(client.lastRejection).toBeNull();
    expect(successor.sent.some(message => message.op === "file.write")).toBe(false);
  });
  it("rejects readiness for the former execution identity and cancels its direct deadline", async () => {
    const refresh = vi.fn(); client = new RuntimeClient(descriptor(), { refreshCloudConnectionTarget: refresh });
    await client.connect(); const original = Socket.instances[0]!;
    const waiting = client.waitUntilReady(); const refused = expect(waiting).rejects.toThrow(/identity changed/);
    await client.setConnectionTarget({ kind: "local" }); await refused;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(refresh).not.toHaveBeenCalled(); expect(original.readyState).toBe(Socket.CLOSED);
  });
  it("preserves explicit break-and-reconnect for legacy cloud targets without an activated boot scope", async () => {
    const { bootScope: _boot, remotePort: _port, ...first } = descriptor();
    const legacy = { ...first, channel: "control-plane-websocket" as const, url: "wss://api.zeros.test/v1/cloud-workspaces/bridge" };
    const refresh = vi.fn(async () => ({ ...legacy, connectionSequence: 2, cloudToken: `zwa_${"b".repeat(43)}` }));
    client = new RuntimeClient(legacy, { refreshCloudConnectionTarget: refresh });
    await client.connect(); const original = Socket.instances[0]!; original.open(); await Promise.resolve();
    const replacing = client.forceReconnect(); await vi.advanceTimersByTimeAsync(0);
    expect(original.closeCount).toBe(1); await replacing;
    expect(client.status).toBe("connecting"); expect(refresh).toHaveBeenCalledOnce();
    const next = Socket.instances[1]!; next.open(); await Promise.resolve();
    expect(client.status).toBe("connected"); expect(client.activatedCloudAgentBootBinding).toBeNull();
  });
  it("latches direct authority denial without a fallback admission", async () => {
    const refresh = vi.fn(); client = new RuntimeClient(descriptor(), { refreshCloudConnectionTarget: refresh }); await client.connect();
    const socket = Socket.instances[0]!; socket.close(); socket.onclose?.({ code: 1008, reason: "client authority revoked" });
    await vi.advanceTimersByTimeAsync(120_000); expect(refresh).not.toHaveBeenCalled(); expect(Socket.instances).toHaveLength(1);
  });
  it("does not let admission expiry retire a successfully authenticated direct stream", async () => {
    const socket = await open(); socket.receive({ type: "ENGINE_READY", capabilities: ["cloud.localCommands.v1"], cloudLocalCommands: binding });
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(120_001);
    expect(socket.readyState).toBe(Socket.OPEN); expect(client!.status).toBe("connected");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentBootConversation } from "@zeros/protocol/cloud-agent-bootstrap";
import type { CloudSdkRuntimeTarget } from "../../../../../shared/cloud-sdk-contract";
import type { RuntimeClient as Client } from "../ws-client";

const state = vi.hoisted(() => ({ epoch: 1, listeners: new Set<() => void>(), open: vi.fn(), refresh: vi.fn(), fallback: vi.fn(),
  proof: vi.fn(), renew: vi.fn(), legacy: vi.fn(), close: vi.fn(async () => true), publish: vi.fn(async (_target: unknown, _connected: boolean) => {}), accept: vi.fn(),
  clients: [] as Client[], document: { status: "ready", generation: { number: 7 }, capabilities: { canRead: true, canWrite: true } } }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({ cloudCatalogGeneration: () => state.epoch,
  cloudWorkspaceDocument: () => state.document, refreshCloudWorkspace: async () => state.document, canReadCloudWorkspace: () => true,
  acceptCloudEngineWorkspace: state.accept, subscribeCloudWorkspaces: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); } }));
vi.mock("../../../state/cloud-workspace-wake", () => ({ wakeCloudWorkspace: vi.fn() }));
vi.mock("../../cloud-sdk-runtime", async importOriginal => ({ ...await importOriginal<typeof import("../../cloud-sdk-runtime")>(),
  openCloudSdkWorkspaceRuntime: state.open, refreshCloudSdkWorkspaceRuntime: state.refresh, fallbackCloudSdkWorkspaceRuntime: state.fallback,
  signCloudSdkRuntimeProof: state.proof, renewCloudSdkRuntimeCapabilities: state.renew }));
vi.mock("../../cloud-workspace-access", () => ({ openCloudWorkspaceRuntime: state.legacy, refreshCloudWorkspaceRuntime: vi.fn(),
  closeCloudWorkspaceRuntime: state.close, publishCloudWorkspacePortForwardingRuntime: state.publish }));
vi.mock("../ws-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../ws-client")>();
  return { ...actual, RuntimeClient: class extends actual.RuntimeClient {
    constructor(...args: ConstructorParameters<typeof actual.RuntimeClient>) { super(...args); state.clients.push(this); }
  } };
});
vi.mock("../../cloud-workspaces", () => ({ cloudAgentGrant: vi.fn() }));
vi.mock("../../observability/analytics/agent-events", () => ({ trackGitOp: vi.fn() }));
vi.mock("../cloud-agent-connection", () => ({ CloudAgentConnection: class { dispose() {} async refreshAttachments() {} } }));
vi.mock("../cloud-event-reader", () => ({ CloudEventReader: class { dispose() {} on() { return () => {}; } } }));
vi.mock("../cloud-github-native", () => ({ installCloudGithubNative: vi.fn(() => () => {}) }));
import { openCloudRuntime } from "../open-cloud-runtime";

const now = 1_800_000_000_000;
const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const target = { organizationId: id(1), workspaceId: id(2) };
const scope = { ...target, generation: 7, engineInstanceId: id(3), bootId: id(4), writerEpoch: id(5), fundingOwnerUserId: id(6), fundingOwnerEpoch: 1 };
const binding: CloudAgentBootConversation = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", authorityEpoch: 3,
  cacheRevision: 1, desiredCacheRevision: 1, initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) as CloudAgentBootConversation["initialAdoptions"] };
function capabilities(issuedAt = now) {
  const capability = (aud: string) => ({ token: `e30.${Buffer.from(JSON.stringify({ aud, wsp: target.workspaceId, jti: "a".repeat(22),
    iat: issuedAt / 1000, exp: issuedAt / 1000 + 300 })).toString("base64url")}.${"s".repeat(86)}`, expiresAt: new Date(issuedAt + 300_000).toISOString() });
  return { engine: capability("zeros:engine"), realtime: capability("zeros:realtime") };
}
const sdk = (sequence = 1): CloudSdkRuntimeTarget => ({ kind: "cloud", channel: "sdk-websocket", ...target, runtimeId: id(7), generation: 7,
  authorityEpoch: 3, engineInstanceId: id(3), connectionSequence: sequence, expiresAt: Date.now() + 300_000, bootScope: scope, deviceSessionId: id(8), clientSessionId: id(9),
  connect: { workspaceId: target.workspaceId, generation: 7, engineInstanceId: id(3), runtimeBinding: { authorityEpoch: 3, bootScope: scope },
    capabilities: capabilities(Date.now()), routes: [{ kind: "direct", url: "wss://fixture-47891.on.boat.dev/ws", priority: 0 },
      { kind: "relay", url: "wss://realtime.example.test/v1/relay", priority: 1 }], renewAt: new Date(Date.now() + 180_000).toISOString(), relayHedgeMs: 400 } });
const legacy = () => ({ kind: "cloud", channel: "control-plane-websocket", ...target, runtimeId: id(10), generation: 7, authorityEpoch: 3,
  engineInstanceId: id(3), connectionSequence: 1, expiresAt: Date.now() + 120_000, bootScope: scope,
  url: "wss://api.example.test/v1/cloud-workspaces/bridge", cloudToken: `zwa_${"g".repeat(43)}` });

class Socket {
  static instances: Socket[] = [];
  readyState = 0; protocol = "zeros-cap.v1"; sent: Record<string, unknown>[] = []; closeCount = 0;
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null; onerror: (() => void) | null = null;
  constructor(readonly url: string, readonly protocols?: string[]) { Socket.instances.push(this); }
  send(text: string) {
    const request = JSON.parse(text) as Record<string, unknown>; this.sent.push(request);
    if (request.type === "WORKSPACE_REQUEST") this.engine({ type: "WORKSPACE_RESPONSE", requestId: request.id, op: request.op,
      result: request.op === "workspace.list" ? { workspaces: [{ id: "local-main", path: "/workspace/repo" }] } : {} });
    if (request.t === "auth.renew") this.message({ t: "auth.renewed", d: { expiresAtMs: Date.now() + 300_000 } });
  }
  open(protocol = "zeros-cap.v1") { this.protocol = protocol; this.readyState = 1; this.onopen?.(); }
  message(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  engine(frame: Record<string, unknown>) { this.message({ id: id(99), source: "engine", timestamp: Date.now(), ...frame }); }
  auth() { this.message({ t: "auth.ok", d: { sessionId: id(11), scopes: ["ws:read", "ws:edit"], expiresAtMs: Date.now() + 300_000 } }); }
  ready(overrides: Partial<CloudAgentBootConversation> = {}) { this.engine({ type: "ENGINE_READY", capabilities: ["cloud.localCommands.v1"], cloudLocalCommands: { ...binding, ...overrides } }); }
  close(code = 1000, reason = "closed") { if (this.readyState === 3) return; this.closeCount++; this.readyState = 3; this.onclose?.({ code, reason }); }
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const cleanups: Array<() => void> = [];
function opening(signal?: AbortSignal) {
  const pending = openCloudRuntime(target, { signal }).then(peer => { cleanups.push(peer.release); return peer; });
  void pending.catch(() => {}); return pending;
}
async function authenticate(socket: Socket, boot: Partial<CloudAgentBootConversation> = {}) {
  socket.open(); await tick(); socket.auth(); socket.ready(boot); await tick();
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal("window", globalThis); vi.stubGlobal("WebSocket", Socket);
  vi.stubEnv("VITE_CONTROL_PLANE_URL", "https://api.example.test"); vi.clearAllMocks(); Socket.instances = []; state.clients = [];
  state.listeners.clear(); state.epoch = 1; state.document = { status: "ready", generation: { number: 7 }, capabilities: { canRead: true, canWrite: true } };
  state.open.mockResolvedValue(sdk()); state.legacy.mockImplementation(async () => legacy()); state.fallback.mockImplementation(async () => legacy());
  state.proof.mockResolvedValue("s".repeat(86)); state.refresh.mockImplementation(async previous => sdk(previous.connectionSequence + 1));
  state.renew.mockImplementation(async () => capabilities(Date.now()));
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); for (const client of state.clients) client.dispose();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("desktop SDK runtime activation", () => {
  it("uses SDK authentication and retains the engine boot/root gate before forwarding", async () => {
    const pending = opening(); await tick(); const direct = Socket.instances[0]!;
    expect(state.open).toHaveBeenCalledExactlyOnceWith(target); expect(state.legacy).not.toHaveBeenCalled();
    expect(direct.protocols).toEqual(["zeros-cap.v1", "zeros-v1"]);
    direct.open(); await tick(); expect(direct.sent.map(frame => frame.t)).toEqual(["auth"]);
    direct.auth(); await tick(); expect(state.publish).not.toHaveBeenCalled();
    direct.ready(); const peer = await pending;
    expect(peer.client.status).toBe("connected"); expect(peer.runtimeId).toBe(id(7));
    expect(state.publish).toHaveBeenCalledWith(expect.objectContaining({ channel: "sdk-websocket", connectionSequence: 1 }), true);
    expect(direct.sent.find(frame => frame.type === "CONNECTED")).not.toHaveProperty("authToken");
    expect(state.proof).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: id(7) }), expect.objectContaining({ aud: "zeros:engine", route: "direct" }));
    expect(Socket.instances).toHaveLength(1); expect(state.accept).toHaveBeenCalledOnce();
  });

  it("starts relay at 400 ms, closes the stalled direct socket and delivers buffered engine frames", async () => {
    const pending = opening(); await tick(); expect(Socket.instances).toHaveLength(1);
    await tick(399); expect(Socket.instances).toHaveLength(1); await tick(1);
    expect(Socket.instances).toHaveLength(2); const [direct, relay] = Socket.instances;
    await authenticate(relay!); const peer = await pending;
    expect(peer.client.status).toBe("connected"); expect(direct!.closeCount).toBe(1);
    direct!.auth(); direct!.ready({ writerEpoch: id(88) }); await tick();
    expect(peer.client.status).toBe("connected"); expect(state.refresh).not.toHaveBeenCalled();
  });

  it.each(["writerEpoch", "bootId", "authorityEpoch"] as const)("sdk_ready_mismatched_boot_writer_refuses_commands_and_forwarding (%s)", async field => {
    const pending = opening(); const rejected = expect(pending).rejects.toThrow(); await tick();
    expect(Socket.instances[0]!.protocols).toEqual(["zeros-cap.v1", "zeros-v1"]);
    const client = state.clients[0]!;
    const command = client.request({ type: "AGENT_NEW_SESSION", agentId: "codex" }); void command.catch(() => {});
    await authenticate(Socket.instances[0]!, { [field]: field === "authorityEpoch" ? 4 : id(88) });
    await rejected; await expect(command).rejects.toThrow();
    expect(state.publish.mock.calls.some(([, connected]) => connected)).toBe(false); expect(state.accept).not.toHaveBeenCalled();
    expect(Socket.instances.every(socket => !socket.sent.some(frame => frame.type === "AGENT_NEW_SESSION"))).toBe(true);
    expect(state.fallback).not.toHaveBeenCalled(); expect(state.close).toHaveBeenCalledWith(id(7));
  });

  it("negotiates zeros-v1 through exactly one native fallback and releases the actual legacy handle", async () => {
    const pending = opening(); await tick(); Socket.instances[0]!.open("zeros-v1"); await tick();
    expect(state.fallback).toHaveBeenCalledOnce(); expect(state.legacy).not.toHaveBeenCalled();
    const socket = Socket.instances[1]!; expect(socket.protocols?.[0]).toBe("zeros-v1");
    socket.open("zeros-v1"); socket.ready(); const peer = await pending;
    expect(peer.runtimeId).toBe(id(10)); expect(state.publish).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: id(10) }), true);
    peer.release(); expect(state.close).toHaveBeenCalledWith(id(10));
  });

  it("cancels pending SDK proofs and both routes without issuing startup work", async () => {
    let finish!: (signature: string) => void; state.proof.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const stop = new AbortController(), pending = opening(stop.signal), rejected = expect(pending).rejects.toThrow(/cancel|disposed|abort/i);
    await tick(); Socket.instances[0]!.open(); await tick(400); stop.abort(); await rejected;
    expect(Socket.instances.every(socket => socket.closeCount === 1)).toBe(true);
    finish("s".repeat(86)); await tick(30_000);
    expect(Socket.instances.every(socket => socket.sent.length === 0)).toBe(true); expect(state.accept).not.toHaveBeenCalled();
    expect(state.renew).not.toHaveBeenCalled(); expect(state.refresh).not.toHaveBeenCalled();
  });

  it("silently renews through native issuance without reconnecting or republishing forwarding", async () => {
    const pending = opening(); await tick(); await authenticate(Socket.instances[0]!); const peer = await pending;
    const statuses = vi.fn(); peer.client.onStatusChange(statuses); state.publish.mockClear();
    // Cross the original five-minute admission expiry and a second renewal.
    await tick(600_000);
    expect(state.renew).toHaveBeenCalledTimes(2); expect(Socket.instances).toHaveLength(1);
    expect(Socket.instances[0]!.sent.filter(frame => frame.t === "auth.renew")).toHaveLength(2);
    expect(peer.client.status).toBe("connected"); expect(statuses).not.toHaveBeenCalled(); expect(state.publish).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
    peer.release(); await tick(600_000); expect(state.renew).toHaveBeenCalledTimes(2);
  });

  it("makes one fresh native connect after a 4403 refusal and stops when CP denies it", async () => {
    state.refresh.mockRejectedValue({ code: "forbidden", status: 403 });
    const pending = opening(), rejected = expect(pending).rejects.toThrow(); await tick();
    Socket.instances[0]!.close(4403, "capability_revoked"); await tick();
    Socket.instances[1]!.close(4403, "capability_revoked"); await tick(1000); await rejected;
    expect(state.refresh).toHaveBeenCalledOnce(); await tick(60_000); expect(state.refresh).toHaveBeenCalledOnce();
    expect(state.fallback).not.toHaveBeenCalled(); expect(state.accept).not.toHaveBeenCalled();
  });

  it("reconnects with the same race and the next native sequence while keeping requests behind boot readiness", async () => {
    const pending = opening(); await tick(); await authenticate(Socket.instances[0]!); const peer = await pending;
    const first = Socket.instances[0]!; first.close(1006); await tick(1000);
    expect(state.refresh).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runtimeId: id(7), connectionSequence: 1 }));
    const current = Socket.instances[1]!;
    const read = peer.client.request({ type: "WORKSPACE_REQUEST", op: "file.read", params: {} }); void read.catch(() => {});
    expect(current.sent).toEqual([]); expect(first.sent.some(frame => frame.op === "file.read")).toBe(false);
    await authenticate(current); await read;
    expect(current.sent.some(frame => frame.op === "file.read")).toBe(true);
    expect(state.publish).toHaveBeenLastCalledWith(expect.objectContaining({ runtimeId: id(7), connectionSequence: 2 }), true);
    first.ready({ writerEpoch: id(88) }); expect(peer.client.status).toBe("connected");
  });

  it("keeps a native flag-off descriptor on the existing transport without SDK proof or renewal work", async () => {
    state.open.mockResolvedValue(legacy());
    const pending = opening(); await tick(); const socket = Socket.instances[0]!;
    expect(socket.protocols?.[0]).toBe("zeros-v1"); socket.open("zeros-v1"); socket.ready();
    const peer = await pending; expect(peer.client.status).toBe("connected");
    expect(state.proof).not.toHaveBeenCalled(); expect(state.renew).not.toHaveBeenCalled(); expect(state.fallback).not.toHaveBeenCalled();
  });

  it.each(["account", "incarnation", "generation"])("retires an SDK race when %s changes and ignores late frames", async reason => {
    const pending = opening(), rejected = expect(pending).rejects.toThrow(); await tick();
    const socket = Socket.instances[0]!; socket.open(); await tick();
    if (reason === "generation") state.document = { ...state.document, generation: { number: 8 } };
    else state.epoch += reason === "incarnation" ? 2 : 1;
    for (const listener of state.listeners) listener(); await rejected;
    socket.auth(); socket.ready(); await tick();
    expect(state.accept).not.toHaveBeenCalled(); expect(state.publish.mock.calls.some(([, connected]) => connected)).toBe(false);
    expect(socket.closeCount).toBe(1); expect(state.close).toHaveBeenCalledWith(id(7));
  });

  it("refuses a fallback admission from a different boot before opening its legacy socket", async () => {
    state.fallback.mockResolvedValue({ ...legacy(), bootScope: { ...scope, writerEpoch: id(88) } });
    const pending = opening(), rejected = expect(pending).rejects.toThrow(); await tick();
    Socket.instances[0]!.open("zeros-v1"); await rejected;
    expect(Socket.instances).toHaveLength(1); expect(state.close).toHaveBeenCalledWith(id(10));
    expect(state.accept).not.toHaveBeenCalled(); expect(state.publish.mock.calls.some(([, connected]) => connected)).toBe(false);
  });

  it("closes a legacy fallback delivered after cancellation without reviving the retired SDK client", async () => {
    let deliver!: (value: ReturnType<typeof legacy>) => void;
    state.fallback.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    const stop = new AbortController(), pending = opening(stop.signal), rejected = expect(pending).rejects.toThrow(); await tick();
    Socket.instances[0]!.open("zeros-v1"); await tick(); expect(state.fallback).toHaveBeenCalledOnce();
    stop.abort(); await rejected; deliver(legacy()); await tick();
    expect(state.close).toHaveBeenCalledWith(id(10)); expect(Socket.instances).toHaveLength(1); expect(state.accept).not.toHaveBeenCalled();
  });
});

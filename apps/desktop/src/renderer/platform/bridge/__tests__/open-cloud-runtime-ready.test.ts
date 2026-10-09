import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentBootConversation } from "@zeros/protocol/cloud-agent-bootstrap";
import type { CloudRuntimeConnectionTarget } from "../ws-client";

const mocks = vi.hoisted(() => ({ epoch: 1, listeners: new Set<() => void>(), admission: vi.fn(), refresh: vi.fn(),
  close: vi.fn(async () => true), publish: vi.fn(async () => {}), accept: vi.fn(),
  document: { status: "ready", generation: { number: 2 }, capabilities: { canRead: true, canWrite: true } } }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  cloudCatalogGeneration: () => mocks.epoch, cloudWorkspaceDocument: () => mocks.document,
  refreshCloudWorkspace: async () => mocks.document, canReadCloudWorkspace: () => true,
  acceptCloudEngineWorkspace: mocks.accept,
  subscribeCloudWorkspaces: (fn: () => void) => { mocks.listeners.add(fn); return () => mocks.listeners.delete(fn); },
}));
vi.mock("../../../state/cloud-workspace-wake", () => ({ wakeCloudWorkspace: vi.fn() }));
vi.mock("../../cloud-workspace-access", () => ({ openCloudWorkspaceRuntime: mocks.admission,
  refreshCloudWorkspaceRuntime: mocks.refresh, closeCloudWorkspaceRuntime: mocks.close,
  publishCloudWorkspacePortForwardingRuntime: mocks.publish }));
vi.mock("../../cloud-workspaces", () => ({ cloudAgentGrant: vi.fn() }));
vi.mock("../workspace-runtime-client", () => ({ WorkspaceRuntimeClient: class {} }));
vi.mock("../../observability/analytics/agent-events", () => ({ trackGitOp: vi.fn() }));
vi.mock("../cloud-agent-connection", () => ({ CloudAgentConnection: class { dispose() {} async refreshAttachments() {} } }));
vi.mock("../cloud-event-reader", () => ({ CloudEventReader: class { dispose() {} on() { return () => {}; } } }));
vi.mock("../../runtime", () => ({ nativeInvoke: vi.fn() }));
import { openCloudRuntime } from "../open-cloud-runtime";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = 1_800_000_000_000;
const target = { organizationId: uuid(1), workspaceId: uuid(2) };
const scope = { ...target, generation: 2, engineInstanceId: uuid(3), bootId: uuid(4), writerEpoch: uuid(5),
  fundingOwnerUserId: uuid(6), fundingOwnerEpoch: 1 };
const binding: CloudAgentBootConversation = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
  authorityEpoch: 7, cacheRevision: 1, desiredCacheRevision: 1,
  initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) as CloudAgentBootConversation["initialAdoptions"] };
const direct = (): Extract<CloudRuntimeConnectionTarget, { channel: "direct-provider-websocket" }> => ({ ...target, generation: 2, engineInstanceId: uuid(3),
  kind: "cloud", channel: "direct-provider-websocket", runtimeId: uuid(7), authorityEpoch: 7, connectionSequence: 1,
  remotePort: 24193, url: "wss://workspace-24193.on.boat.dev/ws", cloudToken: `zwa_${"a".repeat(43)}`,
  expiresAt: now + 120_000, bootScope: scope });
class Socket {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; static instances: Socket[] = [];
  readyState = 0; sent: Record<string, unknown>[] = []; closeCount = 0; root = "/workspace/repo";
  onopen: (() => void) | null = null; onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
  constructor(readonly url: string, readonly protocols?: string[]) { Socket.instances.push(this); }
  send(value: string) {
    const request = JSON.parse(value) as Record<string, unknown>; this.sent.push(request);
    if (request.type === "WORKSPACE_REQUEST") this.receive({ type: "WORKSPACE_RESPONSE", requestId: request.id,
      op: request.op, result: request.op === "workspace.list" ? { workspaces: [{ id: "local-main", path: this.root }] } : {} });
  }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(value: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify({ id: uuid(99), source: "engine", timestamp: Date.now(), ...value }) }); }
  ready() { this.receive({ type: "ENGINE_READY", capabilities: ["cloud.localCommands.v1"], cloudLocalCommands: binding }); }
  close() { this.closeCount++; this.readyState = 3; }
}
let release: (() => void) | undefined;
let controller: AbortController;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal("window", globalThis); vi.stubGlobal("WebSocket", Socket);
  vi.stubEnv("VITE_CONTROL_PLANE_URL", "https://api.zeros.test"); Socket.instances = [];
  vi.clearAllMocks(); mocks.epoch = 1; mocks.listeners.clear();
  controller = new AbortController();
  mocks.admission.mockResolvedValue(direct());
  const { remotePort: _port, ...relay } = direct();
  mocks.refresh.mockResolvedValue({ ...relay, channel: "control-plane-websocket",
    url: "wss://api.zeros.test/v1/cloud-workspaces/bridge", cloudToken: `zwa_${"b".repeat(43)}`, connectionSequence: 2 });
});
afterEach(() => { release?.(); controller.abort(); release = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("cloud startup with the real bridge queue", () => {
  it("waits for actual actor and boot readiness before issuing startup reads, even beyond the queue grace", async () => {
    const opening = openCloudRuntime(target, { signal: controller.signal }); const outcome = opening.then(peer => { release = peer.release; return peer; });
    void outcome.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(Socket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    const relay = Socket.instances[1]!;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(relay.sent).toEqual([]); expect(mocks.accept).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
    relay.open(); await vi.advanceTimersByTimeAsync(0);
    expect(relay.sent.filter(message => message.op === "workspace.list")).toHaveLength(1);
    expect(relay.sent.some(message => message.op === "github.nativeGrant")).toBe(false);
    relay.ready(); const peer = await outcome;
    expect(peer.client.status).toBe("connected"); expect(mocks.accept).toHaveBeenCalledOnce();
    expect(relay.sent.filter(message => message.op === "workspace.list")).toHaveLength(2);
    expect(relay.sent.filter(message => message.op === "github.nativeGrant")).toHaveLength(1);
    expect(mocks.close).not.toHaveBeenCalled(); expect(relay.closeCount).toBe(0);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ connectionSequence: 2 }), true);
  });
  it("cancels readiness without waiting for a socket event or issuing startup work", async () => {
    const controller = new AbortController(); const opening = openCloudRuntime(target, { signal: controller.signal });
    const refused = expect(opening).rejects.toThrow(/cancel|abort|disposed/i);
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await refused;
    expect(mocks.close).toHaveBeenCalledOnce(); expect(mocks.accept).not.toHaveBeenCalled();
    expect(Socket.instances[0]!.sent).toEqual([]); expect(Socket.instances[0]!.closeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("fails closed on a terminal direct denial without a relay mint", async () => {
    const opening = openCloudRuntime(target); const refused = expect(opening).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0); const socket = Socket.instances[0]!;
    socket.close(); socket.onclose?.({ code: 1008, reason: "client authority revoked" });
    await refused; await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.accept).not.toHaveBeenCalled();
  });
});

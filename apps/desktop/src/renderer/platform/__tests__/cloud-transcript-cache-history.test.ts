import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ native: vi.fn(), allowed: true }));
vi.mock("../runtime", async original => ({ ...await original<typeof import("../runtime")>(), isElectron: () => true, nativeInvoke: h.native }));
vi.mock("../../state/cloud-workspace-catalog", () => ({ canReadCloudWorkspace: () => h.allowed, cloudWorkspaceCatalogConfirmed: () => true,
  cloudWorkspaceDocument: () => ({ status: "stopped" }), getCloudWorkspaceRows: () => [] }));
import { windowMessages } from "../../features/agent/agent-history-client";
import { WorkspaceRuntimeClient, type CloudPeer } from "../bridge/workspace-runtime-client";
import { RuntimeClient } from "../bridge/ws-client";
import { cloudScopedId } from "../bridge/cloud-workspace-key";
import { setActiveBridge } from "../bridge/active-bridge";
import { readCachedCloudTranscriptWindow, setCloudTranscriptCacheOwner } from "../cloud-transcript-cache";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chatId = cloudScopedId(target, "chat-a");
const row = (text: string) => ({ msgId: "m-1", kind: "text", createdAt: 1, payload: JSON.stringify({ id: "m-1", kind: "text", role: "agent", text, createdAt: 1 }) });
const clients: WorkspaceRuntimeClient[] = [];
beforeEach(() => {
  h.allowed = true; setCloudTranscriptCacheOwner("account-a");
  h.native.mockReset().mockResolvedValue({ cacheEpoch: "33333333-3333-4333-8333-333333333333",
    window: { recordEpoch: null, revision: 100, cursor: "m-1", messages: [row("cached cloud")] } });
});
afterEach(() => { setActiveBridge(null); setCloudTranscriptCacheOwner(null); for (const client of clients.splice(0)) client.dispose(); vi.restoreAllMocks(); });
function runtime(readHistory: () => Promise<Record<string, unknown>>) {
  const peer: CloudPeer = { client: { status: "connected", request: vi.fn(async () => ({ type: "WORKSPACE_RESPONSE", result: { chats: [], chatDeletions: [] } })),
    send: vi.fn(), on: () => () => {}, onStatusChange: () => () => {} } as unknown as RuntimeClient,
    scope: { ...target, root: "/workspace/repo", engineWorkspaceId: "local-main" }, runtimeId: "runtime-a", release: vi.fn() };
  const open = vi.fn(async () => peer), authority = vi.fn(() => h.allowed);
  const client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [], canAccess: authority }); clients.push(client); setActiveBridge(client);
  return { client, open, authority };
}
describe("shared history integration with a cloud transcript cache", () => {
  it("reads Personal and org-Local history unchanged while a cached cloud window and connected cloud peer exist", async () => {
    await readCachedCloudTranscriptWindow(chatId);
    const hRuntime = runtime(async () => ({ chats: [], chatDeletions: [] })); await hRuntime.client.warmWorkspace(target);
    const localRequest = vi.spyOn(RuntimeClient.prototype, "request");
    h.allowed = false; h.native.mockClear(); hRuntime.authority.mockClear();
    for (const folder of ["/personal/checkout", "/organization/checkout"]) {
      localRequest.mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", op: "messages.window", result: { messages: [row(folder)], revision: 1 } } as never);
      const painted = vi.fn(), messages = await windowMessages("local-chat", 200, undefined, painted);
      expect(messages).toMatchObject([{ text: folder }]); expect(painted).not.toHaveBeenCalled();
    }
    expect(h.native).not.toHaveBeenCalled(); expect(hRuntime.authority).not.toHaveBeenCalled(); expect(hRuntime.open).toHaveBeenCalledOnce();
    expect(localRequest).toHaveBeenCalledTimes(2);
  });
  it("preserves a Local disconnect/restart rejection and then reads the replacement engine without cache fallback", async () => {
    await readCachedCloudTranscriptWindow(chatId); runtime(async () => ({ messages: [row("cloud")] }));
    const localRequest = vi.spyOn(RuntimeClient.prototype, "request"); h.native.mockClear();
    localRequest.mockRejectedValueOnce(new Error("Local engine reconnecting"));
    const painted = vi.fn(); await expect(windowMessages("local-chat", 200, undefined, painted)).rejects.toThrow("Local engine reconnecting");
    localRequest.mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", op: "messages.window", result: { messages: [row("replacement Local engine")] } } as never);
    expect(await windowMessages("local-chat", 200, undefined, painted)).toMatchObject([{ text: "replacement Local engine" }]);
    expect(painted).not.toHaveBeenCalled(); expect(h.native).not.toHaveBeenCalled();
  });
  it("paints a primed stopped-cloud window before its real history bridge request settles, without VM admission", async () => {
    await readCachedCloudTranscriptWindow(chatId);
    let resolve!: (value: Record<string, unknown>) => void;
    const server = new Promise<Record<string, unknown>>(done => { resolve = done; });
    const hRuntime = runtime(() => server), painted = vi.fn();
    const result = windowMessages(chatId, 200, undefined, painted); await Promise.resolve();
    expect(painted).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ text: "cached cloud" })]));
    expect(hRuntime.open).not.toHaveBeenCalled();
    resolve({ revision: 101, messages: [row("new server window")] }); expect(await result).toMatchObject([{ text: "new server window" }]);
    expect(hRuntime.open).not.toHaveBeenCalled();
  });
});

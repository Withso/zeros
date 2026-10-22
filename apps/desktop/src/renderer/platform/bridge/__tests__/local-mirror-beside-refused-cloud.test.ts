import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRuntimeAccessError } from "../cloud-runtime-access-error";
import { WorkspaceRuntimeClient, type CloudPeer, type WorkspaceRuntimeOptions } from "../workspace-runtime-client";
import { RuntimeClient } from "../ws-client";
import { cloudScopedId, cloudWorkspaceKey, type CloudWorkspaceTarget } from "../cloud-workspace-key";
import { bridgeChatBulkUpsert } from "../workspace-bridge";
import type { ChatRowWire } from "../../../features/agent/agent-history-client";

const a = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const b = { ...a, workspaceId: "33333333-3333-4333-8333-333333333333" };
const clients: WorkspaceRuntimeClient[] = [];
function row(target: CloudWorkspaceTarget | string, updatedAt = 10): ChatRowWire {
  return { id: typeof target === "string" ? target : cloudScopedId(target, "chat"),
    folder: typeof target === "string" ? target : cloudWorkspaceKey(target),
    agentId: "codex", agentName: "Codex", model: null, effort: "medium", permissionMode: "default",
    lastModeId: null, prePlanModeId: null, fast: false, additionalDirectories: [], title: `Edit ${updatedAt}`,
    createdAt: 1, updatedAt, sessionId: null, pinned: false, archived: false, sourceChatId: null, kind: "chat" };
}
function peer(target: CloudWorkspaceTarget) {
  const request = vi.fn(async (message: { op?: string }) => ({ type: "WORKSPACE_RESPONSE", op: message.op,
    result: message.op === "chats.list" ? { chats: [], chatDeletions: [] } : { ok: true } }));
  return { request, value: { scope: { ...target, root: "/home/user/Owner/repo", engineWorkspaceId: target.workspaceId },
    release: vi.fn(), client: { status: "connected", request, on: () => () => {}, onStatusChange: () => () => {} },
  } as unknown as CloudPeer };
}
function runtime(options: WorkspaceRuntimeOptions) {
  const client = new WorkspaceRuntimeClient(options); clients.push(client); return client;
}
const refusal = () => new CloudRuntimeAccessError({ code: "request_failed", status: 409 });
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.restoreAllMocks(); });

describe("Local chat mirror beside a refused cloud owner", () => {
  it("isolates a refused cloud owner from another cloud workspace and both Local placements", async () => {
    const denied = refusal(), other = peer(b);
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>(async target => {
      if (target.workspaceId === a.workspaceId) throw denied;
      return other.value;
    });
    const local = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: { ok: true } } as never);
    const client = runtime({ open, workspaces: () => [] });
    await expect(bridgeChatBulkUpsert(client, [row(a)])).rejects.toBe(denied);
    for (let updatedAt = 20; updatedAt <= 30; updatedAt += 10)
      await expect(bridgeChatBulkUpsert(client, [row(a, updatedAt), row(b, updatedAt), row("/personal/local", updatedAt), row("/organization/local", updatedAt)])).rejects.toBe(denied);
    expect(open.mock.calls.filter(([target]) => target.workspaceId === a.workspaceId)).toHaveLength(1);
    expect(open.mock.calls.filter(([target]) => target.workspaceId === b.workspaceId)).toHaveLength(1);
    // Both Local batches still settle beside the refused cloud batch.
    expect(local).toHaveBeenCalledTimes(2);
    expect(local.mock.calls[1][0]).toMatchObject({ params: { chats: [{ folder: "/personal/local", updatedAt: 30 }, { folder: "/organization/local", updatedAt: 30 }] } });
    expect(other.request.mock.calls.filter(([message]) => message.op === "chats.bulkUpsert")).toHaveLength(2);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRuntimeAccessError } from "../cloud-runtime-access-error";
import { WorkspaceRuntimeClient, type CloudPeer, type WorkspaceRuntimeOptions } from "../workspace-runtime-client";
import { RuntimeClient } from "../ws-client";
import { cloudScopedId, cloudWorkspaceKey, type CloudWorkspaceTarget } from "../cloud-workspace-key";
import { bridgeChatBulkUpsert, bridgeChatClearProviderIdentity } from "../workspace-bridge";
import type { ChatRowWire } from "../../../features/agent/agent-history-client";
import { persistChatRowsWithBestEffortIdentityClears } from "../../../features/agent/chat-provider-identity-persistence";
import { reconcileChatSnapshot } from "../../../state/chat-reconciliation";
import { sanitizeCachedChat } from "../../../state/chat-boot-cache";

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
  return { request, value: { scope: { ...target, root: "/workspace/repo", engineWorkspaceId: "local-main" },
    release: vi.fn(), client: { status: "connected", request, on: () => () => {}, onStatusChange: () => () => {} },
  } as unknown as CloudPeer };
}
function runtime(options: WorkspaceRuntimeOptions) {
  const client = new WorkspaceRuntimeClient(options); clients.push(client); return client;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const refusal = () => new CloudRuntimeAccessError({ code: "request_failed", status: 409 });
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("cloud chat mirror admission", () => {
  it.each(["request_failed", "cloud_actor_admission_rejected", "cloud_workspace_access_superseded"])(
    "retains %s across passive snapshots and mirrors only the latest edit after explicit recovery", async code => {
      vi.useFakeTimers();
      const denied = new CloudRuntimeAccessError({ code, status: 409 }), connected = peer(a);
      const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockRejectedValueOnce(denied).mockResolvedValue(connected.value);
      const remote = row(a), readHistory = vi.fn(async () => ({ chats: [remote], chatDeletions: [] }));
      const client = runtime({ open, readHistory, workspaces: () => [], identity: () => "account:1:owner:1:generation:7" });
      vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: { chats: [], chatDeletions: [] } } as never);
      let local = [sanitizeCachedChat(row(a, 20))!];
      for (const timestamp of [20, 30, 40]) {
        await vi.advanceTimersByTimeAsync(2_500);
        local = [{ ...local[0], title: `Edit ${timestamp}`, updatedAt: timestamp }];
        await client.warmHistoryWorkspace(a);
        client.pruneCloudConnections(); // Ordinary catalog publication is not reauthorization.
        const snapshot = await client.chatSnapshot("retained");
        const reconciled = reconcileChatSnapshot(local, (snapshot.chats as ChatRowWire[]).map(value => sanitizeCachedChat(value)!),
          snapshot.chatDeletions as string[], snapshot.confirmedCloudWorkspaces as string[], true);
        expect(reconciled.chats).toBe(local);
        expect(reconciled.rowsToPush).toHaveLength(1);
        await expect(bridgeChatBulkUpsert(client, [row(a, timestamp)])).rejects.toBe(denied);
      }
      expect(open).toHaveBeenCalledOnce();
      expect(open.mock.calls[0][1]?.wake).toBeUndefined();
      expect(connected.request).not.toHaveBeenCalled();
      await client.openWorkspace(a, { reason: "interaction" });
      expect(open).toHaveBeenCalledTimes(2);
      expect(open.mock.calls[1][1]).toMatchObject({ wake: true, reason: "interaction" });
      expect(connected.request).not.toHaveBeenCalled(); // Recovery itself does not replay a metadata write.
      await bridgeChatBulkUpsert(client, [row(a, 40)]);
      expect(connected.request).toHaveBeenCalledOnce();
      expect(connected.request.mock.calls[0][0]).toMatchObject({ op: "chats.bulkUpsert", params: { chats: [{ title: "Edit 40", updatedAt: 40 }] } });
    },
  );

  it("shares one refusal between the real optional identity clear and authoritative mirror", async () => {
    const denied = refusal(), open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockRejectedValue(denied);
    const client = runtime({ open, workspaces: () => [] });
    const clear = { chatId: row(a).id, agentId: "codex", resumeId: "old-thread" };
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(persistChatRowsWithBestEffortIdentityClears([row(a)], [clear],
        input => bridgeChatClearProviderIdentity(client, input), rows => bridgeChatBulkUpsert(client, rows))).rejects.toBe(denied);
    expect(open).toHaveBeenCalledOnce();
  });

  it.each([
    { code: "engine_client_admission_ineligible", status: 409 },
    { code: "request_failed", status: 408 }, { code: "request_failed", status: 429 }, { code: "request_failed", status: 503 },
  ])("keeps typed transient recovery for $code/$status without an internal retry", async error => {
    const connected = peer(a), failure = new CloudRuntimeAccessError(error);
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockRejectedValueOnce(failure).mockResolvedValue(connected.value);
    const client = runtime({ open, workspaces: () => [] });
    await expect(bridgeChatBulkUpsert(client, [row(a)])).rejects.toBe(failure);
    expect(open).toHaveBeenCalledOnce(); expect(connected.request).not.toHaveBeenCalled();
    await bridgeChatBulkUpsert(client, [row(a)]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls.every(([, options]) => !options?.wake)).toBe(true);
  });

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
    expect(local).toHaveBeenCalledTimes(2);
    expect(local.mock.calls[1][0]).toMatchObject({ params: { chats: [{ folder: "/personal/local", updatedAt: 30 }, { folder: "/organization/local", updatedAt: 30 }] } });
    expect(other.request.mock.calls.filter(([message]) => message.op === "chats.bulkUpsert")).toHaveLength(2);
  });

  it("retries only fresh identity and cannot let a late old refusal poison its replacement", async () => {
    const pending = deferred<CloudPeer>(), next = peer(a);
    let identity = "generation:7";
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockReturnValueOnce(pending.promise).mockResolvedValue(next.value);
    const client = runtime({ open, workspaces: () => [], identity: () => identity });
    const old = bridgeChatBulkUpsert(client, [row(a)]), rejected = expect(old).rejects.toBeInstanceOf(CloudRuntimeAccessError);
    identity = "generation:8";
    await bridgeChatBulkUpsert(client, [row(a, 20)]);
    pending.reject(refusal()); await rejected;
    await bridgeChatBulkUpsert(client, [row(a, 30)]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("retires a remembered refusal when the exact generation changes", async () => {
    const connected = peer(a), denied = refusal(); let generation = 7;
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockRejectedValueOnce(denied).mockResolvedValue(connected.value);
    const client = runtime({ open, workspaces: () => [], identity: () => String(generation) });
    await expect(bridgeChatBulkUpsert(client, [row(a)])).rejects.toBe(denied);
    generation++;
    await bridgeChatBulkUpsert(client, [row(a, 20)]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it.each(["settled", "pending"])("fences %s refusals across account A to B to A", async timing => {
    const denied = refusal(), pending = deferred<CloudPeer>(), connected = peer(a);
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockReturnValueOnce(timing === "pending" ? pending.promise : Promise.reject(denied)).mockResolvedValue(connected.value);
    const client = runtime({ open, workspaces: () => [], identity: () => "account:A:generation:7" });
    const first = bridgeChatBulkUpsert(client, [row(a)]), rejected = expect(first).rejects.toBe(denied);
    if (timing === "settled") await rejected;
    client.clearCloudConnections(); // Account B.
    client.clearCloudConnections(); // New session for A, same workspace/generation.
    await bridgeChatBulkUpsert(client, [row(a, 20)]);
    if (timing === "pending") { pending.reject(denied); await rejected; }
    await bridgeChatBulkUpsert(client, [row(a, 30)]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("forgets a removed owner's refusal before the same readable owner returns", async () => {
    const denied = refusal(), connected = peer(a); let allowed = true;
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockRejectedValueOnce(denied).mockResolvedValue(connected.value);
    const client = runtime({ open, workspaces: () => [], canAccess: () => allowed });
    await expect(bridgeChatBulkUpsert(client, [row(a)])).rejects.toBe(denied);
    allowed = false; client.pruneCloudConnections();
    await expect(bridgeChatBulkUpsert(client, [row(a)])).rejects.toThrow(/not been confirmed/);
    allowed = true; client.pruneCloudConnections();
    await bridgeChatBulkUpsert(client, [row(a, 20)]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("also remembers a synchronous typed admission refusal", async () => {
    const denied = refusal(), open = vi.fn<WorkspaceRuntimeOptions["open"]>(() => { throw denied; });
    const client = runtime({ open, workspaces: () => [] });
    for (let attempt = 0; attempt < 3; attempt++) await expect(bridgeChatBulkUpsert(client, [row(a)])).rejects.toBe(denied);
    expect(open).toHaveBeenCalledOnce();
  });
});

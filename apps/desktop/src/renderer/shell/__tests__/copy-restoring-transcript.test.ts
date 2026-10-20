import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "../../platform/bridge/active-bridge";
import { cloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import { bridgeMessageWindowOlder } from "../../platform/bridge/workspace-bridge";
import type { CloudHistoryRestoreMetadata } from "../../platform/cloud-transcript-cache-contract";
import { copyChatTranscript } from "../copy-chat-transcript";
import { loadFullTranscript } from "../../features/agent/agent-history-client";

const output = vi.hoisted(() => ({
  copy: vi.fn(async (_text: string) => true),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: output.toast }));
vi.mock("../../shared/lib/clipboard", () => ({ copyToClipboardWithFallback: output.copy }));

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chat = cloudScopedId(target, "chat");
const metadata: CloudHistoryRestoreMetadata = {
  projection: { ...target, generation: 1, engineInstanceId: "33333333-3333-4333-8333-333333333333",
    bootId: "44444444-4444-4444-8444-444444444444", writerEpoch: "55555555-5555-4555-8555-555555555555",
    fundingOwnerUserId: "66666666-6666-4666-8666-666666666666", fundingOwnerEpoch: 1,
    version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", mirroredSequence: 20, sealedSequence: null, complete: false },
  historyHeads: [{ conversationId: "chat", originWriterEpoch: "55555555-5555-4555-8555-555555555555",
    source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "edit" },
    restoreRevision: 3, recordSequence: null, eventSequence: null, manifestSha256: null,
    deleted: false, incompleteReason: "capture_unavailable" }],
};
const clients: WorkspaceRuntimeClient[] = [];
const rows = [{ msgId: "prompt", kind: "text", createdAt: 1,
  payload: JSON.stringify({ id: "prompt", kind: "text", role: "user", text: "Saved request", createdAt: 1 }) },
{ msgId: "answer", kind: "text", createdAt: 2,
  payload: JSON.stringify({ id: "answer", kind: "text", role: "agent", text: "Saved answer", createdAt: 2 }) }];
function fixture(value = metadata, messages = [] as typeof rows) {
  const open = vi.fn(async () => { throw new Error("A transcript read must not wake the workspace"); });
  const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], canAccess: () => true,
    readHistory: async (_target, op) => ({ messages: op === "messages.windowOlder" ? [] : messages, ...value }) });
  clients.push(client); setActiveBridge(client);
  return { client, open };
}
afterEach(() => {
  setActiveBridge(null);
  for (const client of clients.splice(0)) client.dispose();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Copy transcript while the current projection is incomplete", () => {
  it("keeps transcript attachments strict when partial copy has not been requested", async () => {
    fixture(metadata, rows);
    await expect(loadFullTranscript(chat)).rejects.toMatchObject({ code: "cloud_history_incomplete" });
    expect(output.copy).not.toHaveBeenCalled();
  });

  it.each(["account", "access", "restore", "delete"])("rejects partial rows retired by %s during the CP read", async cause => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let resolve!: (value: object) => void;
    const held = new Promise<object>(r => { resolve = r; });
    let allowed = true;
    const nextHead = { ...metadata.historyHeads[0], restoreRevision: 4, deleted: cause === "delete" };
    if (cause === "delete") nextHead.source = { kind: "mutation", mutationId: "88888888-8888-4888-8888-888888888888", operation: "delete" };
    const readHistory = vi.fn().mockReturnValueOnce(held).mockResolvedValue({ ...metadata, historyHeads: [nextHead], messages: [] });
    const open = vi.fn();
    const client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [], canAccess: () => allowed });
    clients.push(client); setActiveBridge(client);
    const pending = copyChatTranscript(chat, "full", {});
    await vi.waitFor(() => expect(readHistory).toHaveBeenCalledOnce());
    if (cause === "account") { client.clearCloudConnections(); client.clearCloudConnections(); }
    else if (cause === "access") allowed = false;
    else await client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params: { chatId: chat, limit: 1 } });
    resolve({ ...metadata, messages: rows }); await pending;
    expect(output.copy).not.toHaveBeenCalled();
    expect(output.toast.success).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["full", "concise"] as const)("copies available %s CP rows with an honest partial warning", async mode => {
    const { open } = fixture(metadata, rows);
    await copyChatTranscript(chat, mode, {});
    expect(output.copy).toHaveBeenCalledOnce();
    expect(output.copy.mock.calls[0]?.[0]).toContain("Saved answer");
    expect(output.toast.warning).toHaveBeenCalledWith(expect.stringMatching(/partial/i));
    expect(output.toast.success).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("uses bounded native retries before copying an incomplete CP projection", async () => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { mirroredSequence: _m, sealedSequence: _s, complete: _c, ...bootIdentity } = metadata.projection;
    const binding = CloudAgentBootConversationSchema.parse({ ...bootIdentity, authorityEpoch: 1,
      cacheRevision: 1, desiredCacheRevision: 1, initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) });
    const request = vi.fn(async (message: { op?: string }) => message.op === "chats.list"
      ? { type: "WORKSPACE_RESPONSE", op: "chats.list", result: { chats: [], chatDeletions: [], ...metadata } }
      : { type: "WORKSPACE_ERROR", op: message.op, code: "command_conflict", message: "History changed" });
    const client = new WorkspaceRuntimeClient({ workspaces: () => [], canAccess: () => true,
      open: async () => ({ client: { request, status: "connected", activatedCloudAgentBootBinding: binding,
        executionIdentity: { kind: "cloud", ...target, generation: 1, engineInstanceId: metadata.projection.engineInstanceId,
          authorityEpoch: 1, bootScope: metadata.projection }, onStatusChange: () => () => {}, on: () => () => {},
      } as unknown as RuntimeClient, scope: { ...target, root: "/workspace/repo", engineWorkspaceId: "main" },
      generation: 1, runtimeId: "copy-native", release: () => {} }),
      readHistory: async (_target, op) => op === "chats.list" ? { chats: [], chatDeletions: [], ...metadata }
        : { messages: op === "messages.windowOlder" ? [] : rows, ...metadata },
    });
    clients.push(client); setActiveBridge(client); await client.warmWorkspace(target); request.mockClear();
    const pending = copyChatTranscript(chat, "full", {});
    await vi.advanceTimersByTimeAsync(8_000); await pending;
    expect(request).toHaveBeenCalledTimes(5);
    expect(output.copy).toHaveBeenCalledOnce();
    expect(output.toast.warning).toHaveBeenCalledWith(expect.stringMatching(/partial/i));
  });

  it.each(["capture_unavailable", "capture_conflict", "history_limit", "recovery_uncertain", "missing"] as const)(
    "reports catching up for %s instead of claiming the conversation is empty", async reason => {
      const { open } = fixture({ ...metadata, historyHeads: reason === "missing" ? [] : [{ ...metadata.historyHeads[0], incompleteReason: reason }] });
      await copyChatTranscript(chat, "full", {});
      expect(output.toast.info).toHaveBeenCalledWith(expect.stringMatching(/still syncing/i),
        expect.objectContaining({ action: expect.objectContaining({ label: "Retry" }) }));
      expect(output.toast.info).not.toHaveBeenCalledWith("This chat has no messages yet.");
      expect(output.copy).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("does not treat an incomplete older page as proof that the full transcript was copied", async () => {
    const { client, open } = fixture();
    await expect(bridgeMessageWindowOlder(client, chat, 1000, "new-prompt")).rejects.toMatchObject({ code: "cloud_history_incomplete" });
    expect(open).not.toHaveBeenCalled();
  });

  it("still reports an authenticated deletion as known empty", async () => {
    fixture({ ...metadata, historyHeads: [{ ...metadata.historyHeads[0], deleted: true,
      source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "delete" } }] });
    await copyChatTranscript(chat, "full", {});
    expect(output.toast.info).toHaveBeenCalledWith("This chat has no messages yet.");
    expect(output.copy).not.toHaveBeenCalled();
  });
});

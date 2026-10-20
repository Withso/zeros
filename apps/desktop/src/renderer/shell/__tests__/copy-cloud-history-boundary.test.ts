import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import { cloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import { readCloudWorkspaceHistory } from "../../platform/cloud-history";
import { setActiveBridge } from "../../platform/bridge/active-bridge";
import { copyChatTranscript } from "../copy-chat-transcript";

const out = vi.hoisted(() => ({ request: vi.fn(), copy: vi.fn(async () => true),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("../../platform/cloud-workspaces", async () => ({
  ...await import("../../platform/cloud-workspace-contract"), cloudAccountRequest: out.request,
}));
vi.mock("../../shared/lib/clipboard", () => ({ copyToClipboardWithFallback: out.copy }));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: out.toast }));
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const identity = { ...target, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", generation: 1,
  engineInstanceId: "33333333-3333-4333-8333-333333333333", bootId: "44444444-4444-4444-8444-444444444444",
  writerEpoch: "55555555-5555-4555-8555-555555555555", fundingOwnerUserId: "66666666-6666-4666-8666-666666666666", fundingOwnerEpoch: 1 };
const binding = CloudAgentBootConversationSchema.parse({ ...identity, authorityEpoch: 1, cacheRevision: 1, desiredCacheRevision: 1,
  initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) });
const clients: WorkspaceRuntimeClient[] = [];
afterEach(() => { setActiveBridge(null); for (const client of clients.splice(0)) client.dispose(); vi.clearAllMocks(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("copy through the actual authenticated CP history reader", () => {
  it.each(["available", "capture_conflict", "deleted", "forbidden"])("preserves %s source semantics after the native retry boundary", async state => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5);
    const readError = vi.spyOn(console, "error").mockImplementation(() => {});
    const projection = { ...identity, mirroredSequence: 20, sealedSequence: state === "capture_conflict" ? null : 20, complete: state !== "capture_conflict" };
    const head = { conversationId: "chat", originWriterEpoch: identity.writerEpoch, restoreRevision: 1,
      source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: state === "deleted" ? "delete" : "edit" },
      deleted: state === "deleted", recordSequence: state === "capture_conflict" ? null : 10,
      eventSequence: state === "capture_conflict" ? null : 10, manifestSha256: state === "capture_conflict" ? null : "a".repeat(64),
      incompleteReason: state === "capture_conflict" ? "capture_conflict" : null };
    const rows = [{ msgId: "saved", kind: "text", createdAt: 1, payload: JSON.stringify({ id: "saved", kind: "text", role: "agent", text: "Saved answer", createdAt: 1 }) }];
    out.request.mockImplementation(async (path, schema) => schema.parse(path.includes("/messages/")
      ? { ...target, revision: 20, messages: rows, projection, historyHeads: [head] }
      : { ...target, revision: 20, chats: [], chatDeletions: [], nextCursor: null, projection, historyHeads: [] }));
    const request = vi.fn(async (message: { op?: string }) => message.op === "chats.list"
      ? { type: "WORKSPACE_RESPONSE", op: message.op, result: { chats: [], chatDeletions: [], projection, historyHeads: [] } }
      : { type: "WORKSPACE_ERROR", op: message.op, code: state === "forbidden" ? "CLOUD_ACTOR_FORBIDDEN" : "command_conflict", message: "Closed refusal" });
    const client = new WorkspaceRuntimeClient({ workspaces: () => [], readHistory: readCloudWorkspaceHistory,
      open: async () => ({ scope: { ...target, root: "/workspace/repo", engineWorkspaceId: "main" }, runtimeId: "copy-boundary", generation: 1, release: () => {},
        client: { request, status: "connected", activatedCloudAgentBootBinding: binding,
          executionIdentity: { kind: "cloud", ...target, generation: 1, engineInstanceId: identity.engineInstanceId, authorityEpoch: 1, bootScope: identity },
          on: () => () => {}, onStatusChange: () => () => {},
        } as unknown as RuntimeClient }),
    });
    clients.push(client); setActiveBridge(client); await client.warmWorkspace(target);
    await vi.advanceTimersByTimeAsync(0); request.mockClear(); out.request.mockClear();
    const pending = copyChatTranscript(cloudScopedId(target, "chat"), "full", {});
    await vi.advanceTimersByTimeAsync(8_000); await pending;
    expect(request).toHaveBeenCalledTimes(state === "forbidden" ? 1 : 5);
    if (state !== "forbidden") expect(readError.mock.calls).toEqual([]);
    if (state === "available") {
      expect(out.copy).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Saved answer"));
      expect(out.toast.warning).toHaveBeenCalledWith(expect.stringMatching(/partial history/));
    } else {
      expect(out.copy).not.toHaveBeenCalled();
      if (state === "capture_conflict") expect(out.toast.info).toHaveBeenCalledWith(expect.stringMatching(/still syncing/),
        expect.objectContaining({ action: expect.objectContaining({ label: "Retry" }) }));
      if (state === "deleted") expect(out.toast.info).toHaveBeenCalledWith("This chat has no messages yet.");
      if (state === "forbidden") expect(out.request).not.toHaveBeenCalled();
    }
    expect(out.toast.success).not.toHaveBeenCalled();
  });
});

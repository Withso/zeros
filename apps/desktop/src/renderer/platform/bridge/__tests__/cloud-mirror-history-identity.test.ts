import { describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient } from "../workspace-runtime-client";
import { cloudScopedId, cloudWorkspaceKey } from "../cloud-workspace-key";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const root = "/home/user/Owner/repo";

/** The control plane stores the worker's rows as received: native chat IDs
 * and native checkout folders. */
function nativeMirror() {
  return vi.fn(async (_target: unknown, op: string, params: Record<string, unknown>) => {
    if (op === "chats.list") return {
      chats: [
        { id: "native-chat", folder: root, title: "Saved", agentId: "codex" },
        { id: "nested-chat", folder: `${root}/packages/app`, title: "Nested", agentId: "claude" },
      ],
      chatDeletions: ["gone"],
    };
    if (op === "messages.window" || op === "messages.windowOlder")
      return { messages: params.chatId === "native-chat" ? [{ msgId: "m1", kind: "text", payload: "{\"text\":\"hello\"}", createdAt: 1 }] : [] };
    throw new Error(`unexpected ${op}`);
  });
}

function stoppedClient(readHistory: ReturnType<typeof nativeMirror>, historyRoot: () => string | undefined = () => root) {
  const open = vi.fn(async () => { throw new Error("VM must stay stopped"); });
  return { open, client: new WorkspaceRuntimeClient({ open, readHistory, historyRoot, workspaces: () => [] }) };
}

describe("stopped cloud workspace mirror identities", () => {
  it("scopes native mirror chats and folders to their cloud owner", async () => {
    const readHistory = nativeMirror();
    const { open, client } = stoppedClient(readHistory);
    try {
      const reply = await client.request({ type: "WORKSPACE_REQUEST", op: "chats.list", params: { workspaceId: cloudWorkspaceKey(target) } });
      expect(reply).toMatchObject({ result: {
        chats: [
          { id: cloudScopedId(target, "native-chat"), folder: cloudWorkspaceKey(target), title: "Saved" },
          { id: cloudScopedId(target, "nested-chat"), folder: `${cloudWorkspaceKey(target)}/packages/app`, title: "Nested" },
        ],
        chatDeletions: [cloudScopedId(target, "gone")],
      } });
      expect(open).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });

  it("reads current and older transcript pages by the native chat ID", async () => {
    const readHistory = nativeMirror();
    const { open, client } = stoppedClient(readHistory);
    const chatId = cloudScopedId(target, "native-chat");
    try {
      const page = await client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params: { chatId, limit: 50 } });
      expect(readHistory).toHaveBeenLastCalledWith(expect.objectContaining(target), "messages.window", { chatId: "native-chat", limit: 50 });
      expect(page).toMatchObject({ result: { messages: [{ msgId: "m1", payload: "{\"text\":\"hello\"}" }] } });
      const older = await client.request({ type: "WORKSPACE_REQUEST", op: "messages.windowOlder", params: { chatId, beforeMsgId: "m1", limit: 50 } });
      expect(readHistory).toHaveBeenLastCalledWith(expect.objectContaining(target), "messages.windowOlder", { chatId: "native-chat", beforeMsgId: "m1", limit: 50 });
      expect(older).toMatchObject({ result: { messages: [{ msgId: "m1" }] } });
      expect(open).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });

  it("refuses a mirror read whose cloud owner has no confirmed checkout", async () => {
    const readHistory = nativeMirror();
    const { client } = stoppedClient(readHistory, () => undefined);
    try {
      await expect(client.request({ type: "WORKSPACE_REQUEST", op: "messages.window",
        params: { chatId: cloudScopedId(target, "native-chat"), limit: 50 } })).rejects.toThrow(/history/i);
      expect(readHistory).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });

  it("refuses a chat ID owned by another cloud workspace before reading", async () => {
    const readHistory = nativeMirror();
    const { client } = stoppedClient(readHistory);
    const other = { ...target, workspaceId: "33333333-3333-4333-8333-333333333333" };
    try {
      await expect(client.request({ type: "WORKSPACE_REQUEST", op: "messages.window",
        params: { workspaceId: cloudWorkspaceKey(target), chatId: cloudScopedId(other, "native-chat"), limit: 50 } })).rejects.toThrow();
      expect(readHistory).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });
});

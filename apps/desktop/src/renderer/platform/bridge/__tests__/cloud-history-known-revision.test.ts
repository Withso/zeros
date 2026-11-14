import { describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient } from "../workspace-runtime-client";
import { cloudScopedId, cloudWorkspaceKey } from "../cloud-workspace-key";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chat = (id: string, historyCache?: unknown) => ({ id, folder: "/home/user/Owner/repo", title: id, ...(historyCache ? { historyCache } : {}) });

// Launch slice: a transcript read carries the chat's revision from the chats.list snapshot that proved access, so the
// local transcript cache answers an unchanged chat with no read and continues a changed one once.
describe("mirror transcript reads carry the chats.list revision", () => {
  it("passes historyCache for a listed chat, and nothing for an unlisted chat, an older page or an N-1 row", async () => {
    const readHistory = vi.fn(async (_target: unknown, op: string) => op === "chats.list"
      ? { chats: [chat("fresh", { revision: 7, messageCount: 12 }), chat("legacy"), chat("bad", { revision: -1, messageCount: 1 })] }
      : { messages: [] });
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), readHistory, historyRoot: () => "/home/user/Owner/repo", workspaces: () => [] });
    const window = (chatId: string, extra: Record<string, unknown> = {}) => client.request({ type: "WORKSPACE_REQUEST", op: "messages.window",
      params: { chatId: cloudScopedId(target, chatId), limit: 200, ...extra } });
    try {
      await client.request({ type: "WORKSPACE_REQUEST", op: "chats.list", params: { folder: cloudWorkspaceKey(target) } });
      await client.warmHistoryWorkspace(target);
      for (const id of ["fresh", "legacy", "bad", "unlisted"]) await window(id);
      await window("fresh", { before: 3 });
      const options = (id: string, before?: number) => readHistory.mock.calls.find(([, op, params]) => op === "messages.window" &&
        (params as { chatId: string }).chatId === id && (params as { before?: number }).before === before)?.[3];
      expect(options("fresh")).toEqual({ known: { revision: 7, messageCount: 12 } });
      for (const id of ["legacy", "bad", "unlisted"]) expect(options(id)).toBeUndefined();
      expect(options("fresh", 3)).toBeUndefined();
    } finally { client.dispose(); }
  });
});

import { describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient } from "../workspace-runtime-client";
import { cloudScopedId, cloudWorkspaceKey } from "../cloud-workspace-key";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chat = (id: string, historyCache?: unknown) => ({ id, folder: "/home/user/Owner/repo", title: id, ...(historyCache ? { historyCache } : {}) });

// Launch slice: a transcript read carries the chat's revision from the chats.list snapshot that proved access, so the
// local transcript cache answers an unchanged chat with no read and continues a changed one once.
describe("mirror transcript reads carry the chats.list revision", () => {
  it("passes historyCache for a listed chat, and nothing for an unlisted chat, an older page or an N-1 row", async () => {
    const readHistory = vi.fn(async (_target: unknown, op: string, _params?: Record<string, unknown>, _options?: unknown) => op === "chats.list"
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

  it("restored transcripts read before any chats.list join one list read for their workspace", async () => {
    let release!: () => void, admitted!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const listAdmitted = new Promise<void>(resolve => { admitted = resolve; });
    const readHistory = vi.fn(async (_target: unknown, op: string, _params?: Record<string, unknown>, _options?: unknown) => {
      if (op !== "chats.list") return { messages: [] };
      admitted();
      await held;
      return { chats: ["a", "b", "c"].map(id => chat(id, { revision: 1, messageCount: 1 })) };
    });
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), readHistory, historyRoot: () => "/home/user/Owner/repo", workspaces: () => [] });
    try {
      const reads = ["a", "b", "c"].map(id => client.request({ type: "WORKSPACE_REQUEST", op: "messages.window",
        params: { chatId: cloudScopedId(target, id), limit: 200 } }));
      // The race window is open: the one list read is held and no transcript read has started.
      await listAdmitted;
      expect(readHistory.mock.calls.filter(([, op]) => op === "chats.list")).toHaveLength(1);
      expect(readHistory.mock.calls.filter(([, op]) => op === "messages.window")).toEqual([]);
      release(); await Promise.all(reads);
      expect(readHistory.mock.calls.filter(([, op]) => op === "chats.list")).toHaveLength(1);
      expect(readHistory.mock.calls.filter(([, op]) => op === "messages.window").map(call => call[3]))
        .toEqual(Array(3).fill({ known: { revision: 1, messageCount: 1 } }));
    } finally { client.dispose(); }
  });

  it("an invalidated chats.list never supplies the revision: it is re-read first, and a failed re-read supplies none", async () => {
    let revision = 7, failList = false;
    const readHistory = vi.fn(async (_target: unknown, op: string, _params?: Record<string, unknown>, _options?: unknown) => {
      if (op !== "chats.list") return { messages: [] };
      if (failList) throw new Error("offline");
      return { chats: [chat("a", { revision, messageCount: revision })] };
    });
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), readHistory, historyRoot: () => "/home/user/Owner/repo", workspaces: () => [] });
    const window = (limit: number) => client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params: { chatId: cloudScopedId(target, "a"), limit } });
    const lastKnown = () => readHistory.mock.calls.filter(([, op]) => op === "messages.window").at(-1)?.[3];
    try {
      await window(200);
      expect(lastKnown()).toEqual({ known: { revision: 7, messageCount: 7 } });
      // A change event: the server moved the chat to revision 8.
      revision = 8; client.refreshHistoryWorkspace(target);
      await window(199);
      expect(lastKnown()).toEqual({ known: { revision: 8, messageCount: 8 } });
      revision = 9; client.refreshHistoryWorkspace(target); failList = true;
      await window(198);
      expect(lastKnown()).toBeUndefined();
    } finally { client.dispose(); }
  });
});


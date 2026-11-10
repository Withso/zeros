import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  generation: 1,
  documents: new Map<string, { capabilities: { chatEdits?: 1 } }>(),
  calls: [] as Array<{ workspaceId: string; chatId: string; change: unknown }>,
  replies: [] as Array<{ resolve(value: unknown): void; reject(error: unknown): void }>,
  toasts: [] as Array<{ title: string; description?: string }>,
}));
vi.mock("../../features/team/team-store", async original => ({
  ...await original<typeof import("../../features/team/team-store")>(), getOrganizationStoreGeneration: () => control.generation,
}));
vi.mock("../cloud-workspace-catalog", async original => ({
  ...await original<typeof import("../cloud-workspace-catalog")>(),
  cloudWorkspaceDocument: (target: { organizationId: string; workspaceId: string }) => control.documents.get(`${target.organizationId}/${target.workspaceId}`),
}));
vi.mock("../../platform/cloud-v2", async original => ({
  ...await original<typeof import("../../platform/cloud-v2")>(),
  editCloudV2Chat: (target: { workspaceId: string }, chatId: string, change: unknown) => {
    control.calls.push({ workspaceId: target.workspaceId, chatId, change });
    return new Promise((resolve, reject) => { control.replies.push({ resolve, reject }); });
  },
}));
vi.mock("../../shared/ui/primitives/elements", async original => ({
  ...await original<typeof import("../../shared/ui/primitives/elements")>(),
  toast: { error: (title: string, options?: { description?: string }) => { control.toasts.push({ title, description: options?.description }); } },
}));
import { useWorkspaceStore } from "../workspace-store";
import { editChat, hasPendingCloudChatEdit, onCloudChatEditFallback } from "../cloud-chat-edits";
import type { ChatThread } from "../store";

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.window === "undefined") g.window = { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {} };
  if (typeof g.localStorage === "undefined") {
    const store = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };
  }
});

const org = "11111111-1111-4111-8111-111111111111", ws = "22222222-2222-4222-8222-222222222222", other = "33333333-3333-4333-8333-333333333333";
const folder = (workspace: string) => `cloud://${org}/${workspace}`;
const id = (workspace: string, chat: string) => `cloud:${org}:${workspace}:${chat}`;
const chat = (chatId: string, chatFolder: string, extra: Partial<ChatThread> = {}): ChatThread =>
  ({ id: chatId, folder: chatFolder, title: "Original", archived: false, createdAt: 1, updatedAt: 1, agentId: "codex", ...extra }) as ChatThread;
const dispatch = (action: Parameters<ReturnType<typeof useWorkspaceStore.getState>["dispatch"]>[0]) => useWorkspaceStore.getState().dispatch(action);
const row = (chatId: string) => useWorkspaceStore.getState().chats.find(item => item.id === chatId)!;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const refused = (code: string, message: string) => Object.assign(new Error(message), { status: 409, code });

beforeEach(() => {
  control.generation = 1; control.calls = []; control.replies = []; control.toasts = [];
  control.documents = new Map([[`${org}/${ws}`, { capabilities: { chatEdits: 1 } }], [`${org}/${other}`, { capabilities: {} }]]);
  for (const existing of [...useWorkspaceStore.getState().chats]) dispatch({ type: "DELETE_CHAT", id: existing.id });
  for (const added of [chat(id(ws, "a"), folder(ws)), chat(id(ws, "b"), folder(ws)), chat(id(other, "c"), folder(other)), chat("local-chat", "/local/repo")])
    dispatch({ type: "ADD_CHAT", chat: added });
});

describe("chat rename and archive through the control plane", () => {
  it("leaves Local chats and cloud workspaces without chatEdits on today's path", async () => {
    editChat(dispatch, "local-chat", { title: "Local rename" });
    editChat(dispatch, id(other, "c"), { archived: true });
    expect(row("local-chat").title).toBe("Local rename");
    expect(row(id(other, "c")).archived).toBe(true);
    expect(control.calls).toEqual([]);
    expect(hasPendingCloudChatEdit("local-chat") || hasPendingCloudChatEdit(id(other, "c"))).toBe(false);
  });

  it("shows a rename at once, sends the worker's chat id, and holds the row from the worker mirror until the route answers", async () => {
    editChat(dispatch, id(ws, "a"), { title: "Renamed" });
    expect(row(id(ws, "a")).title).toBe("Renamed");
    expect(control.calls).toEqual([{ workspaceId: ws, chatId: "a", change: { title: "Renamed" } }]);
    expect(hasPendingCloudChatEdit(id(ws, "a"))).toBe(true);
    expect(hasPendingCloudChatEdit(id(ws, "b"))).toBe(false);
    control.replies[0]!.resolve({ id: "a", title: "Renamed", archived: false }); await settle();
    expect(hasPendingCloudChatEdit(id(ws, "a"))).toBe(false);
    expect(row(id(ws, "a")).title).toBe("Renamed");
    expect(control.toasts).toEqual([]);
  });

  it("reverts a refused archive or unarchive with a toast", async () => {
    editChat(dispatch, id(ws, "a"), { archived: true });
    expect(row(id(ws, "a")).archived).toBe(true);
    control.replies[0]!.reject(refused("worker_update_required", "Restart the workspace to update it.")); await settle();
    expect(row(id(ws, "a")).archived).toBe(false);
    expect(control.toasts).toEqual([{ title: "Couldn't close the chat", description: "Restart the workspace to update it." }]);
    dispatch({ type: "ARCHIVE_CHAT", id: id(ws, "b") });
    editChat(dispatch, id(ws, "b"), { archived: false });
    expect(row(id(ws, "b")).archived).toBe(false);
    control.replies[1]!.reject(refused("worker_update_required", "Restart the workspace to update it.")); await settle();
    expect(row(id(ws, "b")).archived).toBe(true);
  });

  it("fences a late refusal behind a newer edit of the same chat, and keeps other chats apart", async () => {
    editChat(dispatch, id(ws, "a"), { title: "First" });
    editChat(dispatch, id(ws, "b"), { title: "Other chat" });
    editChat(dispatch, id(ws, "a"), { title: "Second" });
    control.replies[2]!.resolve({ id: "a", title: "Second", archived: false }); await settle();
    control.replies[0]!.reject(refused("session_busy", "Late.")); await settle();
    expect(row(id(ws, "a")).title).toBe("Second");
    expect(row(id(ws, "b")).title).toBe("Other chat");
    expect(control.toasts).toEqual([]);
    control.replies[1]!.reject(refused("session_busy", "Refused.")); await settle();
    expect(row(id(ws, "b")).title).toBe("Original");
  });

  it("does not revert a value the user changed again, nor after the account changed", async () => {
    editChat(dispatch, id(ws, "a"), { title: "Mine" });
    dispatch({ type: "UPDATE_CHAT_TITLE", id: id(ws, "a"), title: "Typed again locally" });
    control.replies[0]!.reject(refused("session_busy", "No.")); await settle();
    expect(row(id(ws, "a")).title).toBe("Typed again locally");
    editChat(dispatch, id(ws, "b"), { archived: true });
    control.generation = 2;
    control.replies[1]!.reject(new Error("Your account changed")); await settle();
    expect(row(id(ws, "b")).archived).toBe(true);
    expect(hasPendingCloudChatEdit(id(ws, "b"))).toBe(false);
  });

  it("closes a busy chat exactly as before: the known-working close never asks the route", async () => {
    editChat(dispatch, id(ws, "a"), { archived: true }, { busy: true });
    expect(row(id(ws, "a")).archived).toBe(true);
    expect(control.calls).toEqual([]);
    expect(hasPendingCloudChatEdit(id(ws, "a"))).toBe(false);
  });

  it("keeps a close the route calls busy, without a toast, and hands the row back to the worker mirror", async () => {
    const fallbacks: string[] = [];
    const stop = onCloudChatEditFallback(chatId => fallbacks.push(chatId));
    try {
      editChat(dispatch, id(ws, "a"), { archived: true });
      expect(hasPendingCloudChatEdit(id(ws, "a"))).toBe(true);
      control.replies[0]!.reject(refused("session_busy", "Stop the agent first.")); await settle();
      expect(row(id(ws, "a")).archived).toBe(true);
      expect(control.toasts).toEqual([]);
      expect(hasPendingCloudChatEdit(id(ws, "a"))).toBe(false);
      expect(fallbacks).toEqual([id(ws, "a")]);
      // A rename the route refuses as busy is still reverted: only Close had a busy path before.
      editChat(dispatch, id(ws, "b"), { title: "Busy rename" });
      control.replies[1]!.reject(refused("session_busy", "Busy.")); await settle();
      expect(row(id(ws, "b")).title).toBe("Original");
      expect(fallbacks).toEqual([id(ws, "a")]);
    } finally { stop(); }
  });
});

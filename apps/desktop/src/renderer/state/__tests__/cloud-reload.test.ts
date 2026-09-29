import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloudScopedId, cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { sanitizeCachedChat } from "../chat-boot-cache";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = cloudWorkspaceKey(target);
const id = cloudScopedId(target, "remembered");
const local = sanitizeCachedChat({ id: "local", folder: "/repo/local" })!;
const remote = sanitizeCachedChat({ id, folder, title: "Remembered" })!;
let storage: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  storage = new Map([
    ["zeros-chats-v1", JSON.stringify([local])],
    ["zeros:ui-state:v1", JSON.stringify({ activePage: "workspace", activeChatId: id, lastWorkspaceFolder: folder, activeChatByFolder: { [folder]: id } })],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, localStorage });
});
afterEach(() => vi.unstubAllGlobals());

it("boots into the saved cloud identity without exposing Local or inventing a chat", async () => {
  const { useWorkspaceStore, selectActiveFolder } = await import("../workspace-store");
  expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(folder);
  expect(useWorkspaceStore.getState()).toMatchObject({ activeChatId: id, pendingWorkspaceValidationFolder: folder });
  expect(useWorkspaceStore.getState().chats).toEqual([local]);
  useWorkspaceStore.getState().dispatch({ type: "MERGE_CHATS", chats: [remote] });
  expect(useWorkspaceStore.getState().activeChatId).toBe(id);
  expect(useWorkspaceStore.getState().pendingWorkspaceValidationFolder).toBe(folder);
});

it("only clears cloud startup validation with that workspace's confirmed chat snapshot", async () => {
  const { useWorkspaceStore } = await import("../workspace-store");
  const { dispatch } = useWorkspaceStore.getState();
  dispatch({ type: "HYDRATE_CHATS", chats: [local], activeChatId: id, confirmedCloudWorkspaces: [] });
  expect(useWorkspaceStore.getState().pendingWorkspaceValidationFolder).toBe(folder);
  dispatch({ type: "HYDRATE_CHATS", chats: [local, remote], activeChatId: id, confirmedCloudWorkspaces: [folder] });
  expect(useWorkspaceStore.getState()).toMatchObject({ activeChatId: id, pendingWorkspaceValidationFolder: null });
});

it("a late cloud hydrate preserves a newer Local selection", async () => {
  const { useWorkspaceStore, selectActiveFolder } = await import("../workspace-store");
  const { dispatch } = useWorkspaceStore.getState();
  dispatch({ type: "OPEN_WORKSPACE", folder: local.folder, repoRoot: "/repo", chatId: local.id });
  dispatch({ type: "MERGE_CHATS", chats: [remote] });
  expect(useWorkspaceStore.getState().activeChatId).toBe(local.id);
  expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(local.folder);
});

it("revalidates mounted cloud history without losing its destination during a renderer refresh", async () => {
  const { useWorkspaceStore, selectActiveFolder } = await import("../workspace-store");
  const { dispatch } = useWorkspaceStore.getState();
  dispatch({ type: "HYDRATE_CHATS", chats: [local, remote], activeChatId: id, confirmedCloudWorkspaces: [folder] });
  expect(useWorkspaceStore.getState().pendingChatHydrationFolder).toBeNull();
  dispatch({ type: "REVALIDATE_CLOUD_CHATS" });
  expect(useWorkspaceStore.getState().chats).toEqual([local]);
  expect(useWorkspaceStore.getState()).toMatchObject({ activePage: "workspace", activeChatId: id, pendingChatHydrationFolder: folder, pendingWorkspaceValidationFolder: folder });
  expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(folder);
  expect(useWorkspaceStore.getState().activeChatByFolder[folder]).toBe(id);
  dispatch({ type: "MERGE_CHATS", chats: [remote] });
  expect(useWorkspaceStore.getState().activeChatId).toBe(id);
});

it("does not put a selected Local chat into loading when cloud history revalidates", async () => {
  const { useWorkspaceStore, selectActiveFolder } = await import("../workspace-store");
  const { dispatch } = useWorkspaceStore.getState();
  dispatch({ type: "HYDRATE_CHATS", chats: [local, remote], activeChatId: id, confirmedCloudWorkspaces: [folder] });
  dispatch({ type: "OPEN_WORKSPACE", folder: local.folder, repoRoot: "/repo", chatId: local.id });
  dispatch({ type: "REVALIDATE_CLOUD_CHATS" });
  expect(useWorkspaceStore.getState().chats).toEqual([local]);
  expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(local.folder);
  expect(useWorkspaceStore.getState()).toMatchObject({ activeChatId: local.id, pendingChatHydrationFolder: null, pendingWorkspaceValidationFolder: null });
});

it("preserves Local chat and terminal identity on reload", async () => {
  storage.set("zeros:ui-state:v1", JSON.stringify({ activePage: "workspace", activeChatId: "terminal", lastWorkspaceFolder: local.folder }));
  storage.set("zeros-chats-v1", JSON.stringify([local, { ...local, id: "terminal", kind: "terminal" }]));
  const { useWorkspaceStore, selectActiveFolder } = await import("../workspace-store");
  expect(useWorkspaceStore.getState().activeChatId).toBe("terminal");
  expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(local.folder);
});

it("waits for Local history when a workspace is known but its boot chat cache is empty", async () => {
  storage.set("zeros:ui-state:v1", JSON.stringify({ activePage: "workspace", activeChatId: local.id, lastWorkspaceFolder: local.folder }));
  storage.set("zeros-chats-v1", JSON.stringify([]));
  const { useWorkspaceStore, selectActiveFolder } = await import("../workspace-store");
  expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(local.folder);
  expect(useWorkspaceStore.getState().pendingChatHydrationFolder).toBe(local.folder);
  useWorkspaceStore.getState().dispatch({ type: "CONFIRM_WORKSPACE_TARGET", folder: local.folder });
  expect(useWorkspaceStore.getState().pendingChatHydrationFolder).toBe(local.folder);
  useWorkspaceStore.getState().dispatch({ type: "HYDRATE_CHATS", chats: [local], activeChatId: local.id, confirmedCloudWorkspaces: [] });
  expect(useWorkspaceStore.getState().pendingChatHydrationFolder).toBeNull();
  expect(useWorkspaceStore.getState().chats).toEqual([local]);
});

it("clears a deleted or unauthorized cloud selection atomically, even before chats load", async () => {
  const { useWorkspaceStore, selectActiveFolder } = await import("../workspace-store");
  const snapshots: unknown[] = [];
  const off = useWorkspaceStore.subscribe(state => snapshots.push([state.activePage, selectActiveFolder(state), state.activeChatId]));
  useWorkspaceStore.getState().dispatch({ type: "PRUNE_CLOUD_WORKSPACES", folders: [folder] });
  off();
  expect(snapshots).toEqual([["dashboard", null, null]]);
  expect(useWorkspaceStore.getState().chats).toEqual([local]);
  expect(useWorkspaceStore.getState().activeChatByFolder[folder]).toBeUndefined();
});

it("cloud account cleanup does not move a Local selection or delete its history", async () => {
  const { useWorkspaceStore, selectActiveFolder } = await import("../workspace-store");
  const { dispatch } = useWorkspaceStore.getState();
  dispatch({ type: "MERGE_CHATS", chats: [remote] });
  dispatch({ type: "OPEN_WORKSPACE", folder: local.folder, repoRoot: "/repo", chatId: local.id });
  dispatch({ type: "PRUNE_CLOUD_WORKSPACES", folders: [folder] });
  expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(local.folder);
  expect(useWorkspaceStore.getState().activePage).toBe("workspace");
  expect(useWorkspaceStore.getState().chats).toEqual([local]);
});

it("a cloud-only hydrate keeps a Local boot destination pending until Local confirms it", async () => {
  storage.set("zeros:ui-state:v1", JSON.stringify({ activePage: "workspace", activeChatId: local.id, lastWorkspaceFolder: local.folder }));
  storage.set("zeros-chats-v1", JSON.stringify([]));
  const { useWorkspaceStore, selectActiveFolder } = await import("../workspace-store");
  const { resolveBootActiveChatId } = await import("../boot-active-chat");
  const { dispatch } = useWorkspaceStore.getState();
  const activeChatId = resolveBootActiveChatId([remote], local.id, { lastWorkspaceFolder: local.folder, activeChatByFolder: {}, confirmedLocalChats: false, confirmedCloudWorkspaces: [folder] });
  dispatch({ type: "HYDRATE_CHATS", chats: [remote], activeChatId, confirmedLocalChats: false, confirmedCloudWorkspaces: [folder] });
  expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(local.folder);
  expect(useWorkspaceStore.getState().pendingChatHydrationFolder).toBe(local.folder);
  dispatch({ type: "HYDRATE_CHATS", chats: [local, remote], activeChatId: local.id, confirmedLocalChats: true, confirmedCloudWorkspaces: [folder] });
  expect(useWorkspaceStore.getState().pendingChatHydrationFolder).toBeNull();
});

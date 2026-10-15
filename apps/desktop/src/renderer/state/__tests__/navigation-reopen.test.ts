import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudScopedId, cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { resolveBootActiveChatId } from "../boot-active-chat";
import { sanitizeCachedChat } from "../chat-boot-cache";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const destinations = [
  { placement: "Personal Local", folder: "/personal/project", id: "personal-chat", other: "personal-other" },
  { placement: "organization Local", folder: "/organization/project", id: "organization-chat", other: "organization-other" },
  { placement: "organization cloud", folder: cloudWorkspaceKey(target), id: cloudScopedId(target, "saved"), other: cloudScopedId(target, "other") },
];
const chat = (id: string, folder: string, archived = false) => sanitizeCachedChat({ id, folder, archived })!;
let storage: Map<string, string>;
let unload: Set<() => void>;
beforeEach(() => {
  vi.resetModules();
  storage = new Map();
  unload = new Set();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal("window", { localStorage, setTimeout: () => 1, clearTimeout: () => {},
    addEventListener: (name: string, callback: () => void) => { if (name === "beforeunload") unload.add(callback); } });
});
afterEach(() => vi.unstubAllGlobals());

describe("same workspace and chat on reopen", () => {
  for (const destination of destinations) {
    it.each(["active id", "workspace memory"])(`restores ${destination.placement} from %s before its saved row arrives`, async source => {
      const { folder, id, other } = destination;
      storage.set("zeros:ui-state:v1", JSON.stringify({ activePage: "workspace", lastWorkspaceFolder: folder,
        activeChatId: source === "active id" ? id : null, activeChatByFolder: { [folder]: id } }));
      // A partial cache is not proof that the saved chat was deleted. The newer
      // sibling must not replace the user's selection during synchronous boot.
      storage.set("zeros-chats-v1", JSON.stringify([chat(other, folder)]));
      const { useWorkspaceStore, selectActiveFolder } = await import("../workspace-store");
      expect(useWorkspaceStore.getState().activeChatId).toBe(id);
      expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(folder);
      expect(useWorkspaceStore.getState().pendingChatHydrationFolder).toBe(folder);
    });

    it(`persists A → B → A and reopens ${destination.placement} with a cold chat cache`, async () => {
      const { folder, id } = destination;
      const b = destinations.find(row => row.folder !== folder)!;
      storage.set("zeros:ui-state:v1", JSON.stringify({ activePage: "workspace", activeChatId: id, lastWorkspaceFolder: folder }));
      storage.set("zeros-chats-v1", JSON.stringify([chat(id, folder), chat(b.id, b.folder)]));
      const { useWorkspaceStore, selectActiveFolder } = await import("../workspace-store");
      const { dispatch } = useWorkspaceStore.getState();
      dispatch({ type: "MERGE_CHATS", chats: [chat(id, folder), chat(b.id, b.folder)] });
      const snapshots: unknown[] = [];
      const off = useWorkspaceStore.subscribe(state => snapshots.push([selectActiveFolder(state), state.activeChatId]));
      dispatch({ type: "OPEN_WORKSPACE", folder: b.folder, repoRoot: b.folder, chatId: b.id });
      dispatch({ type: "OPEN_WORKSPACE", folder, repoRoot: folder, chatId: id });
      off();
      expect(snapshots).toEqual([[b.folder, b.id], [folder, id]]);
      for (const flush of unload) flush();
      expect(JSON.parse(storage.get("zeros:ui-state:v1")!)).toMatchObject({ activeChatId: id, lastWorkspaceFolder: folder });
      storage.set("zeros-chats-v1", "[]");
      vi.resetModules();
      const reopened = await import("../workspace-store");
      expect(reopened.useWorkspaceStore.getState().activeChatId).toBe(id);
      expect(reopened.selectActiveFolder(reopened.useWorkspaceStore.getState())).toBe(folder);
    });
  }

  it("still rejects a known archived Local chat before the database responds", () => {
    const { id, folder, other } = destinations[0]!;
    const rows = [chat(id, folder, true), chat(other, folder)];
    for (const persisted of [id, null]) {
      expect(resolveBootActiveChatId(rows, persisted, { lastWorkspaceFolder: folder,
        activeChatByFolder: { [folder]: id }, confirmedLocalChats: false })).toBe(other);
    }
  });

  it("does not restore a remembered chat into the wrong Local owner", () => {
    const { id, folder, other } = destinations[0]!;
    expect(resolveBootActiveChatId([chat(id, destinations[1]!.folder), chat(other, folder)], null, {
      lastWorkspaceFolder: folder, activeChatByFolder: { [folder]: id }, confirmedLocalChats: false,
    })).toBe(other);
    expect(resolveBootActiveChatId([chat(other, folder)], null, {
      lastWorkspaceFolder: folder, activeChatByFolder: { [folder]: destinations[2]!.id }, confirmedLocalChats: false,
    })).toBe(other);
  });

  it("waits for the exact placement to confirm deletion before choosing its sibling", () => {
    for (const { id, folder, other } of destinations) {
      const rows = [chat(other, folder)];
      const ctx = { lastWorkspaceFolder: folder, activeChatByFolder: { [folder]: id }, confirmedLocalChats: false };
      expect(resolveBootActiveChatId(rows, id, ctx)).toBe(id);
      expect(resolveBootActiveChatId(rows, id, { ...ctx, confirmedLocalChats: true, confirmedCloudWorkspaces: [folder] })).toBe(other);
    }
  });

  it("does not attach an unscoped missing Local identity to a cloud or unknown owner", () => {
    for (const folder of [destinations[2]!.folder, null]) {
      expect(resolveBootActiveChatId([], destinations[0]!.id, {
        lastWorkspaceFolder: folder, activeChatByFolder: {}, confirmedLocalChats: false,
      })).toBeNull();
    }
  });
});

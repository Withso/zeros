import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setSetting } from "../../platform/settings";
import { setFavoriteModel } from "../../features/agent/model-favorites";
import { newChatBornDefaults } from "../../features/agent/new-chat-defaults";
import { CHATS_STORAGE_KEY } from "../chats-local-cache";
import type { ChatThread } from "../store";
import { useWorkspaceStore } from "../workspace-store";

const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const folders = ["/local/personal", "/local/organization", cloud];
const oldModels = { claude: "claude-opus-5[1m]", codex: "gpt-5.6-sol", cursor: "composer-2.5" };

function chat(folder: string, agentId: string, model: string | null = null): ChatThread {
  return { id: "existing", folder, agentId, agentName: agentId, model, effort: "high", fast: true,
    permissionMode: "auto", title: "Existing conversation", createdAt: 1, updatedAt: 1 };
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {} });
  useWorkspaceStore.setState({ chats: [], activeChatId: null });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("persisted chat models across a catalog default change", () => {
  for (const folder of folders) for (const type of ["HYDRATE_CHATS", "MERGE_CHATS"] as const) {
    it(`${type} freezes old null models in ${folder}`, () => {
      const rows = Object.keys(oldModels).map(agent => ({ ...chat(folder, agent), id: agent }));
      useWorkspaceStore.getState().dispatch({ type, chats: rows, activeChatId: null });
      const restored = useWorkspaceStore.getState().chats;
      expect(restored.map(row => row.model)).toEqual(Object.values(oldModels));
      expect(restored.map(({ model: _model, ...row }) => row)).toEqual(rows.map(({ model: _model, ...row }) => row));
    });

    it(`${type} preserves a confirmed model on repeated hydration in ${folder}`, () => {
      const original = chat(folder, "claude", "claude-opus-5[1m]");
      useWorkspaceStore.setState({ chats: [original] });
      setFavoriteModel("claude", "claude-sonnet-5-5[1m]");
      useWorkspaceStore.getState().dispatch({ type, chats: [{ ...original, model: null, updatedAt: 2 }], activeChatId: null });
      expect(useWorkspaceStore.getState().chats[0]).toMatchObject({ model: original.model, effort: "high", fast: true });
    });
  }

  it("restores the previous explicit favorite when a legacy chat has no concrete model", () => {
    setFavoriteModel("claude", "sonnet");
    useWorkspaceStore.getState().dispatch({ type: "HYDRATE_CHATS", chats: [chat("/local", "claude")], activeChatId: null });
    expect(useWorkspaceStore.getState().chats[0].model).toBe("sonnet");
  });

  it.each(folders)("retains the confirmed objects and array for an unchanged legacy snapshot in %s", folder => {
    const original = chat(folder, "claude");
    const dispatch = useWorkspaceStore.getState().dispatch;
    dispatch({ type: "HYDRATE_CHATS", chats: [original], activeChatId: null });
    const confirmed = useWorkspaceStore.getState().chats;
    dispatch({ type: "HYDRATE_CHATS", chats: [{ ...original }], activeChatId: null });
    expect(useWorkspaceStore.getState().chats[0]).toBe(confirmed[0]);
    expect(useWorkspaceStore.getState().chats).toBe(confirmed);
  });

  it("does not borrow a confirmed model from a different workspace or provider", () => {
    useWorkspaceStore.setState({ chats: [chat("/local", "claude", "claude-sonnet-5-5[1m]")] });
    useWorkspaceStore.getState().dispatch({ type: "HYDRATE_CHATS", chats: [chat(cloud, "claude")], activeChatId: null });
    expect(useWorkspaceStore.getState().chats[0].model).toBe(oldModels.claude);
    useWorkspaceStore.getState().dispatch({ type: "HYDRATE_CHATS", chats: [chat(cloud, "codex")], activeChatId: null });
    expect(useWorkspaceStore.getState().chats[0].model).toBe(oldModels.codex);
  });

  it("leaves explicit aliases, terminal rows, and agentless tabs unchanged", () => {
    const alias = chat("/local", "claude", "opus");
    const terminal = { ...chat("/local", "terminal"), id: "terminal" };
    const unbound = { ...chat("/local", "claude"), id: "unbound", agentId: null, agentName: null };
    useWorkspaceStore.getState().dispatch({ type: "HYDRATE_CHATS", chats: [alias, terminal, unbound], activeChatId: null });
    expect(useWorkspaceStore.getState().chats).toEqual([alias, terminal, unbound]);
    expect(useWorkspaceStore.getState().chats[0]).toBe(alias);
  });

  it("gives a newly born chat the new default without changing an existing model", () => {
    const existing = chat("/local", "claude", oldModels.claude);
    useWorkspaceStore.setState({ chats: [existing] });
    const born = { ...chat("/local", "claude"), id: "new", ...newChatBornDefaults("claude") };
    useWorkspaceStore.getState().dispatch({ type: "ADD_CHAT", chat: born });
    expect(useWorkspaceStore.getState().chats[0]).toBe(existing);
    expect(useWorkspaceStore.getState().chats[1]).toMatchObject({ model: "claude-opus-5-5[1m]", effort: "medium", fast: false });
  });

  it("freezes the prior model of an existing chat whose agent binding needs repair", () => {
    const unbound = { ...chat("/local", "claude"), agentId: null, agentName: "Claude Code", sessionId: "existing-session" };
    useWorkspaceStore.getState().dispatch({ type: "HYDRATE_CHATS", chats: [unbound], activeChatId: null });
    expect(useWorkspaceStore.getState().chats[0]).toMatchObject({ agentId: null, model: oldModels.claude, sessionId: "existing-session" });
  });

  it("freezes a legacy Local model in the synchronous boot cache", async () => {
    setSetting(CHATS_STORAGE_KEY, [chat("/local", "claude")]);
    vi.resetModules();
    const bootStore = (await import("../workspace-store")).useWorkspaceStore;
    expect(bootStore.getState().chats[0]).toMatchObject({ model: oldModels.claude, effort: "high", fast: true });
  });
});

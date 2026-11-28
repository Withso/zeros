import { describe, expect, it, vi } from "vitest";

import {
  bornChatThread,
  spawnDefaultChatForWorkspace,
  spawnNewChatTab,
} from "../spawn-default-chat";
import { useWorkspaceStore, type Action } from "../workspace-store";

describe("chat-tab workspace activity", () => {
  it("starts cloud and Local tabs from the same global default", () => {
    expect(bornChatThread({ id: "codex", name: "Codex" } as never,
      "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222").model).toBe("gpt-6.1-sol");
    const local = bornChatThread({ id: "codex", name: "Codex" } as never, "/local/workspace");
    expect(local).toMatchObject({ model: "gpt-6.1-sol", effort: "max" });
    expect(local).not.toHaveProperty("fast");
  });
  it("records an explicit new tab but not automatic empty-workspace repair", async () => {
    const explicitActions: Action[] = [];
    const explicitFolder = `/explicit-chat-${Date.now()}`;
    await spawnNewChatTab({
      folder: explicitFolder,
      sessions: {} as never,
      dispatch: (action) => explicitActions.push(action),
    });
    expect(explicitActions).toContainEqual(
      expect.objectContaining({
        type: "ADD_CHAT",
        recordWorkspaceActivity: true,
      }),
    );

    const automaticActions: Action[] = [];
    const automaticFolder = `/automatic-chat-${Date.now()}`;
    expect(
      await spawnDefaultChatForWorkspace({
        folder: automaticFolder,
        sessions: {} as never,
        dispatch: vi.fn((action: Action) => automaticActions.push(action)),
      }),
    ).toBe(true);
    expect(automaticActions).toContainEqual(
      expect.objectContaining({ type: "ADD_CHAT" }),
    );
    expect(automaticActions).not.toContainEqual(
      expect.objectContaining({ recordWorkspaceActivity: true }),
    );
  });

  it("starts an ordinary chat when the folder's only open chat is a side chat the column cannot show", async () => {
    const folder = `/side-only-${Date.now()}`;
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, localStorage: storage });
    const side = { ...bornChatThread(null, folder), id: `side-${Date.now()}`, kind: "side" as const, title: "Side chat" };
    useWorkspaceStore.setState((state) => ({ chats: [...state.chats, side] }));
    vi.unstubAllGlobals();
    const actions: Action[] = [];
    expect(await spawnDefaultChatForWorkspace({ folder, sessions: {} as never, dispatch: (action) => actions.push(action) })).toBe(true);
    expect(actions).toContainEqual(expect.objectContaining({ type: "ADD_CHAT", chat: expect.objectContaining({ folder }) }));
    expect(actions.find((action) => action.type === "ADD_CHAT")).not.toHaveProperty("chat.kind", "side");
  });
});

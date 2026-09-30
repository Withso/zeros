import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  generation: 0,
  appInfo: vi.fn(),
  chats: [{ id: "chat-1", title: "Untitled", folder: "/repo", createdAt: 1 }],
}));
vi.mock("@/renderer/platform/runtime", () => ({
  isElectron: () => true,
  nativeInvoke: state.appInfo,
}));
vi.mock("@/renderer/features/auth/auth-store", () => ({
  getSession: async () => ({ access_token: "synthetic-session" }),
  onAuthStateChange: () => () => {},
}));
vi.mock("@/renderer/features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => state.generation,
}));
vi.mock("@/renderer/features/team/control-plane", () => ({
  CONTROL_PLANE_URL: "https://api.example.test",
  ControlPlaneError: class extends Error {},
}));
vi.mock("@/renderer/platform/cloud-github", () => ({
  authorizeCloudGithubSource: vi.fn(),
}));
vi.mock("@/renderer/state/workspace-store", () => ({
  useWorkspaceStore: { getState: () => ({ chats: state.chats }) },
}));

beforeEach(() => {
  vi.resetModules();
  state.generation = 0;
  state.chats = [
    { id: "chat-1", title: "Untitled", folder: "/repo", createdAt: 1 },
  ];
  state.appInfo.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ok: true, title: "Fix login redirect bug" }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("client identity cold-read races", () => {
  it("does not send a cloud mutation after its initiating account retires during app-info", async () => {
    let release!: (value: unknown) => void;
    state.appInfo.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { cloudAccountRequest } =
      await import("../../../platform/cloud-workspaces");
    const pending = cloudAccountRequest(
      "/v1/test",
      z.object({ ok: z.boolean() }),
      { body: {}, idempotencyKey: "synthetic-operation" },
    );
    const outcome = expect(pending).rejects.toThrow(/account changed/i);
    await vi.waitFor(() => expect(state.appInfo).toHaveBeenCalledOnce());
    state.generation += 1;
    release({ channel: "alpha", version: "1.2.3" });
    await outcome;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send a paid title request after its exact chat retires during app-info", async () => {
    let release!: (value: unknown) => void;
    state.appInfo.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { requestAiChatTitle } = await import("../../agent/chat-title");
    requestAiChatTitle({
      chatId: "chat-1",
      messageId: "message",
      prompt: "Fix login redirect bug",
      expectedTitle: "Untitled",
      dispatch: vi.fn(),
    });
    await vi.waitFor(() => expect(state.appInfo).toHaveBeenCalledOnce());
    state.chats = [{ ...state.chats[0], createdAt: 2 }];
    release({ channel: "alpha", version: "1.2.3" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
  });
});

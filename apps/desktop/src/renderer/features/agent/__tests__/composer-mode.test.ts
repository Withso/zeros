import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "../../../state/store";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";
import { useWorkspaceStore } from "../../../state/workspace-store";
import { setComposerMode, awaitComposerMode } from "../composer-mode";
vi.mock("../../../state/persist-composer-drafts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  schedulePersistDrafts: () => {},
}));

const base: ChatThread = {
  id: "a",
  folder: "/workspace",
  agentId: "claude",
  agentName: "Claude",
  model: null,
  effort: "high",
  permissionMode: "plan",
  title: "Design",
  createdAt: 1,
  updatedAt: 1,
};
beforeEach(() =>
  useWorkspaceStore.setState({ chats: [base, { ...base, id: "b" }] }),
);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("composer mode selections", () => {
  it("confirms selections in order and fences an immediate send without changing provider Plan", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const bridge = { request } as unknown as RuntimeClient;
    const design = setComposerMode(bridge, "a", "design");
    const code = setComposerMode(bridge, "a", "code");
    let sent = false;
    const send = awaitComposerMode(bridge, "a")!.then(() => {
      sent = true;
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(useWorkspaceStore.getState().chats[0]?.composerMode).toBeUndefined();
    first.resolve({
      type: "WORKSPACE_RESPONSE",
      result: { mode: "design", revision: 1 },
    });
    await design;
    expect(sent).toBe(false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    second.resolve({
      type: "WORKSPACE_RESPONSE",
      result: { mode: "code", revision: 2 },
    });
    await code;
    await send;
    expect(awaitComposerMode(bridge, "a")).toBeUndefined();
    expect(useWorkspaceStore.getState().chats[0]).toMatchObject({
      composerMode: "code",
      composerModeRevision: 2,
      permissionMode: "plan",
    });
    expect(useWorkspaceStore.getState().chats[1]?.composerMode).toBeUndefined();
  });

  it("retains the confirmed tag after failure and never applies an old response to a moved/deleted chat", async () => {
    useWorkspaceStore.setState({
      chats: [{ ...base, composerMode: "design", composerModeRevision: 1 }],
    });
    const failed = {
      request: vi.fn().mockRejectedValue(new Error("offline")),
    } as unknown as RuntimeClient;
    await expect(setComposerMode(failed, "a", "code")).rejects.toThrow(
      "offline",
    );
    expect(useWorkspaceStore.getState().chats[0]?.composerMode).toBe("design");
    const flight = deferred<unknown>();
    const bridge = {
      request: vi.fn(() => flight.promise),
    } as unknown as RuntimeClient;
    const result = setComposerMode(bridge, "a", "code");
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalled());
    useWorkspaceStore.setState({ chats: [{ ...base, folder: "/elsewhere" }] });
    flight.resolve({
      type: "WORKSPACE_RESPONSE",
      result: { mode: "code", revision: 2 },
    });
    await result;
    expect(
      useWorkspaceStore.getState().chats[0]?.composerModeRevision,
    ).toBeUndefined();
  });

  it("a newer agent-mode notification wins over an older manual response", async () => {
    const flight = deferred<unknown>();
    const bridge = {
      request: vi.fn(() => flight.promise),
    } as unknown as RuntimeClient;
    const result = setComposerMode(bridge, "a", "design");
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalled());
    useWorkspaceStore.getState().dispatch({
      type: "SET_CHAT_COMPOSER_MODE",
      id: "a",
      folder: base.folder,
      mode: "code",
      revision: 2,
    });
    flight.resolve({
      type: "WORKSPACE_RESPONSE",
      result: { mode: "design", revision: 1 },
    });
    await result;
    expect(useWorkspaceStore.getState().chats[0]?.composerMode).toBe("code");
  });
});

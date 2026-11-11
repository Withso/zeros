// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessions: { current: {} as object | null },
  spawn: vi.fn(),
  send: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../agent/sessions-hooks", () => ({ useOptionalAgentSessions: () => mocks.sessions.current }));
vi.mock("../../../state/spawn-default-chat", () => ({ spawnNewChatTab: mocks.spawn }));
vi.mock("../../../shell/pr/use-send-to-active-chat", () => ({ useSendToChat: () => mocks.send }));
vi.mock("../../../state/workspace-store", () => ({
  useWorkspaceDispatch: () => () => {},
  useWorkspaceStore: { getState: () => ({ chats: [{ id: "chat-1", agentId: "agent" }] }), subscribe: () => () => {} },
}));
vi.mock("../../../shared/ui/primitives", () => ({ toast: { error: mocks.error } }));

import { useAskDesignAgent } from "../design-agent-sync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let ask: ReturnType<typeof useAskDesignAgent> | null = null;
function Probe() {
  ask = useAskDesignAgent("/repo");
  return null;
}

describe("asking the agent from Design", () => {
  beforeEach(() => {
    mocks.sessions.current = {};
    mocks.spawn.mockReset().mockResolvedValue({ id: "chat-1" });
    mocks.send.mockReset();
    mocks.error.mockReset();
    const host = document.createElement("div");
    document.body.append(host);
    act(() => {
      root = createRoot(host);
      root.render(createElement(Probe));
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  it("sends the brief to a new chat and says which chat it went to", async () => {
    const onSent = vi.fn();
    const onFailed = vi.fn();
    ask!({ label: "Tidy 3 changes in home.html", text: "brief" }, { onSent, onFailed });
    await vi.waitFor(() => expect(onSent).toHaveBeenCalledWith("chat-1"));
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith("chat-1", { text: "brief", displayText: "Tidy 3 changes in home.html", autoAction: "design-sync" });
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says when it could not send, as well as telling the person", async () => {
    mocks.sessions.current = null;
    act(() => root!.render(createElement(Probe)));
    const onSent = vi.fn();
    const onFailed = vi.fn();
    ask!({ label: "Tidy", text: "brief" }, { onSent, onFailed });
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
    expect(onSent).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledTimes(1);
  });
});

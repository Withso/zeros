import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, useSessionsStore } from "../sessions-store";
import type { AgentMessage } from "../use-agent-session";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const messages: AgentMessage[] = [
  { kind: "text", id: "prompt", role: "user", text: "Read this file", createdAt: 1 },
  { kind: "text", id: "reply", role: "agent", text: "Checking the file", createdAt: 2 },
];
beforeEach(() => useSessionsStore.getState().clearAll());
function seed(cwd: string | null, chatId = "chat") {
  useSessionsStore.getState().setSession(chatId, {
    ...BLANK, cwd, agentId: "codex", sessionId: "execution", status: "streaming", messages,
  });
  return useSessionsStore.getState().sessions[chatId];
}

describe("Local session publication stability", () => {
  it.each(["/personal/project", "/organization/project"])("%s ignores repeated normalized scalar patches and slots", cwd => {
    const slot = seed(cwd), initial = useSessionsStore.getState();
    const changed = vi.fn(), stop = useSessionsStore.subscribe(changed);
    try {
      for (let i = 0; i < 100; i++) initial.patchSession("chat", { status: "streaming", error: null });
      const patches = changed.mock.calls.length;
      changed.mockClear();
      for (let i = 0; i < 100; i++) initial.setSession("chat", { ...slot });
      console.info(JSON.stringify({ cwd, patches, snapshots: changed.mock.calls.length }));
      expect(patches).toBe(0);
      expect(changed).not.toHaveBeenCalled();
      expect(useSessionsStore.getState()).toBe(initial);
    } finally { stop(); }
  });

  it("reuses unchanged serialized snapshot rows and publishes edited same-id rows", () => {
    const slot = seed("/personal/project"), initial = useSessionsStore.getState();
    const changed = vi.fn(), stop = useSessionsStore.subscribe(changed);
    try {
      initial.setSession("chat", { ...slot, messages: structuredClone(slot.messages) });
      expect(changed).not.toHaveBeenCalled();
      expect(useSessionsStore.getState()).toBe(initial);
      const edited = structuredClone(slot.messages);
      if (edited[1].kind !== "text") throw new Error("Expected text");
      edited[1].text = "The file changed";
      initial.setSession("chat", { ...slot, messages: edited });
      const next = useSessionsStore.getState();
      expect(changed).toHaveBeenCalledOnce();
      expect(next.sessions.chat.messages[0]).toBe(slot.messages[0]);
      expect(next.sessions.chat.messages[1]).toBe(edited[1]);
      expect(next.executionToChatId).toBe(initial.executionToChatId);
    } finally { stop(); }
  });

  it("keeps the routing index stable for metadata and changes it atomically with execution", () => {
    const slot = seed("/personal/project"), initial = useSessionsStore.getState();
    initial.setSession("chat", { ...slot, error: "temporary" });
    expect(useSessionsStore.getState().executionToChatId).toBe(initial.executionToChatId);
    initial.patchSession("chat", { executionId: "replacement", foregroundTurnId: "new-turn" });
    expect(useSessionsStore.getState()).toMatchObject({
      executionToChatId: { replacement: "chat" },
      sessions: { chat: { executionId: "replacement", sessionId: "replacement", foregroundTurnId: "new-turn" } },
    });
    expect(useSessionsStore.getState().executionToChatId.execution).toBeUndefined();
  });

  it("does not inherit transcript references or turn identity across a Local owner replacement", () => {
    const slot = seed("/personal/project");
    useSessionsStore.getState().patchSession("chat", { foregroundTurnId: "turn" });
    const previous = useSessionsStore.getState().sessions.chat;
    const incoming = structuredClone(slot.messages);
    useSessionsStore.getState().setSession("chat", { ...previous, cwd: "/organization/project", messages: incoming });
    const current = useSessionsStore.getState().sessions.chat;
    expect(current.cwd).toBe("/organization/project");
    expect(current.messages).toBe(incoming);
    expect(current.foregroundTurnId).toBeNull();
  });

  it("creates absent slots even when a patch is empty", () => {
    const initial = useSessionsStore.getState();
    initial.patchSession("new", {});
    expect(useSessionsStore.getState()).not.toBe(initial);
    expect(useSessionsStore.getState().sessions.new).toBeDefined();
  });

  it.each([
    [cloudWorkspaceKey(target), "cloud-chat"],
    ["/physical/cloud-checkout", cloudScopedId(target, "native-chat")],
    [null, "unbound"],
  ])("preserves the existing publication contract for %s", (cwd, chatId) => {
    const slot = seed(cwd, chatId!), initial = useSessionsStore.getState();
    const changed = vi.fn(), stop = useSessionsStore.subscribe(changed);
    try {
      initial.patchSession(chatId!, { status: "streaming" });
      initial.setSession(chatId!, { ...slot });
      expect(changed).toHaveBeenCalledTimes(2);
      expect(useSessionsStore.getState().sessions[chatId!]).not.toBe(slot);
      expect(useSessionsStore.getState().executionToChatId).not.toBe(initial.executionToChatId);
    } finally { stop(); }
  });
});

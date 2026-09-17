import { beforeEach, describe, expect, it } from "vitest";
import type { SessionNotification, UsageUpdateNotification } from "@zeros/protocol/agent-events";
import { BLANK, useSessionsStore } from "../sessions-store";

beforeEach(() => useSessionsStore.getState().clearAll());

const usage = {
  ...BLANK.usage,
  size: 100,
  used: 20,
  categories: [{ name: "Messages", tokens: 20 }],
};

function update(executionId: string, values: Partial<UsageUpdateNotification> = {}): SessionNotification & { chatId: string } {
  return {
    chatId: "chat",
    sessionId: executionId,
    executionId,
    update: { sessionUpdate: "usage_update", size: 100, used: 90, ...values },
  };
}

describe("context usage execution ownership", () => {
  it("publishes category-kind changes while keeping repeated classified snapshots stable", () => {
    const store = useSessionsStore.getState();
    const categories = [{ name: "Tools", tokens: 20, kind: "used" as const }];
    store.setSession("chat", { ...BLANK, agentId: "claude", sessionId: "current", usage: { ...usage, categories } });
    const before = useSessionsStore.getState();
    const deferred = [{ name: "Tools", tokens: 20, kind: "deferred" as const }];
    store.applyBridgeUpdate(update("current", { used: 20, categories: deferred }));
    const after = useSessionsStore.getState();
    expect(after).not.toBe(before);
    expect(after.sessions.chat.usage.categories).toEqual(deferred);
    expect(after.sessions.chat.messages).toBe(before.sessions.chat.messages);
    store.applyBridgeUpdate(update("current", { used: 20, categories: deferred.map((category) => ({ ...category })) }));
    expect(useSessionsStore.getState()).toBe(after);
  });

  it.each(["claude", "codex", "cursor"])("rejects a retired %s execution even with an authoritative chat ID", (agentId) => {
    const store = useSessionsStore.getState();
    store.setSession("chat", { ...BLANK, agentId, sessionId: "current", usage });
    store.setSession("other", { ...BLANK, agentId, sessionId: "other", usage });
    const before = useSessionsStore.getState();
    store.applyBridgeUpdate(update("retired"));
    store.applyBridgeUpdate(update("other"));
    expect(useSessionsStore.getState()).toBe(before);

    store.applyBridgeUpdate(update("current", { used: 10, categories: [] }));
    const after = useSessionsStore.getState().sessions;
    expect(after.chat.usage).toMatchObject({ size: 100, used: 10, categories: [] });
    expect(after.chat.messages).toBe(before.sessions.chat.messages);
    expect(after.other).toBe(before.sessions.other);
  });

  it("rejects delayed updates while a replacement execution is unbound or detached", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat", { ...BLANK, agentId: "claude", sessionId: "old", usage });
    store.patchSession("chat", { executionId: null });
    const before = useSessionsStore.getState();
    store.applyBridgeUpdate(update("old"));
    expect(useSessionsStore.getState()).toBe(before);
    expect(before.sessions.chat.usage).toBe(usage);
    store.detachSession("chat");
    const detached = useSessionsStore.getState();
    store.applyBridgeUpdate(update("old"));
    expect(useSessionsStore.getState()).toBe(detached);
  });

  it("supports sessionId-only legacy updates for the matching execution", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat", { ...BLANK, agentId: "codex", sessionId: "current", usage });
    store.applyBridgeUpdate({ sessionId: "current", update: { sessionUpdate: "usage_update", used: 30 } });
    expect(useSessionsStore.getState().sessions.chat.usage).toMatchObject({ used: 30, size: 100 });
    const before = useSessionsStore.getState();
    store.applyBridgeUpdate({ ...update("retired"), executionId: undefined });
    expect(useSessionsStore.getState()).toBe(before);
  });

  it("prefers the explicit execution identity over a legacy routing alias", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat", { ...BLANK, agentId: "codex", sessionId: "current", usage });
    const before = useSessionsStore.getState();
    store.applyBridgeUpdate({ ...update("retired"), sessionId: "current" });
    expect(useSessionsStore.getState()).toBe(before);
    store.applyBridgeUpdate({ ...update("current"), sessionId: "legacy" });
    expect(useSessionsStore.getState().sessions.chat.usage.used).toBe(90);
  });

  it("keeps equal snapshots reference-stable and preserves confirmed fields in partial updates", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat", { ...BLANK, agentId: "claude", sessionId: "current", usage });
    const before = useSessionsStore.getState();
    store.applyBridgeUpdate(update("current", { used: 20, categories: [{ name: "Messages", tokens: 20 }] }));
    store.applyBridgeUpdate({ sessionId: "current", update: { sessionUpdate: "usage_update", size: 100 } });
    expect(useSessionsStore.getState()).toBe(before);

    store.applyBridgeUpdate({ sessionId: "current", update: { sessionUpdate: "usage_update", size: 200 } });
    const current = useSessionsStore.getState().sessions.chat.usage;
    expect(current).toMatchObject({ size: 200, used: 20 });
    expect(current.categories).toBe(usage.categories);
  });
});

import { beforeEach, expect, it, vi } from "vitest";
import { BLANK, useSessionsStore } from "../sessions-store";
import { turnRowCache, turnRowKey } from "@/renderer/state/read-caches";

beforeEach(() => {
  useSessionsStore.getState().clearAll();
  vi.restoreAllMocks();
});

it("revalidates only the exact turn and leaves transcript and activity references unchanged", () => {
  const store = useSessionsStore.getState();
  store.setSession("chat", {
    ...BLANK,
    agentId: "claude",
    sessionId: "execution",
  });
  store.setSession("other", {
    ...BLANK,
    agentId: "cursor",
    sessionId: "other-execution",
  });
  const before = useSessionsStore.getState().sessions;
  const invalidate = vi.spyOn(turnRowCache, "invalidate");
  const notice = {
    sessionId: "execution",
    update: {
      sessionUpdate: "turn_usage_update" as const,
      turnId: "a",
      usage: { accountingVersion: 1 as const, revision: 1, totalCostUsd: 0.15 },
    },
  };
  store.applyBridgeUpdate(notice);
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(turnRowKey("chat", "a"));
  expect(useSessionsStore.getState().sessions).toBe(before);
  store.applyBridgeUpdate({
    ...notice,
    sessionId: "retired",
    chatId: "chat",
  } as typeof notice);
  expect(invalidate).toHaveBeenCalledTimes(1);
});

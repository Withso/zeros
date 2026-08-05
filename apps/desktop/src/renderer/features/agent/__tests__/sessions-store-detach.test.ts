import { beforeEach, describe, expect, it } from "vitest";

import { BLANK, useSessionsStore } from "../sessions-store";

describe("sessions-store archive detach", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it("drops volatile routing but preserves the restore scroll anchor", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "codex",
      sessionId: "session-a",
      status: "ready",
    });
    store.seedScrollPositions({
      "chat-a": {
        top: 420,
        anchorId: "turn-7",
        anchorOffset: 12,
        atBottom: false,
      },
    });

    store.detachSession("chat-a");

    const detached = useSessionsStore.getState();
    expect(detached.sessions["chat-a"]).toBeUndefined();
    expect(detached.sessionToChatId["session-a"]).toBeUndefined();
    expect(detached.scrollPositions["chat-a"]).toEqual({
      top: 420,
      anchorId: "turn-7",
      anchorOffset: 12,
      atBottom: false,
    });
  });
});

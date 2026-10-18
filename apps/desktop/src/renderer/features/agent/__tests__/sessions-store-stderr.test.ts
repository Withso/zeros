import { beforeEach, describe, expect, it } from "vitest";
import { BLANK, useSessionsStore } from "../sessions-store";

const chats = [
  { id: "claude-a", agentId: "claude", transcriptState: "resident" as const },
  { id: "claude-b", agentId: "claude", transcriptState: "resident" as const },
  { id: "claude-cold", agentId: "claude", transcriptState: "cold" as const },
  { id: "codex-a", agentId: "codex", transcriptState: "resident" as const },
];

function seed(existing: string[] = []) {
  const store = useSessionsStore.getState();
  store.clearAll();
  for (const chat of chats) {
    store.setSession(chat.id, {
      ...BLANK,
      agentId: chat.agentId,
      sessionId: `${chat.id}-execution`,
      transcriptState: chat.transcriptState,
      stderrLog: chat.transcriptState === "resident" ? existing : [],
    });
  }
}

function logs() {
  const sessions = useSessionsStore.getState().sessions;
  return Object.fromEntries(chats.map((chat) => [chat.id, sessions[chat.id]!.stderrLog]));
}

beforeEach(() => useSessionsStore.getState().clearAll());

describe("agent stderr retention", () => {
  it("applies a batch exactly like the same lines one at a time", () => {
    const existing = Array.from({ length: 150 }, (_, index) => `old ${index}`);
    const entries = Array.from({ length: 120 }, (_, index) => ({
      agentId: index % 3 === 0 ? "codex" : "claude",
      line: `new ${index}`,
    }));

    seed(existing);
    for (const entry of entries) useSessionsStore.getState().applyBridgeStderr(entry.agentId, entry.line);
    const sequential = logs();

    seed(existing);
    useSessionsStore.getState().applyBridgeStderrLines(entries);
    expect(logs()).toEqual(sequential);
    expect(logs()["claude-a"]).toHaveLength(200);
    expect(logs()["claude-cold"]).toEqual([]);
  });

  it("publishes one store update per batch and keeps unrelated slots stable", () => {
    seed();
    const before = useSessionsStore.getState().sessions;
    let notifications = 0;
    const stop = useSessionsStore.subscribe(() => { notifications += 1; });
    try {
      useSessionsStore.getState().applyBridgeStderrLines(
        Array.from({ length: 40 }, (_, index) => ({ agentId: "claude", line: `line ${index}` })),
      );
    } finally {
      stop();
    }
    const after = useSessionsStore.getState().sessions;
    expect(notifications).toBe(1);
    expect(after["codex-a"]).toBe(before["codex-a"]);
    expect(after["claude-cold"]).toBe(before["claude-cold"]);
    expect(after["claude-a"]!.stderrLog).toHaveLength(40);
  });

  it("does not publish anything for an empty batch or an agent without resident chats", () => {
    seed();
    let notifications = 0;
    const stop = useSessionsStore.subscribe(() => { notifications += 1; });
    try {
      useSessionsStore.getState().applyBridgeStderrLines([]);
      useSessionsStore.getState().applyBridgeStderrLines([{ agentId: "cursor", line: "unowned" }]);
    } finally {
      stop();
    }
    expect(notifications).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";

import { createCodexThreadClient } from "../app-server-thread-client";

describe("Codex app-server thread client", () => {
  it("routes native lifecycle and history methods with exact parameters", async () => {
    const request = vi.fn(async (method: string, params: unknown) => ({
      method,
      params,
    }));
    const client = createCodexThreadClient(request);

    await client.forkThread({ threadId: "thread-1", lastTurnId: "turn-2" });
    await client.archiveThread({ threadId: "thread-1" });
    await client.unarchiveThread({ threadId: "thread-1" });
    await client.deleteThread({ threadId: "thread-1" });
    await client.setThreadName({ threadId: "thread-1", name: "Checkout QA" });
    await client.setThreadGoal({
      threadId: "thread-1",
      objective: "Finish QA",
    });
    await client.getThreadGoal({ threadId: "thread-1" });
    await client.clearThreadGoal({ threadId: "thread-1" });
    await client.listThreads({ limit: 25, cwd: "/workspace" });
    await client.readThread({ threadId: "thread-1", includeTurns: true });
    await client.listThreadTurns({ threadId: "thread-1", limit: 20 });
    await client.listThreadItems({
      threadId: "thread-1",
      turnId: "turn-2",
      limit: 50,
    });
    await client.searchThreads({ searchTerm: "browser QA", limit: 20 });
    await client.searchThreadOccurrences({
      threadId: "thread-1",
      searchTerm: "browser QA",
      limit: 20,
    });
    await client.listLoadedThreads({ limit: 20 });
    await client.listBackgroundTerminals({ threadId: "thread-1" });
    await client.cleanBackgroundTerminals({ threadId: "thread-1" });
    await client.terminateBackgroundTerminal({
      threadId: "thread-1",
      processId: "process-1",
    });
    await client.rollbackThread({ threadId: "thread-1", numTurns: 1 });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/fork",
      "thread/archive",
      "thread/unarchive",
      "thread/delete",
      "thread/name/set",
      "thread/goal/set",
      "thread/goal/get",
      "thread/goal/clear",
      "thread/list",
      "thread/read",
      "thread/turns/list",
      "thread/items/list",
      "thread/search",
      "thread/searchOccurrences",
      "thread/loaded/list",
      "thread/backgroundTerminals/list",
      "thread/backgroundTerminals/clean",
      "thread/backgroundTerminals/terminate",
      "thread/rollback",
    ]);
    expect(request).toHaveBeenCalledWith("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });
  });
});

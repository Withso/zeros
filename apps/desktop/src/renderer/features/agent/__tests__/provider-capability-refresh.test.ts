import { describe, expect, it } from "vitest";

import {
  cancelProviderCapabilityRefresh,
  queueProviderCapabilityRefresh,
  type ProviderCapabilityRefreshQueue,
} from "../provider-capability-refresh";

function reasons(queue: ProviderCapabilityRefreshQueue, chatId: string) {
  return [...(queue.get(chatId)?.reasons ?? [])].sort();
}

describe("provider capability refresh queue", () => {
  it("keeps a computer-use resume when the browser route turns off", () => {
    const queue: ProviderCapabilityRefreshQueue = new Map();
    queueProviderCapabilityRefresh(
      queue,
      ["chat-a"],
      { providerFamily: "claude", reason: "computer", revision: 1 },
      64,
    );
    queueProviderCapabilityRefresh(
      queue,
      ["chat-a"],
      { providerFamily: "claude", reason: "browser", revision: 2 },
      64,
    );
    expect(reasons(queue, "chat-a")).toEqual(["browser", "computer"]);
    expect(queue.get("chat-a")?.revision).toBe(2);

    cancelProviderCapabilityRefresh(queue, {
      providerFamily: "claude",
      reason: "browser",
    });
    expect(reasons(queue, "chat-a")).toEqual(["computer"]);

    cancelProviderCapabilityRefresh(queue, {
      providerFamily: "claude",
      reason: "computer",
    });
    expect(queue.has("chat-a")).toBe(false);
  });

  it("cancels only the matching family", () => {
    const queue: ProviderCapabilityRefreshQueue = new Map();
    queueProviderCapabilityRefresh(
      queue,
      ["chat-a"],
      { providerFamily: "cursor", reason: "computer", revision: 1 },
      64,
    );
    cancelProviderCapabilityRefresh(queue, {
      providerFamily: "claude",
      reason: "computer",
    });
    expect(reasons(queue, "chat-a")).toEqual(["computer"]);
  });

  it("drops reasons from a family the chat no longer uses", () => {
    const queue: ProviderCapabilityRefreshQueue = new Map();
    queueProviderCapabilityRefresh(
      queue,
      ["chat-a"],
      { providerFamily: "claude", reason: "browser", revision: 1 },
      64,
    );
    queueProviderCapabilityRefresh(
      queue,
      ["chat-a"],
      { providerFamily: "codex", reason: "computer", revision: 2 },
      64,
    );
    expect(queue.get("chat-a")).toMatchObject({ providerFamily: "codex" });
    expect(reasons(queue, "chat-a")).toEqual(["computer"]);
  });

  it("stays bounded, dropping the oldest chat first", () => {
    const queue: ProviderCapabilityRefreshQueue = new Map();
    queueProviderCapabilityRefresh(
      queue,
      ["chat-a", "chat-b", "chat-c"],
      { providerFamily: "codex", reason: "computer", revision: 1 },
      2,
    );
    expect([...queue.keys()]).toEqual(["chat-b", "chat-c"]);
  });
});

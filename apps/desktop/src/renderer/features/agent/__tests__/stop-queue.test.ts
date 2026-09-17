import { describe, expect, it } from "vitest";
import { cancelledQueuedMessageAction } from "../session-reload-lifecycle";
import { SendQueue } from "../send-queue";

describe("Stop preserves pending user instructions", () => {
  it.each([undefined, "queued-card"] as const)(
    "keeps a %s follow-up editable in the paused queue",
    (presentation) => {
      expect(cancelledQueuedMessageAction(presentation)).toBe(
        "preserve-in-queue",
      );
    },
  );

  it("still settles a first prompt stopped during admission as the stopped turn", () => {
    expect(cancelledQueuedMessageAction("active-turn")).toBe(
      "preserve-as-turn",
    );
  });
});

describe("paused follow-up workflow", () => {
  it("keeps B/C/D editable after Stop, then sends C followed by B and D", () => {
    const queue = new SendQueue<{ bubbleId: string; text: string }>();
    queue.set(
      "chat",
      ["B", "C", "D"].map((id) => ({ bubbleId: id, text: id })),
    );
    queue.pause("chat");
    expect(queue.canDrain("chat")).toBe(false);
    queue.get("chat")![0]!.text = "edited B";
    expect(queue.isPaused("chat")).toBe(true);
    queue.prioritize("chat", "C");
    queue.resume("chat");
    expect(queue.canDrain("chat")).toBe(true);
    expect(queue.get("chat")!.map((entry) => entry.text)).toEqual([
      "C",
      "edited B",
      "D",
    ]);
    queue.get("chat")!.shift();
    expect(queue.canDrain("chat")).toBe(true);
    queue.pause("chat");
    expect(queue.get("chat")!.map((entry) => entry.bubbleId)).toEqual([
      "B",
      "D",
    ]);
    expect(queue.canDrain("chat")).toBe(false);
  });

  it("keeps an in-flight steer owned through Stop and never resumes on its reply", () => {
    const queue = new SendQueue<{ bubbleId: string }>();
    queue.set("chat", [{ bubbleId: "B" }, { bubbleId: "C" }]);
    expect(queue.claim("chat", "C")).toBe(true);
    expect(queue.claim("chat", "C")).toBe(false);
    queue.pause("chat");
    expect(queue.get("chat")).toHaveLength(2);
    queue.release("chat", "C");
    expect(queue.canDrain("chat")).toBe(false);
    queue.resume("chat");
    expect(queue.canDrain("chat")).toBe(true);
  });

  it("isolates chats and releases pause/claim ownership when a chat closes", () => {
    const queue = new SendQueue<{ bubbleId: string }>();
    queue.pause("a");
    queue.claim("a", "message");
    expect(queue.canDrain("b")).toBe(true);
    queue.delete("a");
    expect(queue.canDrain("a")).toBe(true);
  });
});

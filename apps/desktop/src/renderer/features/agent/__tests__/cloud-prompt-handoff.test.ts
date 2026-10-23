import { expect, it, vi } from "vitest";
import { CloudPromptHandoff } from "../cloud-prompt-handoff";
import { SendQueue } from "../send-queue";

const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() }; };
it("migrates an in-memory FIFO exactly once, retaining identities and removing a bubble only after private commit", async () => {
  const queue = new SendQueue<{ bubbleId: string }>(), handoff = new CloudPromptHandoff(), gate = deferred();
  queue.set("chat", [{ bubbleId: "one" }, { bubbleId: "two" }]);
  const save = vi.fn(async (_entry: { bubbleId: string }) => { await gate.promise; }), remove = vi.fn<(entry: { bubbleId: string }) => void>(), cancelReadiness = vi.fn();
  const input = { queue, chatId: "chat", save, remove, cancelReadiness };
  const first = handoff.run(input), duplicate = handoff.run(input);
  expect(cancelReadiness).toHaveBeenCalledOnce(); expect(queue.canDrain("chat")).toBe(false);
  expect(queue.isSending("chat", "two")).toBe(true); expect(remove).not.toHaveBeenCalled();
  gate.resolve(); await Promise.all([first, duplicate]);
  expect(save.mock.calls.map(call => call[0].bubbleId)).toEqual(["one", "two"]);
  expect(remove.mock.calls.map(call => call[0].bubbleId)).toEqual(["one", "two"]); expect(queue.has("chat")).toBe(false);
});
it("preserves the failed transfer and its successors without replaying ambiguous legacy steering", async () => {
  const queue = new SendQueue<{ bubbleId: string; steerRequest?: object }>(), handoff = new CloudPromptHandoff();
  queue.set("chat", [{ bubbleId: "one" }, { bubbleId: "two" }]);
  const input = { queue, chatId: "chat", save: vi.fn(async () => { throw new Error("storage full"); }), remove: vi.fn(), cancelReadiness: vi.fn() };
  await expect(handoff.run(input)).rejects.toThrow("storage full");
  expect(queue.get("chat")).toHaveLength(2); expect(queue.isPaused("chat")).toBe(true); expect(input.remove).not.toHaveBeenCalled();
  queue.get("chat")![0]!.steerRequest = { attemptId: "unknown" };
  await expect(handoff.run(input)).rejects.toThrow(/previous delivery/i); expect(input.save).toHaveBeenCalledTimes(1);
});

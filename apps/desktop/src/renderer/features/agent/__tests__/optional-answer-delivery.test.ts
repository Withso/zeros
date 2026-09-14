import { describe, expect, it, vi } from "vitest";
import { deliverOptionalAnswer } from "../optional-answer-delivery";

describe("optional answer delivery", () => {
  it("restarts draining when the turn settles while a steer is being rejected", async () => {
    let queue = [{ bubbleId: "earlier-draft" }];
    let rejectSteer!: (delivered: boolean) => void;
    const steerResult = new Promise<boolean>((resolve) => {
      rejectSteer = resolve;
    });
    const delivered: string[] = [];
    const drain = vi.fn(() => {
      delivered.push(...queue.map((entry) => entry.bubbleId));
      queue = [];
    });
    const delivery = deliverOptionalAnswer({
      queued: () => queue,
      send: () => {
        queue.push({ bubbleId: "answer" });
      },
      steer: async (id) => {
        expect(id).toBe("answer");
        queue = queue.filter((entry) => entry.bubbleId !== id);
        const accepted = await steerResult;
        if (!accepted) queue.unshift({ bubbleId: id });
        return accepted;
      },
      drain,
    });
    // The turn's finally already drained everything except the claimed answer.
    queue = [];
    rejectSteer(false);
    await delivery;
    expect(delivered).toEqual(["answer"]);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("never steers an earlier queued draft or repeats an accepted answer", async () => {
    let queue = [{ bubbleId: "draft" }];
    const drain = vi.fn();
    const steer = vi.fn(async (id: string) => {
      queue = queue.filter((entry) => entry.bubbleId !== id);
      return true;
    });
    await deliverOptionalAnswer({
      queued: () => queue,
      send: () => {
        queue.push({ bubbleId: "answer" });
      },
      steer,
      drain,
    });
    expect(steer).toHaveBeenCalledWith("answer");
    expect(queue).toEqual([{ bubbleId: "draft" }]);
    expect(drain).not.toHaveBeenCalled();
  });

  it("uses the normal prompt path directly when idle", async () => {
    const steer = vi.fn();
    const drain = vi.fn();
    const send = vi.fn();
    await deliverOptionalAnswer({ queued: () => [], send, steer, drain });
    expect(send).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });
});

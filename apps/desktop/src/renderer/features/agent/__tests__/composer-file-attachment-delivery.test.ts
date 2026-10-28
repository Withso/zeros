import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingFileDeliveriesForTesting,
  deliverFilesToChat,
  hasPendingFileDelivery,
  registerLiveChatFileStager,
} from "../composer-file-attachment-delivery";

const delivery = (id: string) => ({
  id,
  files: [new File(["x"], `${id}.txt`, { type: "text/plain" })],
});

describe("chat-owned composer file delivery", () => {
  afterEach(() => clearPendingFileDeliveriesForTesting());

  it("stages immediately into a mounted exact-chat composer", () => {
    const stage = vi.fn(() => true);
    const unregister = registerLiveChatFileStager("chat-a", stage);
    const first = delivery("one");

    expect(deliverFilesToChat("chat-a", first)).toBe("staged");
    expect(stage).toHaveBeenCalledWith(first, { focus: true });
    expect(hasPendingFileDelivery("chat-a")).toBe(false);
    unregister();
  });

  it("queues until the exact chat mounts and never drains into another chat", () => {
    const first = delivery("one");
    expect(deliverFilesToChat("chat-a", first)).toBe("queued");

    const wrong = vi.fn(() => true);
    const unregisterWrong = registerLiveChatFileStager("chat-b", wrong);
    expect(wrong).not.toHaveBeenCalled();
    expect(hasPendingFileDelivery("chat-a")).toBe(true);

    const exact = vi.fn(() => true);
    const unregisterExact = registerLiveChatFileStager("chat-a", exact);
    expect(exact).toHaveBeenCalledTimes(1);
    expect(exact).toHaveBeenCalledWith(first, { focus: false });
    expect(hasPendingFileDelivery("chat-a")).toBe(false);
    unregisterWrong();
    unregisterExact();
  });

  it("keeps queued deliveries in order while the composer is not ready", () => {
    const first = delivery("one");
    const second = delivery("two");
    deliverFilesToChat("chat-a", first);
    deliverFilesToChat("chat-a", second);

    const notReady = vi.fn(() => false);
    const unregisterNotReady = registerLiveChatFileStager("chat-a", notReady);
    expect(notReady).toHaveBeenCalledTimes(1);
    expect(hasPendingFileDelivery("chat-a")).toBe(true);
    unregisterNotReady();

    const seen: string[] = [];
    const unregisterReady = registerLiveChatFileStager("chat-a", (d) => {
      seen.push(d.id);
      return true;
    });
    expect(seen).toEqual(["one", "two"]);
    unregisterReady();
  });

  it("queues again after the composer unregisters", () => {
    const stage = vi.fn(() => true);
    const unregister = registerLiveChatFileStager("chat-a", stage);
    unregister();

    expect(deliverFilesToChat("chat-a", delivery("one"))).toBe("queued");
    expect(stage).not.toHaveBeenCalled();
  });

  it("retained deliveries lose focus authority before the same chat registers", () => {
    const focusRequests: boolean[] = [];
    deliverFilesToChat("chat-a", delivery("retained"));
    registerLiveChatFileStager("chat-a", (_input, options = { focus: true }) => {
      focusRequests.push(options.focus);
      return true;
    });
    deliverFilesToChat("chat-a", delivery("live"));
    expect(focusRequests).toEqual([false, true]);
  });

  it("bounds the per-chat queue", () => {
    for (let i = 0; i < 12; i++) deliverFilesToChat("chat-a", delivery(`d${i}`));
    const seen: string[] = [];
    registerLiveChatFileStager("chat-a", (d) => {
      seen.push(d.id);
      return true;
    });
    expect(seen).toEqual(["d4", "d5", "d6", "d7", "d8", "d9", "d10", "d11"]);
  });
});

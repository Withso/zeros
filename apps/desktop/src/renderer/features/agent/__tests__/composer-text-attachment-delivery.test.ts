import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingTextAttachmentsForTesting,
  deliverTextAttachmentToChat,
  hasPendingTextAttachmentDelivery,
  registerLiveChatTextAttachmentStager,
  trackPendingTextAttachmentDelivery,
  waitForPendingTextAttachmentDeliveries,
} from "../composer-text-attachment-delivery";

const attachment = {
  sourceKey: "transcript:source",
  name: "source.concise.txt",
  text: "transcript",
};

describe("chat-owned text attachment delivery", () => {
  afterEach(() => clearPendingTextAttachmentsForTesting());

  it("queues a cold delivery and drains it into the exact mounted chat", () => {
    const wrong = vi.fn(() => true);
    const exact = vi.fn(() => true);

    deliverTextAttachmentToChat("destination", attachment);
    const unregisterWrong = registerLiveChatTextAttachmentStager(
      "other-chat",
      wrong,
    );
    expect(wrong).not.toHaveBeenCalled();

    const unregisterExact = registerLiveChatTextAttachmentStager(
      "destination",
      exact,
    );
    expect(exact).toHaveBeenCalledWith(attachment);
    unregisterWrong();
    unregisterExact();
  });

  it("stages immediately without replacing text the user already typed", () => {
    const stage = vi.fn(() => true);
    const unregister = registerLiveChatTextAttachmentStager(
      "destination",
      stage,
    );

    deliverTextAttachmentToChat("destination", attachment);

    expect(stage).toHaveBeenCalledWith(attachment);
    unregister();
  });

  it("retains a delivery until the exact composer is actually ready", () => {
    deliverTextAttachmentToChat("destination", attachment);
    const notReady = vi.fn(() => false);
    const unregisterNotReady = registerLiveChatTextAttachmentStager(
      "destination",
      notReady,
    );
    expect(notReady).toHaveBeenCalledWith(attachment);
    unregisterNotReady();

    const ready = vi.fn(() => true);
    const unregisterReady = registerLiveChatTextAttachmentStager(
      "destination",
      ready,
    );
    expect(ready).toHaveBeenCalledWith(attachment);
    unregisterReady();
  });

  it("lets a fast destination send wait for its fork attachment read", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    trackPendingTextAttachmentDelivery("destination", work);

    expect(hasPendingTextAttachmentDelivery("destination")).toBe(true);
    let waited = false;
    const waiting = waitForPendingTextAttachmentDeliveries("destination").then(
      () => {
        waited = true;
      },
    );
    await Promise.resolve();
    expect(waited).toBe(false);

    finish();
    await waiting;
    expect(waited).toBe(true);
    expect(hasPendingTextAttachmentDelivery("destination")).toBe(false);
  });
});

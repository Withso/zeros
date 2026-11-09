import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_SCROLLBAR_LINGER_MS,
  watchChatScrollbarReveal,
} from "../chat-scrollbar-reveal";

/** Just the parts of the transcript's scroller the reveal touches. */
class FakeScroller extends EventTarget {
  dataset: Record<string, string | undefined> = {};
  /** A drag on the bar ends wherever the pointer is let go. */
  ownerDocument = new EventTarget();
  /** What `closest(...)` answers for an event dispatched on this node. */
  inEditor = false;
  closest(selector: string) {
    return this.inEditor && selector.includes("contenteditable") ? this : null;
  }
}

function fire(target: EventTarget, type: string, fields: Record<string, unknown> = {}) {
  target.dispatchEvent(Object.assign(new Event(type), fields));
}

// 2026-11-09: the chat transcript's scrollbar shows only while the reader
// scrolls it. Streaming keeps the view on the tail with programmatic scrolls,
// and those never reveal it.
describe("watchChatScrollbarReveal", () => {
  let scroller: FakeScroller;
  let stop: () => void;
  let revealable = true;

  beforeEach(() => {
    vi.useFakeTimers();
    revealable = true;
    scroller = new FakeScroller();
    stop = watchChatScrollbarReveal(scroller as unknown as HTMLElement, () => revealable);
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("stays hidden while the agent streams and the view follows the tail", () => {
    for (let i = 0; i < 6; i += 1) {
      fire(scroller, "scroll");
      vi.advanceTimersByTime(120);
    }
    expect(scroller.dataset.scrolling).toBeUndefined();
  });

  it("shows for the wheel and touch, then hides once the reader stops", () => {
    fire(scroller, "wheel");
    expect(scroller.dataset.scrolling).toBe("true");
    fire(scroller, "scroll");
    vi.advanceTimersByTime(CHAT_SCROLLBAR_LINGER_MS - 1);
    expect(scroller.dataset.scrolling).toBe("true");
    vi.advanceTimersByTime(1);
    expect(scroller.dataset.scrolling).toBeUndefined();
    fire(scroller, "touchmove");
    expect(scroller.dataset.scrolling).toBe("true");
  });

  it("keeps showing through the smooth scroll a key starts, but not for later scrolls", () => {
    fire(scroller, "keydown", { key: "PageDown" });
    expect(scroller.dataset.scrolling).toBe("true");
    // The key's smooth scroll is still landing: it is the reader's, and it
    // keeps the bar up for another full linger.
    vi.advanceTimersByTime(CHAT_SCROLLBAR_LINGER_MS - 100);
    fire(scroller, "scroll");
    vi.advanceTimersByTime(CHAT_SCROLLBAR_LINGER_MS - 1);
    expect(scroller.dataset.scrolling).toBe("true");
    vi.advanceTimersByTime(1);
    expect(scroller.dataset.scrolling).toBeUndefined();
    // Long after the key, the stream's own scrolls stay quiet.
    fire(scroller, "scroll");
    expect(scroller.dataset.scrolling).toBeUndefined();
  });

  it("shows while the reader drags the bar, and only until they let go", () => {
    fire(scroller, "pointerdown", { button: 0 });
    fire(scroller, "scroll");
    vi.advanceTimersByTime(CHAT_SCROLLBAR_LINGER_MS * 2);
    fire(scroller, "scroll");
    expect(scroller.dataset.scrolling).toBe("true");
    fire(scroller.ownerDocument, "pointerup");
    vi.advanceTimersByTime(CHAT_SCROLLBAR_LINGER_MS * 2);
    fire(scroller, "scroll");
    expect(scroller.dataset.scrolling).toBeUndefined();
  });

  it("shows nothing for a click, even when the view then follows the tail", () => {
    fire(scroller, "pointerdown", { button: 0 });
    expect(scroller.dataset.scrolling).toBeUndefined();
    fire(scroller.ownerDocument, "pointerup");
    fire(scroller, "scroll");
    expect(scroller.dataset.scrolling).toBeUndefined();
  });

  it("ignores keys that edit text rather than scroll", () => {
    fire(scroller, "keydown", { key: "a" });
    expect(scroller.dataset.scrolling).toBeUndefined();
    scroller.inEditor = true;
    fire(scroller, "keydown", { key: "ArrowDown" });
    expect(scroller.dataset.scrolling).toBeUndefined();
  });

  it("never shows while the chat is hidden or restoring its position", () => {
    revealable = false;
    fire(scroller, "wheel");
    fire(scroller, "keydown", { key: "End" });
    expect(scroller.dataset.scrolling).toBeUndefined();
  });

  it("stops listening and clears the flag when the chat lets go of the scroller", () => {
    fire(scroller, "wheel");
    stop();
    expect(scroller.dataset.scrolling).toBeUndefined();
    fire(scroller, "wheel");
    expect(scroller.dataset.scrolling).toBeUndefined();
  });
});

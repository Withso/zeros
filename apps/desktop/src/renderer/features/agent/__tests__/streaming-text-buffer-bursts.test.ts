import { describe, expect, it } from "vitest";
import { StreamingTextBuffer } from "../renderers/streaming-text-buffer";

describe("streaming text bursts between presentation frames", () => {
  it.each([
    ["👩", "👩🏽", "👩🏽‍💻 done"],
    ["\ud83c", "🇮", "🇮🇳 done"],
  ])("keeps continued clusters intact after multiple pushes: %s", (initial, next, final) => {
    const buffer = new StreamingTextBuffer(initial);
    buffer.push(next, 0);
    buffer.push(final, 1);
    const boundaries = new Set(
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(final)]
        .map((part) => part.index + part.segment.length),
    );
    let shown = buffer.text.length;
    for (let time = 2; time <= 161; time++) {
      const text = buffer.advance(time);
      expect(final.startsWith(text)).toBe(true);
      // A new chunk may extend already-visible text into a larger cluster.
      // Every subsequent reveal must stop at a boundary in the new target.
      if (text.length !== shown) expect(boundaries.has(text.length)).toBe(true);
      shown = text.length;
    }
    expect(buffer.text).toBe(final);
    expect(buffer.pending).toBe(false);
  });

  it("retains regional-indicator parity when a revealed trailing surrogate is completed", () => {
    const buffer = new StreamingTextBuffer("a");
    buffer.push("a 🇮\ud83c", 0);
    expect(buffer.advance(100)).toBe("a 🇮\ud83c");
    buffer.push("a 🇮🇳🇺🇸 done", 101);
    // The completed surrogate changes the final code point into a regional
    // indicator. That removes the boundary before it, not just the old end.
    expect(buffer.advance(102)).toBe("a 🇮🇳");
  });
});

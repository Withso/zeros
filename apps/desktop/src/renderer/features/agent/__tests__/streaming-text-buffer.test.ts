import { describe, expect, it } from "vitest";
import { StreamingTextBuffer } from "../renderers/streaming-text-buffer";

describe("assistant text presentation buffer", () => {
  it("shows mounted history immediately and spreads appended chunks across frames", () => {
    const buffer = new StreamingTextBuffer("Existing answer.");
    expect(buffer.text).toBe("Existing answer.");
    buffer.push("Existing answer. A new paragraph streams here.", 0);
    const first = buffer.advance(32);
    expect(first.startsWith("Existing answer.")).toBe(true);
    expect(first.length).toBeLessThan(buffer.target.length);
    expect(buffer.advance(160)).toBe(buffer.target);
    expect(buffer.pending).toBe(false);
  });

  it("bounds backlog even when chunks keep arriving and frames are delayed", () => {
    const buffer = new StreamingTextBuffer("");
    buffer.push("a".repeat(200), 0);
    buffer.advance(32);
    buffer.push("a".repeat(400), 120);
    expect(buffer.advance(160)).toHaveLength(400);
    buffer.push("a".repeat(600), 180);
    expect(buffer.advance(900)).toHaveLength(600);
  });

  it("flushes corrections, truncations, large chunks and stop without replaying text", () => {
    const buffer = new StreamingTextBuffer("Draft");
    buffer.push("Draft suffix", 0);
    buffer.push("Corrected", 1);
    expect(buffer.text).toBe("Corrected");
    buffer.push("C", 2);
    expect(buffer.text).toBe("C");
    buffer.push("C".repeat(5_000), 3);
    expect(buffer.text).toHaveLength(5_000);
    buffer.push("C".repeat(5_050), 4);
    buffer.flush();
    expect(buffer.text).toBe(buffer.target);
    expect(buffer.pending).toBe(false);
  });

  it("never reveals half an emoji or a combining sequence", () => {
    const buffer = new StreamingTextBuffer("");
    const text = "👩🏽‍💻".repeat(8) + "e\u0301".repeat(8);
    const boundaries = new Set(
      [
        ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
          text,
        ),
      ].map((part) => part.index + part.segment.length),
    );
    buffer.push(text, 0);
    for (let time = 1; time < 161; time++) {
      const value = buffer.advance(time);
      expect(value === "" || boundaries.has(value.length)).toBe(true);
      expect(text.startsWith(value)).toBe(true);
    }
    expect(buffer.text).toBe(text);
  });
});

import { describe, expect, it, vi } from "vitest";
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

describe("assistant text presentation buffer cost", () => {
  it("segments only the unrevealed tail, not the whole reply, on each chunk", () => {
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    try {
      const revealed = "Long settled answer. ".repeat(1_400); // ~29K chars
      const buffer = new StreamingTextBuffer(revealed);
      segment.mockClear();
      buffer.push(`${revealed}one more sentence`, 0);
      const lengths = segment.mock.calls.map(([input]) => String(input).length);
      expect(lengths.length).toBeGreaterThan(0);
      // The already-shown 29K prefix is never re-scanned; only the new text and
      // a short window before it (a continued emoji or combining mark).
      expect(Math.max(...lengths)).toBeLessThan(200);
      expect(buffer.advance(160)).toBe(buffer.target);
    } finally {
      segment.mockRestore();
    }
  });

  it("keeps grapheme-safe reveals when a chunk continues an emoji or combining mark", () => {
    const final = `${"done ".repeat(40)}👩🏽‍💻 and é ok 🇮🇳 end`;
    const boundaries = new Set(
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(final)]
        .map((part) => part.index + part.segment.length),
    );
    // Split inside the ZWJ sequence, before the combining accent and between
    // the two regional indicators, so each chunk continues the previous one.
    const cuts = [final.indexOf("👩🏽") + 4, final.indexOf("́"), final.indexOf("🇮🇳") + 2, final.length];
    const buffer = new StreamingTextBuffer("");
    let time = 0;
    for (const cut of cuts) {
      buffer.push(final.slice(0, cut), time);
      for (let step = 0; step < 6; step++) {
        time += 16;
        buffer.advance(time);
      }
    }
    for (let step = 0; step < 20; step++) {
      time += 16;
      const value = buffer.advance(time);
      expect(final.startsWith(value)).toBe(true);
      expect(boundaries.has(value.length)).toBe(true);
    }
    expect(buffer.text).toBe(final);
  });
});

describe("assistant text presentation buffer boundaries", () => {
  // Deterministic stress: random replies built from clusters that continue
  // across chunk edges, streamed in random chunks, checked against a full
  // segmentation of the target at every frame.
  const pieces = ["a", "b", " ", "\n", "é", "́", "👩", "🏽", "‍", "💻", "🇮", "🇳",
    "한", "ᄀ", "ᅡ", "ᆨ", "中", "\r", "\r\n", "1️⃣", "𝒳", "क्ष"];
  function random(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const boundariesOf = (text: string) =>
    new Set([0, ...[...segmenter.segment(text)].map((part) => part.index + part.segment.length)]);

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("reveals only full-text grapheme boundaries (seed %i)", (seed) => {
    const next = random(seed);
    let target = "";
    while (target.length < 900) target += pieces[Math.floor(next() * pieces.length)];
    const buffer = new StreamingTextBuffer("");
    let time = 0;
    for (let cut = 0; cut < target.length;) {
      cut = Math.min(target.length, cut + 1 + Math.floor(next() * 40));
      const current = target.slice(0, cut);
      buffer.push(current, time);
      const valid = boundariesOf(current);
      for (let frame = 0; frame < 1 + Math.floor(next() * 3); frame++) {
        time += 8 + Math.floor(next() * 16);
        const before = buffer.text.length;
        const shown = buffer.advance(time);
        expect(current.startsWith(shown)).toBe(true);
        // Text already on screen may end mid-cluster once the newest chunk
        // continues it; every NEW reveal must stop on a true boundary.
        if (shown.length !== before) expect(valid.has(shown.length)).toBe(true);
      }
    }
    for (let frame = 0; frame < 30; frame++) {
      time += 16;
      const shown = buffer.advance(time);
      expect(boundariesOf(target).has(shown.length)).toBe(true);
    }
    expect(buffer.text).toBe(target);
  });
});

describe("assistant text presentation buffer continuing clusters", () => {
  it("never stops after a zero-width joiner that a later chunk continues", () => {
    const first = "Built ok 👩🏽";
    const final = `${first}‍💻 done`;
    const boundaries = new Set(
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(final)]
        .map((part) => part.index + part.segment.length),
    );
    const buffer = new StreamingTextBuffer("Built");
    buffer.push(first, 0);
    expect(buffer.advance(200)).toBe(first);
    // The newest chunk continues the visible emoji into a ZWJ sequence.
    buffer.push(final, 300);
    let time = 300;
    let shown = buffer.text.length;
    while (buffer.pending) {
      time += 1;
      const value = buffer.advance(time);
      if (value.length !== shown) expect(boundaries.has(value.length)).toBe(true);
      shown = value.length;
    }
    expect(buffer.text).toBe(final);
  });
});

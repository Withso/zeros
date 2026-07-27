import { describe, it, expect } from "vitest";
import type { ThemedToken } from "shiki";
import { buildShikiDecorations } from "../shiki-highlight";

const tok = (content: string, offset: number, color?: string): ThemedToken =>
  ({ content, offset, color }) as ThemedToken;

describe("buildShikiDecorations", () => {
  it("emits one mark per COLORED token with correct ranges", () => {
    // "const"(colored) " "(no color → skipped) "x"(colored)
    // check:ui ignore-next (fixture verifies arbitrary Shiki token colors)
    const set = buildShikiDecorations(
      [
        [
          tok("const", 0, "#ff0000"), // check:ui ignore-line (fixture token color)
          tok(" ", 5),
          tok("x", 6, "#00ff00"), // check:ui ignore-line (fixture token color)
        ],
      ],
      7,
    );
    expect(set.size).toBe(2);
  });

  it("skips empty tokens and tokens out of document range", () => {
    const set = buildShikiDecorations(
      [
        [
          tok("", 0, "#fff"), // check:ui ignore-line (fixture token color)
          tok("ab", 0, "#fff"), // check:ui ignore-line (fixture token color)
          tok("xyz", 100, "#fff"), // check:ui ignore-line (fixture token color)
        ],
      ],
      2, // docLen 2 → "xyz" at offset 100 is out of range
    );
    expect(set.size).toBe(1); // only "ab" [0,2)
  });

  it("handles an empty document (no tokens)", () => {
    expect(buildShikiDecorations([[]], 0).size).toBe(0);
  });

  it("keeps multi-line tokens in sorted order without throwing", () => {
    // line 1: "ab" @0 ; line 2: "cd" @3 (offset 2 is the newline, untokenized)
    const set = buildShikiDecorations(
      [
        [tok("ab", 0, "#fff")], // check:ui ignore-line (fixture token color)
        [tok("cd", 3, "#fff")], // check:ui ignore-line (fixture token color)
      ],
      5,
    );
    expect(set.size).toBe(2);
  });
});

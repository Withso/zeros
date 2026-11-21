import { describe, expect, it } from "vitest";
import { THOUGHT_PREVIEW_FILL, thoughtPreview } from "../renderers/thought-preview";

describe("thinking description", () => {
  it("does not change across appends once set", () => {
    const thought = "**Planning the header**\nI need to count thinking rows as work, then check the loader line and its dwell. " +
      "More reasoning keeps streaming here for a while, with several further sentences that never reach the pill.";
    const seen = new Set<string>();
    let first = -1;
    for (let length = 0; length <= thought.length; length++) {
      const preview = thoughtPreview(thought.slice(0, length), false);
      if (preview === undefined) {
        expect(first).toBe(-1);
        continue;
      }
      if (first < 0) first = length;
      seen.add(preview);
    }
    expect([...seen]).toEqual(["Planning the header"]);
    expect(thoughtPreview(thought, true)).toBe("Planning the header");
  });

  it("waits for a complete first sentence, else enough text to fill the pill", () => {
    expect(thoughtPreview("Checking the partition", false)).toBeUndefined();
    expect(thoughtPreview("Checking the partition. Then", false)).toBe("Checking the partition.");
    // A final "." may still become "3.5" or "...": only whitespace after it ends the sentence.
    expect(thoughtPreview("Version 3.", false)).toBeUndefined();
    const long = "word ".repeat(40);
    const preview = thoughtPreview(long, false)!;
    expect(preview).toBe(long.slice(0, THOUGHT_PREVIEW_FILL).trim());
    expect(thoughtPreview(`${long}and more`, false)).toBe(preview);
  });

  it("shows a short finished thought whole, and nothing for whitespace", () => {
    expect(thoughtPreview("Done", true)).toBe("Done");
    expect(thoughtPreview("  \n ", true)).toBeUndefined();
    expect(thoughtPreview("\n\nAfter a blank line. More", false)).toBe("After a blank line.");
  });
});

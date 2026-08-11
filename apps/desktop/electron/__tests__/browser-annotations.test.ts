import { describe, expect, it } from "vitest";
import { parseBrowserAnnotations } from "../browser/annotations";

describe("browser screenshot annotations", () => {
  it("accepts bounded semantic refs and labels", () => {
    expect(
      parseBrowserAnnotations([
        { ref: "b1", label: "Primary CTA" },
        { ref: "b22" },
      ]),
    ).toEqual([
      { ref: "b1", label: "Primary CTA" },
      { ref: "b22", label: "2" },
    ]);
  });

  it("rejects stale refs and excessive overlays", () => {
    expect(() => parseBrowserAnnotations([{ ref: "bad" }])).toThrow(/ref/i);
    expect(() =>
      parseBrowserAnnotations(
        Array.from({ length: 21 }, (_, index) => ({ ref: `b${index + 1}` })),
      ),
    ).toThrow(/20/i);
  });
});

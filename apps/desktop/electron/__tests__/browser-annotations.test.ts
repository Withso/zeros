import { describe, expect, it } from "vitest";
import { parseBrowserAnnotations } from "../browser/annotations";

describe("browser screenshot annotations", () => {
  it("accepts bounded semantic refs and labels", () => {
    expect(
      parseBrowserAnnotations([
        { ref: "b1_0123456789abcdef01234567", label: "Primary CTA" },
        { ref: "b22_abcdefabcdefabcdefabcdef" },
      ]),
    ).toEqual([
      { ref: "b1_0123456789abcdef01234567", label: "Primary CTA" },
      { ref: "b22_abcdefabcdefabcdefabcdef", label: "2" },
    ]);
  });

  it("rejects stale refs and excessive overlays", () => {
    expect(() => parseBrowserAnnotations([{ ref: "bad" }])).toThrow(/ref/i);
    expect(() => parseBrowserAnnotations([{ ref: "b1" }])).toThrow(/ref/i);
    expect(() =>
      parseBrowserAnnotations(
        Array.from({ length: 21 }, (_, index) => ({
          ref: `b${index + 1}_0123456789abcdef01234567`,
        })),
      ),
    ).toThrow(/20/i);
  });
});

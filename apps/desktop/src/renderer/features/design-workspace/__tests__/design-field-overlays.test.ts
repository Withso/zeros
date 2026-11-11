import { describe, expect, it } from "vitest";

import { designInputResetsOnAltBackspace } from "../design-field-overlays";

const input = (value: string, selectionStart: number | null, selectionEnd: number | null) => ({
  value,
  selectionStart,
  selectionEnd,
});

describe("Alt+Backspace in a Style text field", () => {
  it("resets only when no word sits before a caret: all selected, or empty", () => {
    // Tabbing into a field selects its value.
    expect(designInputResetsOnAltBackspace(input("12px solid", 0, 10))).toBe(true);
    expect(designInputResetsOnAltBackspace(input("", 0, 0))).toBe(true);
  });

  it("leaves the keys to delete a word while a caret or a partial selection is in the text", () => {
    expect(designInputResetsOnAltBackspace(input("12px solid", 10, 10))).toBe(false);
    expect(designInputResetsOnAltBackspace(input("12px solid", 5, 10))).toBe(false);
    expect(designInputResetsOnAltBackspace(input("12px solid", 0, 4))).toBe(false);
    // An input type without a text selection reports null.
    expect(designInputResetsOnAltBackspace(input("12", null, null))).toBe(false);
  });
});

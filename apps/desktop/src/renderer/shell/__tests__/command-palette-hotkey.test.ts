import { describe, expect, it } from "vitest";
import { matchesCommandPaletteHotkey } from "../use-command-palette-hotkey";

const key = {
  code: "KeyK",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
};

describe("command palette shortcut", () => {
  it("accepts Command+K and Control+K", () => {
    expect(matchesCommandPaletteHotkey(key)).toBe(true);
    expect(
      matchesCommandPaletteHotkey({ ...key, metaKey: false, ctrlKey: true }),
    ).toBe(true);
  });

  it.each([
    { metaKey: false },
    { altKey: true },
    { shiftKey: true },
    { code: "KeyJ" },
    { repeat: true },
    { isComposing: true },
  ])(
    "leaves typing, other chords, composition and held keys alone: %j",
    (change) => {
      expect(matchesCommandPaletteHotkey({ ...key, ...change })).toBe(false);
    },
  );
});

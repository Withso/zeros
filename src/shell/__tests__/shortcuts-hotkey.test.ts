import { describe, expect, it } from "vitest";

import { matchesShortcutsHotkey } from "../use-shortcuts-hotkey";

function key(
  overrides: Partial<
    Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "code">
  > = {},
) {
  return {
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    code: "Slash",
    ...overrides,
  };
}

describe("matchesShortcutsHotkey", () => {
  it("matches Command+/ and Control+/", () => {
    expect(matchesShortcutsHotkey(key())).toBe(true);
    expect(
      matchesShortcutsHotkey(key({ metaKey: false, ctrlKey: true })),
    ).toBe(true);
  });

  it("rejects Option/Alt so it never collides with ⌥⌘ chords", () => {
    expect(matchesShortcutsHotkey(key({ altKey: true }))).toBe(false);
  });

  it("rejects a bare slash and non-slash keys", () => {
    expect(
      matchesShortcutsHotkey(key({ metaKey: false, ctrlKey: false })),
    ).toBe(false);
    expect(matchesShortcutsHotkey(key({ code: "KeyK" }))).toBe(false);
  });
});

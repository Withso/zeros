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
    altKey: true,
    code: "Slash",
    ...overrides,
  };
}

describe("matchesShortcutsHotkey", () => {
  it("matches Command+Option+/ and Control+Alt+/", () => {
    expect(matchesShortcutsHotkey(key())).toBe(true);
    expect(
      matchesShortcutsHotkey(key({ metaKey: false, ctrlKey: true })),
    ).toBe(true);
  });

  it("rejects Command+/ and Control+/ without Option/Alt", () => {
    expect(matchesShortcutsHotkey(key({ altKey: false }))).toBe(false);
    expect(
      matchesShortcutsHotkey(
        key({ metaKey: false, ctrlKey: true, altKey: false }),
      ),
    ).toBe(false);
  });

  it("rejects slash without Command/Control and non-slash keys", () => {
    expect(
      matchesShortcutsHotkey(key({ metaKey: false, ctrlKey: false })),
    ).toBe(false);
    expect(
      matchesShortcutsHotkey(
        key({ metaKey: false, ctrlKey: false, altKey: false }),
      ),
    ).toBe(false);
    expect(matchesShortcutsHotkey(key({ code: "KeyK" }))).toBe(false);
  });
});

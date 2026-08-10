import { describe, expect, it } from "vitest";

import { matchesOpenBrowserHotkey } from "../use-open-browser-hotkey";

function key(
  overrides: Partial<
    Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">
  > = {},
) {
  return {
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    code: "KeyB",
    ...overrides,
  };
}

describe("matchesOpenBrowserHotkey", () => {
  it("accepts Command/Ctrl-Shift-B", () => {
    expect(matchesOpenBrowserHotkey(key())).toBe(true);
    expect(
      matchesOpenBrowserHotkey(
        key({ metaKey: false, ctrlKey: true }),
      ),
    ).toBe(true);
  });

  it("rejects missing Shift, Option, and unrelated keys", () => {
    expect(matchesOpenBrowserHotkey(key({ shiftKey: false }))).toBe(false);
    expect(matchesOpenBrowserHotkey(key({ altKey: true }))).toBe(false);
    expect(matchesOpenBrowserHotkey(key({ code: "KeyD" }))).toBe(false);
  });
});

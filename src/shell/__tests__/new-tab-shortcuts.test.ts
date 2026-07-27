import { describe, expect, it } from "vitest";

import { resolveNewTabShortcut } from "../use-new-chat-hotkey";

function key(
  overrides: Partial<
    Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">
  > = {},
) {
  return {
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    code: "KeyT",
    ...overrides,
  };
}

describe("resolveNewTabShortcut", () => {
  it("maps Command-T to a chat regardless of terminal availability", () => {
    expect(resolveNewTabShortcut(key(), false)).toBe("chat");
    expect(resolveNewTabShortcut(key(), true)).toBe("chat");
  });

  it("maps Command-Shift-T to Terminal only when Terminal Agents is enabled", () => {
    expect(resolveNewTabShortcut(key({ shiftKey: true }), true)).toBe(
      "terminal",
    );
    expect(resolveNewTabShortcut(key({ shiftKey: true }), false)).toBeNull();
  });

  it("ignores Ctrl, Option, and unrelated keys", () => {
    expect(
      resolveNewTabShortcut(key({ metaKey: false, ctrlKey: true }), true),
    ).toBeNull();
    expect(resolveNewTabShortcut(key({ altKey: true }), true)).toBeNull();
    expect(resolveNewTabShortcut(key({ code: "KeyN" }), true)).toBeNull();
  });
});

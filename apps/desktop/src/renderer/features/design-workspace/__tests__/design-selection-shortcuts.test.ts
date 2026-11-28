import { describe, expect, it } from "vitest";

import {
  resolveDesignSelectionShortcut,
  type DesignSelectionShortcutEvent,
} from "../design-selection-shortcuts";

function shortcutEvent(
  overrides: Partial<DesignSelectionShortcutEvent> = {},
): DesignSelectionShortcutEvent {
  return {
    key: "c",
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    ...overrides,
  };
}

describe("design selection shortcuts", () => {
  it("maps native copy and deletion keys for a focused selection", () => {
    expect(resolveDesignSelectionShortcut(shortcutEvent(), false, true)).toBe(
      "copy",
    );
    expect(
      resolveDesignSelectionShortcut(
        shortcutEvent({ metaKey: false, ctrlKey: true, key: "C" }),
        false,
        true,
      ),
    ).toBe("copy");
    expect(
      resolveDesignSelectionShortcut(shortcutEvent({ key: "d" }), false, true),
    ).toBe("duplicate");
    expect(
      resolveDesignSelectionShortcut(
        shortcutEvent({ key: "Delete", metaKey: false }),
        false,
        true,
      ),
    ).toBe("delete");
    expect(
      resolveDesignSelectionShortcut(
        shortcutEvent({ key: "Backspace", metaKey: false }),
        false,
        true,
      ),
    ).toBe("delete");
  });

  it("leaves editable fields and unrelated or inactive selections alone", () => {
    expect(
      resolveDesignSelectionShortcut(shortcutEvent(), true, true),
    ).toBeNull();
    expect(
      resolveDesignSelectionShortcut(shortcutEvent(), false, false),
    ).toBeNull();
    expect(
      resolveDesignSelectionShortcut(
        shortcutEvent({ key: "c", metaKey: false }),
        false,
        true,
      ),
    ).toBeNull();
    expect(
      resolveDesignSelectionShortcut(
        shortcutEvent({ key: "Delete", metaKey: false, shiftKey: true }),
        false,
        true,
      ),
    ).toBeNull();
  });

  it("rejects repeated, composing, handled, and alternate chords", () => {
    for (const overrides of [
      { repeat: true },
      { isComposing: true },
      { defaultPrevented: true },
      { altKey: true },
      { shiftKey: true },
    ]) {
      expect(
        resolveDesignSelectionShortcut(shortcutEvent(overrides), false, true),
      ).toBeNull();
    }
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  dispatchDesignWorkspaceShortcut,
  resolveDesignWorkspaceShortcut,
  type DesignWorkspaceShortcutEvent,
} from "../design-workspace-shortcuts";

function shortcutEvent(
  overrides: Partial<DesignWorkspaceShortcutEvent> = {},
): DesignWorkspaceShortcutEvent {
  return {
    key: "z",
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...overrides,
  };
}

describe("design workspace shortcuts", () => {
  it("maps the native Mac and Windows save, undo, and redo chords", () => {
    expect(
      resolveDesignWorkspaceShortcut(shortcutEvent({ key: "s" }), false),
    ).toBe("save");
    expect(
      resolveDesignWorkspaceShortcut(
        shortcutEvent({ key: "S", metaKey: false, ctrlKey: true }),
        false,
      ),
    ).toBe("save");
    expect(resolveDesignWorkspaceShortcut(shortcutEvent(), false)).toBe("undo");
    expect(
      resolveDesignWorkspaceShortcut(
        shortcutEvent({ metaKey: false, ctrlKey: true, shiftKey: true }),
        false,
      ),
    ).toBe("redo");
  });

  it("saves from an editable draft but leaves its native undo history alone", () => {
    expect(
      resolveDesignWorkspaceShortcut(shortcutEvent({ key: "s" }), true),
    ).toBe("save");
    expect(resolveDesignWorkspaceShortcut(shortcutEvent(), true)).toBeNull();
    expect(
      resolveDesignWorkspaceShortcut(shortcutEvent({ shiftKey: true }), true),
    ).toBeNull();
  });

  it("preserves Windows Ctrl+Y redo without stealing Command-Y or text history", () => {
    const event = shortcutEvent({ key: "y", ctrlKey: true, metaKey: false });
    expect(resolveDesignWorkspaceShortcut(event, false)).toBe("redo");
    expect(resolveDesignWorkspaceShortcut(event, true)).toBeNull();
    expect(resolveDesignWorkspaceShortcut({ ...event, shiftKey: true }, false)).toBeNull();
    expect(resolveDesignWorkspaceShortcut({ ...event, ctrlKey: false, metaKey: true }, false)).toBeNull();
  });

  it("rejects partial, composing, alternate, and Save As chords", () => {
    expect(
      resolveDesignWorkspaceShortcut(shortcutEvent({ metaKey: false }), false),
    ).toBeNull();
    expect(
      resolveDesignWorkspaceShortcut(
        shortcutEvent({ key: "s", shiftKey: true }),
        false,
      ),
    ).toBeNull();
    expect(
      resolveDesignWorkspaceShortcut(shortcutEvent({ altKey: true }), false),
    ).toBeNull();
    expect(
      resolveDesignWorkspaceShortcut(
        shortcutEvent({ isComposing: true }),
        false,
      ),
    ).toBeNull();
  });

  it("dispatches every rapid history command without dropping an in-flight press", () => {
    const preventDefault = vi.fn();
    const undo = vi.fn();
    const actions = { save: vi.fn(), undo, redo: vi.fn() };
    const event = { ...shortcutEvent(), preventDefault };

    expect(dispatchDesignWorkspaceShortcut(event, false, actions)).toBe(true);
    expect(dispatchDesignWorkspaceShortcut(event, false, actions)).toBe(true);

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(undo).toHaveBeenCalledTimes(2);
  });
});

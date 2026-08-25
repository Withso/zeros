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
  it("maps the native Mac and Windows stage, undo, and redo chords", () => {
    expect(
      resolveDesignWorkspaceShortcut(shortcutEvent({ key: "s" }), false),
    ).toBe("stage");
    expect(
      resolveDesignWorkspaceShortcut(
        shortcutEvent({ key: "S", metaKey: false, ctrlKey: true }),
        false,
      ),
    ).toBe("stage");
    expect(resolveDesignWorkspaceShortcut(shortcutEvent(), false)).toBe("undo");
    expect(
      resolveDesignWorkspaceShortcut(
        shortcutEvent({ metaKey: false, ctrlKey: true, shiftKey: true }),
        false,
      ),
    ).toBe("redo");
  });

  it("stages from an editable draft but leaves its native undo history alone", () => {
    expect(
      resolveDesignWorkspaceShortcut(shortcutEvent({ key: "s" }), true),
    ).toBe("stage");
    expect(resolveDesignWorkspaceShortcut(shortcutEvent(), true)).toBeNull();
    expect(
      resolveDesignWorkspaceShortcut(shortcutEvent({ shiftKey: true }), true),
    ).toBeNull();
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
    const actions = { stage: vi.fn(), undo, redo: vi.fn() };
    const event = { ...shortcutEvent(), preventDefault };

    expect(dispatchDesignWorkspaceShortcut(event, false, actions)).toBe(true);
    expect(dispatchDesignWorkspaceShortcut(event, false, actions)).toBe(true);

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(undo).toHaveBeenCalledTimes(2);
  });
});

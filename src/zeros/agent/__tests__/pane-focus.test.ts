import { describe, expect, it } from "vitest";

import { isInFocusedPane } from "../pane-focus";

function mockElement({
  connected = true,
  hidden = false,
  paneFocused = null,
}: {
  connected?: boolean;
  hidden?: boolean;
  paneFocused?: boolean | null;
} = {}): Element {
  return {
    isConnected: connected,
    closest(selector: string) {
      if (selector.includes("[inert]")) return hidden ? this : null;
      if (selector === "[data-pane-root]") {
        if (paneFocused === null) return null;
        return {
          getAttribute: () => (paneFocused ? "true" : "false"),
        } as unknown as Element;
      }
      return null;
    },
  } as unknown as Element;
}

describe("isInFocusedPane", () => {
  it("accepts a visible element in the focused pane", () => {
    expect(isInFocusedPane(mockElement({ paneFocused: true }))).toBe(true);
  });

  it("rejects inactive panes and retained inert layers", () => {
    expect(isInFocusedPane(mockElement({ paneFocused: false }))).toBe(false);
    expect(
      isInFocusedPane(mockElement({ paneFocused: true, hidden: true })),
    ).toBe(false);
  });

  it("keeps standalone flows but rejects detached elements", () => {
    expect(isInFocusedPane(mockElement())).toBe(true);
    expect(isInFocusedPane(mockElement({ connected: false }))).toBe(false);
  });
});

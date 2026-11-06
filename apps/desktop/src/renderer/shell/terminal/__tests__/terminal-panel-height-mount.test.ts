// @vitest-environment jsdom
import { createElement as h, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useTerminalPanelLayoutStore } from "../terminal-panel-layout";
import { TERMINAL_PANEL_HEIGHT_VAR, TerminalPanelResizer } from "../terminal-panel-resizer";

// The resizer applies the stored height from a layout effect, and React
// attaches a parent's ref only after its children's layout effects. A
// container that mounts in the same commit as the panel, as the side column
// does when it returns from read-only history, is still null there.
function Container() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  return h(
    "div",
    { ref: containerRef },
    h(TerminalPanelResizer, { containerRef }),
    h("div", { "data-terminal-panel": "", id: "panel" }),
  );
}

afterEach(() => {
  useTerminalPanelLayoutStore.getState().reset();
  document.body.replaceChildren();
});

describe("terminal panel height on mount", () => {
  it("applies the stored height when the panel mounts together with its container", () => {
    useTerminalPanelLayoutStore.getState().setHeightPct(37);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    flushSync(() => root.render(h(Container)));
    const panel = document.querySelector<HTMLElement>("#panel")!;
    expect(panel.style.getPropertyValue(TERMINAL_PANEL_HEIGHT_VAR)).toBe("37%");
    root.unmount();
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_PANEL_LAYOUT,
  TERMINAL_PANEL_DEFAULT_PCT,
  clampTerminalPanelHeightPct,
  normalizeTerminalPanelLayout,
  useTerminalPanelLayoutStore,
} from "../terminal-panel-layout";

describe("terminal-panel layout", () => {
  beforeEach(() => {
    useTerminalPanelLayoutStore.setState({
      layout: { ...DEFAULT_TERMINAL_PANEL_LAYOUT },
    });
  });

  it("defaults to an expanded 50/50 split", () => {
    expect(useTerminalPanelLayoutStore.getState().layout).toEqual({
      expanded: true,
      heightPct: 50,
    });
  });

  it("shares one resize and collapse preference across all workspaces", () => {
    const store = useTerminalPanelLayoutStore.getState();
    store.setHeightPct(63);
    store.setExpanded(false);

    // A single global layout: whatever workspace reads it next sees the same
    // height and collapsed state — switching is a clean switch.
    expect(useTerminalPanelLayoutStore.getState().layout).toEqual({
      expanded: false,
      heightPct: 63,
    });
  });

  it("centers and expands on reset", () => {
    const store = useTerminalPanelLayoutStore.getState();
    store.setHeightPct(70);
    store.setExpanded(false);
    store.reset();

    expect(useTerminalPanelLayoutStore.getState().layout).toEqual({
      expanded: true,
      heightPct: TERMINAL_PANEL_DEFAULT_PCT,
    });
  });

  it("sanitizes corrupt persisted percentages and malformed layouts", () => {
    expect(clampTerminalPanelHeightPct(Number.NaN)).toBe(50);
    expect(clampTerminalPanelHeightPct(-20)).toBe(5);
    expect(clampTerminalPanelHeightPct(120)).toBe(95);
    expect(
      normalizeTerminalPanelLayout({ expanded: false, heightPct: 67 }),
    ).toEqual({ expanded: false, heightPct: 67 });
    expect(
      normalizeTerminalPanelLayout({ expanded: "no", heightPct: -2 }),
    ).toEqual({ expanded: true, heightPct: 5 });
    expect(normalizeTerminalPanelLayout({})).toEqual({
      expanded: true,
      heightPct: 50,
    });
    expect(normalizeTerminalPanelLayout(null)).toEqual({
      expanded: true,
      heightPct: 50,
    });
    expect(normalizeTerminalPanelLayout([1, 2])).toEqual({
      expanded: true,
      heightPct: 50,
    });
  });
});

// The launch-time "columns resize into place" glitch, guarded.
//
// Conversation pane's grow factor reads --zeros-column-2-ratio. The variable used to be
// published only by a layout effect on the two-column row, and a DESCENDANT
// layout effect that measures (ChatPane's split-availability observer) flushes
// style before that write lands — so the browser resolved the columns once at
// the 0.5 CSS fallback and the real ratio arrived as a second style change,
// i.e. an animatable one. Publishing the value on <html> before the first
// render means the flush already sees the right number.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyBootLayoutVars } from "../boot-layout-vars";
import {
  LEGACY_CONVERSATION_WIDTH_KEY,
  CONVERSATION_RATIO_KEY,
  CONVERSATION_RATIO_VAR,
  readPersistedConversationRatio,
} from "../conversation/pane-sizing";
import { TERMINAL_PANEL_HEIGHT_VAR } from "../terminal/terminal-panel-layout";
import {
  DESIGN_WORKSPACE_LAYERS_WIDTH_KEY,
  DESIGN_WORKSPACE_LAYERS_WIDTH_VAR,
  DESIGN_WORKSPACE_STYLE_WIDTH_KEY,
  DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
} from "../../features/design-workspace/design-workspace-width";

// `environment: "node"` — stand up just enough of window/document for the
// boot write. `style` is a Map-backed CSSStyleDeclaration shim.
const store = new Map<string, string>();
const declared = new Map<string, string>();
const style = {
  setProperty: (name: string, value: string) => void declared.set(name, value),
  getPropertyValue: (name: string) => declared.get(name) ?? "",
  removeProperty: (name: string) => void declared.delete(name),
};
const stubWindow = {
  innerWidth: 1600,
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
};
const stubDocument = { documentElement: { style } };

function bootValue(): string {
  return declared.get(CONVERSATION_RATIO_VAR) ?? "";
}

describe("applyBootLayoutVars", () => {
  beforeEach(() => {
    store.clear();
    declared.clear();
    vi.stubGlobal("window", stubWindow);
    vi.stubGlobal("document", stubDocument);
    return () => vi.unstubAllGlobals();
  });

  it("publishes the persisted ratio on <html>", () => {
    store.set(CONVERSATION_RATIO_KEY, "0.35");
    applyBootLayoutVars();
    expect(bootValue()).toBe("0.35");
  });

  it("publishes the default when nothing is stored", () => {
    applyBootLayoutVars();
    expect(bootValue()).toBe("0.5");
  });

  it("publishes a clamped value for an out-of-range store", () => {
    store.set(CONVERSATION_RATIO_KEY, "0.95");
    applyBootLayoutVars();
    expect(bootValue()).toBe("0.7");
  });

  it("does not throw on a corrupt store, and still publishes something usable", () => {
    store.set(CONVERSATION_RATIO_KEY, "{{{");
    expect(() => applyBootLayoutVars()).not.toThrow();
    expect(bootValue()).toBe("0.5");
  });

  it("is inert when there is no document (SSR / non-browser import)", () => {
    vi.stubGlobal("document", undefined);
    expect(() => applyBootLayoutVars()).not.toThrow();
  });

  it("publishes the terminal panel height too", () => {
    // Same failure shape as the columns: the panel's flex-basis clamp reads
    // this variable, and the resizer's layout effect publishes it only after
    // a descendant may already have flushed style at the 50% fallback.
    store.set(
      "zeros:terminal-panel:layout-v2",
      JSON.stringify({ expanded: true, heightPct: 30 }),
    );
    applyBootLayoutVars();
    expect(declared.get(TERMINAL_PANEL_HEIGHT_VAR)).toBe("30%");
  });

  it("publishes Design's independent panel widths without changing Conversation pane", () => {
    store.set(CONVERSATION_RATIO_KEY, "0.6");
    store.set(DESIGN_WORKSPACE_LAYERS_WIDTH_KEY, "360");
    store.set(DESIGN_WORKSPACE_STYLE_WIDTH_KEY, "420");
    applyBootLayoutVars();
    expect(declared.get(CONVERSATION_RATIO_VAR)).toBe("0.6");
    expect(declared.get(DESIGN_WORKSPACE_LAYERS_WIDTH_VAR)).toBe("360px");
    expect(declared.get(DESIGN_WORKSPACE_STYLE_WIDTH_VAR)).toBe("420px");
  });

  it("agrees with what the column hook reads a moment later", () => {
    // The hook's initial state and this boot write must be the same number:
    // if they differ, the hook's layout effect changes an already-resolved
    // computed value and the columns visibly move on launch. The pixel-era
    // migration is the case most likely to drift, so exercise it here.
    store.set(LEGACY_CONVERSATION_WIDTH_KEY, "640");
    applyBootLayoutVars();
    expect(bootValue()).toBe(String(readPersistedConversationRatio()));
  });
});

// @vitest-environment jsdom
import { act, createElement, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesignTokenWire } from "../../../platform/git";
import { TooltipProvider } from "../../../shared/ui/primitives";
import { designFieldOrigins } from "../design-field-origins";
import { useDesignFieldOverlays, type DesignFieldOverlaysApi } from "../design-field-overlays";
import { DesignFieldOverlays } from "../design-style-card";
import { designTokenCatalog } from "../design-token-catalog";
import { DesignTokenCatalogContext } from "../design-token-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Node has no CSS object; the browser decides what paints as a colour.
vi.stubGlobal("CSS", { supports: (_property: string, value: string) => value === "silver", escape: (value: string) => value });
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const manual = (name: string, value: string): DesignTokenWire => ({
  name, syntax: "*", inherits: true, initialValue: "", value, themeValues: {}, usageCount: 0, line: 1,
});
const catalog = designTokenCatalog({ manual: [manual("--radius-md", "6px"), manual("--bg2", "silver")], sources: [], theme: null });
const chosen = vi.fn();
const reset = vi.fn();
const origins = designFieldOrigins([], { label: () => null, utilitySources: new Set() }, null);

let root: Root | null = null;
let host: HTMLDivElement;
let api: DesignFieldOverlaysApi | null = null;

function ApiProbe() {
  api = useDesignFieldOverlays();
  return null;
}

function mount(active: boolean, readOnly = false) {
  const rootRef = createRef<HTMLElement>();
  const panel = (children: ReactNode) =>
    createElement(TooltipProvider, {
      delayDuration: 100,
      children: createElement(DesignTokenCatalogContext.Provider, { value: catalog },
        createElement("aside", { ref: rootRef },
          createElement(DesignFieldOverlays, {
            rootRef, active, readOnly, ownerKey: "selection", origins,
            onChooseToken: chosen, onReset: reset,
            children,
          }))),
    });
  const children = [
    createElement(ApiProbe, { key: "api" }),
    createElement("div", { key: "radius", "data-design-style-property": "border-radius", "data-design-field-label": "Radius" },
      createElement("button", { type: "button", id: "radius" }, "Radius")),
    createElement("button", { key: "plain", type: "button", id: "plain" }, "Plain"),
    createElement("div", { key: "fill", id: "fill", "data-design-style-property": "background-color", "data-design-field-label": "Fill",
      "data-design-token-companion": "background-image:none" }),
    createElement("div", { key: "text", id: "text", "data-design-style-property": "color", "data-design-field-label": "Text color" }),
    // A gradient Fill: the card and Reset describe the gradient, a token is
    // still written to the colour.
    createElement("div", { key: "gradient", id: "gradient", "data-design-style-property": "background-image", "data-design-field-label": "Fill",
      "data-design-token-property": "background-color", "data-design-token-companion": "background-image:none" }),
  ];
  act(() => {
    root ??= createRoot(host);
    root.render(createElement("div", null, panel(children), createElement("button", { type: "button", id: "outside" }, "Outside")));
  });
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const tab = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

describe("the panel's overlays", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    api = null;
    host.remove();
    vi.useRealTimers();
  });

  it("closes the picker when the surface stops being shown", () => {
    mount(true);
    act(() => {
      expect(api!.openPickerForField(byId("radius").parentElement!)).toBe(true);
    });
    expect(document.querySelector("[data-design-token-picker]")).not.toBeNull();
    mount(false);
    expect(document.querySelector("[data-design-token-picker]")).toBeNull();
  });

  it("serves Alt+Down from a field outside the panel that forwards its keys", () => {
    mount(true);
    const portaled = document.createElement("div");
    portaled.setAttribute("data-design-style-property", "text-indent");
    portaled.setAttribute("data-design-field-label", "Indent");
    const input = document.createElement("input");
    portaled.append(input);
    document.body.append(portaled);
    const prevent = vi.fn();
    try {
      act(() => api!.fieldShortcut({ key: "ArrowDown", altKey: true, metaKey: false, ctrlKey: false, target: input,
        preventDefault: prevent, stopPropagation: () => {} }));
      expect(prevent).toHaveBeenCalled();
      expect(document.querySelector("[data-design-token-picker]")?.getAttribute("aria-label")).toContain("Indent");
    } finally {
      portaled.remove();
    }
  });

  it("writes a field's companion declaration with a token chosen for it, and nothing extra elsewhere", () => {
    mount(true);
    {
      const choose = (id: string) => {
        act(() => { api!.openPickerForField(byId(id)); });
        const option = document.querySelector<HTMLElement>('[data-design-token-picker] [data-design-token-option="--bg2"]')!;
        act(() => option.click());
      };
      choose("fill");
      expect(chosen).toHaveBeenLastCalledWith(["background-color"], "--bg2", { "background-image": "none" });
      choose("text");
      expect(chosen).toHaveBeenLastCalledWith(["color"], "--bg2", undefined);
    }
  });

  it("resets a gradient Fill's own declaration and writes a token chosen for it to the colour", () => {
    mount(true);
    act(() => api!.resetField(byId("gradient")));
    expect(reset).toHaveBeenLastCalledWith(["background-image"]);
    act(() => { expect(api!.openPickerForField(byId("gradient"))).toBe(true); });
    const option = document.querySelector<HTMLElement>('[data-design-token-picker] [data-design-token-option="--bg2"]')!;
    act(() => option.click());
    expect(chosen).toHaveBeenLastCalledWith(["background-color"], "--bg2", { "background-image": "none" });
  });

  it("opens no picker, Reset or field shortcut while a state is held, and closes an open picker", () => {
    mount(true);
    act(() => { api!.openPickerForField(byId("radius").parentElement!); });
    expect(document.querySelector("[data-design-token-picker]")).not.toBeNull();
    mount(true, true);
    expect(document.querySelector("[data-design-token-picker]")).toBeNull();
    reset.mockClear();
    chosen.mockClear();
    act(() => { expect(api!.openPickerForField(byId("fill"))).toBe(false); });
    act(() => api!.resetField(byId("gradient")));
    const prevent = vi.fn();
    act(() => api!.fieldShortcut({ key: "ArrowDown", altKey: true, metaKey: false, ctrlKey: false, target: byId("radius"),
      preventDefault: prevent, stopPropagation: () => {} }));
    expect(document.querySelector("[data-design-token-picker]")).toBeNull();
    expect(reset).not.toHaveBeenCalled();
    expect(prevent).not.toHaveBeenCalled();
  });

  it("shows one field message under a field, announced politely, without focus, gone on the next input or after its time", () => {
    mount(true);
    // Nothing at rest but the panel's one empty live region.
    expect(document.querySelector("[data-design-field-message]")).toBeNull();
    const status = document.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent).toBe("");
    byId("plain").focus();
    act(() => api!.showFieldMessage(byId("radius").parentElement!, "Width cannot be negative. Kept 330.", "error"));
    const message = document.querySelector("[data-design-field-message]");
    expect(message?.textContent).toBe("Width cannot be negative. Kept 330.");
    expect(message?.getAttribute("data-design-field-message")).toBe("error");
    expect(status?.textContent).toBe("Width cannot be negative. Kept 330.");
    expect(document.activeElement).toBe(byId("plain"));
    // A second message replaces the first: one surface.
    act(() => api!.showFieldMessage(byId("radius").parentElement!, "Use CSS for mixed units.", "error"));
    expect(document.querySelectorAll("[data-design-field-message]")).toHaveLength(1);
    act(() => { byId("plain").dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); });
    expect(document.querySelector("[data-design-field-message]")).toBeNull();
    act(() => api!.showFieldMessage(byId("radius").parentElement!, "2 layers moved. 1 has no number to move.", "info"));
    act(() => { vi.advanceTimersByTime(2_900); });
    expect(document.querySelector("[data-design-field-message]")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(document.querySelector("[data-design-field-message]")).toBeNull();
    expect(status?.textContent).toBe("");
  });

  it("opens no keyboard card once focus has left the panel during the delay", () => {
    mount(true);
    act(() => { tab(); byId("radius").focus(); });
    act(() => { tab(); byId("outside").focus(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(document.querySelector("[data-design-style-card]")).toBeNull();
  });

  it("opens no keyboard card for a control that no longer has focus", () => {
    mount(true);
    act(() => { tab(); byId("radius").focus(); });
    act(() => { tab(); byId("plain").focus(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(document.querySelector("[data-design-style-card]")).toBeNull();
    // Still opens for the control that keeps focus.
    act(() => { tab(); byId("radius").focus(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(document.querySelector("[data-design-style-card]")).not.toBeNull();
  });
});

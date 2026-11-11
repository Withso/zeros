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
const origins = designFieldOrigins([], { label: () => null, utilitySources: new Set() }, null);

let root: Root | null = null;
let host: HTMLDivElement;
let api: DesignFieldOverlaysApi | null = null;

function ApiProbe() {
  api = useDesignFieldOverlays();
  return null;
}

function mount(active: boolean) {
  const rootRef = createRef<HTMLElement>();
  const panel = (children: ReactNode) =>
    createElement(TooltipProvider, {
      delayDuration: 100,
      children: createElement(DesignTokenCatalogContext.Provider, { value: catalog },
        createElement("aside", { ref: rootRef },
          createElement(DesignFieldOverlays, {
            rootRef, active, ownerKey: "selection", origins,
            onChooseToken: chosen, onReset: () => {},
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

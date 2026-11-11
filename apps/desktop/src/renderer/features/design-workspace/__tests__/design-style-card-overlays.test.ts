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
// jsdom has no PointerEvent; the panel reads only its type and target.
if (typeof PointerEvent === "undefined") vi.stubGlobal("PointerEvent", class extends MouseEvent {});

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

const editInCss = vi.fn();
const askAgent = vi.fn();
const fieldKeys = vi.fn();
const fieldPresses = vi.fn();
// A computed Width and a forced Radius, as the origin model reports them.
const lockedOrigins: typeof origins = {
  ...origins,
  lock: (property) =>
    property === "width"
      ? { kind: "computed", nodeId: "box", layer: "Box", text: "calc(100% - 48px)", why: "Uses calc()." }
      : property === "border-radius"
        ? { kind: "forced", nodeId: "box", layer: "Box", text: "4px", why: "Forced by .legacy-card", rule: ".legacy-card" }
        : null,
};

function mount(active: boolean, readOnly = false, fieldOrigins = origins) {
  const rootRef = createRef<HTMLElement>();
  const panel = (children: ReactNode) =>
    createElement(TooltipProvider, {
      delayDuration: 100,
      children: createElement(DesignTokenCatalogContext.Provider, { value: catalog },
        createElement("aside", { ref: rootRef },
          createElement(DesignFieldOverlays, {
            rootRef, active, readOnly, ownerKey: "selection", origins: fieldOrigins,
            onChooseToken: chosen, onReset: reset, onEditInCss: editInCss, onAskAgent: askAgent,
            children,
          }))),
    });
  const children = [
    createElement(ApiProbe, { key: "api" }),
    createElement("div", { key: "radius", "data-design-style-property": "border-radius", "data-design-field-label": "Radius" },
      createElement("button", { type: "button", id: "radius" }, "Radius")),
    createElement("button", { key: "plain", type: "button", id: "plain" }, "Plain"),
    createElement("div", { key: "width", id: "width", "data-design-style-property": "width", "data-design-field-label": "W",
      "data-design-origin": "computed" },
      createElement("button", { type: "button", id: "width-scrub", onPointerDown: fieldPresses }, "W"),
      createElement("input", { id: "width-input", readOnly: true, defaultValue: "calc(100% - 48px)", onKeyDown: (event: { key: string }) => fieldKeys(event.key) })),
    createElement("div", { key: "corner", id: "corner", "data-design-style-property": "border-radius", "data-design-field-label": "Corner radius",
      "data-design-origin": "forced" },
      createElement("input", { id: "corner-input", readOnly: true, defaultValue: "4" })),
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

  it("keeps edits out of a computed field and opens its card at once on a press or Enter", () => {
    mount(true, false, lockedOrigins);
    const card = () => document.querySelector("[data-design-style-card]");
    const press = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    act(() => { byId("width-scrub").dispatchEvent(press); });
    // No hover delay, and no scrub.
    expect(card()?.textContent).toContain("Uses calc().");
    expect(fieldPresses).not.toHaveBeenCalled();
    expect(press.defaultPrevented).toBe(true);
    act(() => { (document.querySelector('[data-design-card-action="css"]') as HTMLElement).click(); });
    expect(editInCss).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();
    const key = (init: KeyboardEventInit, target = byId("width-input")) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      act(() => { target.dispatchEvent(event); });
      return event.defaultPrevented;
    };
    fieldKeys.mockClear();
    for (const typed of ["5", "ArrowUp", "ArrowDown", "Backspace", "Delete"]) expect(key({ key: typed }), typed).toBe(true);
    expect(key({ key: "Backspace", altKey: true })).toBe(true);
    expect(fieldKeys).not.toHaveBeenCalled();
    // Moving on, the caret and command shortcuts pass.
    for (const passing of [{ key: "Tab" }, { key: "ArrowLeft" }, { key: "c", metaKey: true }, { key: "z", ctrlKey: true }]) expect(key(passing)).toBe(false);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    act(() => { byId("width-input").dispatchEvent(paste); });
    expect(paste.defaultPrevented).toBe(true);
    expect(card()).toBeNull();
    expect(key({ key: "Enter" })).toBe(true);
    expect(card()?.textContent).toContain("Uses calc().");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); byId("width-input").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })); });
    expect(card()).toBeNull();
    expect(key({ key: " " })).toBe(true);
    expect(card()).not.toBeNull();
  });

  it("keeps a card open while its field's own text scrolls, and closes it when the panel scrolls", () => {
    mount(true, false, lockedOrigins);
    const card = () => document.querySelector("[data-design-style-card]");
    const enter = () => act(() => { byId("width-input").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })); });
    enter();
    expect(card()).not.toBeNull();
    // A long value (calc(100% - 48px)) scrolls inside its input as the caret
    // moves; that event arrives a frame later, after the card has opened.
    act(() => { byId("width-input").dispatchEvent(new Event("scroll")); });
    expect(card()).not.toBeNull();
    // Another field's text scrolling moves nothing either.
    act(() => { byId("corner-input").dispatchEvent(new Event("scroll")); });
    expect(card()).not.toBeNull();
    // The panel scrolling moves the field from under the card.
    act(() => { (byId("width").closest("aside") as HTMLElement).dispatchEvent(new Event("scroll")); });
    expect(card()).toBeNull();
  });

  it("offers the agent for a forced field, for its properties", () => {
    mount(true, false, lockedOrigins);
    act(() => { byId("corner-input").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true })); });
    expect(document.querySelector("[data-design-style-card]")?.textContent).toContain("Forced by .legacy-card");
    act(() => { (document.querySelector('[data-design-card-action="agent"]') as HTMLElement).click(); });
    expect(askAgent).toHaveBeenCalledWith(["border-radius"]);
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

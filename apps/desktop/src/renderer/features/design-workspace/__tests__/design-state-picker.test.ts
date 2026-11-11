// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "../../../shared/ui/primitives";
import {
  DesignLayerStateMenu,
  designHeldStateNote,
  useDesignHeldReadOnly,
} from "../design-state-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
// jsdom has no PointerEvent; Radix reads only its button, type and modifiers.
if (typeof PointerEvent === "undefined") {
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "mouse";
    }
  });
}

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.querySelectorAll("[data-design-popover]").forEach((node) => node.remove());
});

const render = (element: ReturnType<typeof createElement>) =>
  act(() => {
    root ??= createRoot(host);
    root.render(createElement(TooltipProvider, { children: element }));
  });

describe("the held state note", () => {
  it("says what the state changes, and when it changes nothing here", () => {
    expect(designHeldStateNote("hover", 1)).toEqual({ lead: "Hover", rest: " changes 1 property. The rest matches Default." });
    expect(designHeldStateNote("focus-visible", 3)).toEqual({ lead: "Focus visible", rest: " changes 3 properties. The rest matches Default." });
    expect(designHeldStateNote("disabled", 0)).toEqual({ lead: "Disabled", rest: " changes nothing here." });
  });
});

describe("the State menu", () => {
  const menu = (active: boolean, held: "hover" | null = null) =>
    createElement(DesignLayerStateMenu, { states: ["hover", "disabled"], held, active, onPick: () => {} });

  it("is named Layer state, reads the held state, and offers no tooltip", () => {
    render(menu(true, "hover"));
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Layer state"]')!;
    expect(button.textContent).toBe("Hover");
    expect(button.hasAttribute("title")).toBe(false);
    render(menu(true));
    expect(button.textContent).toBe("Default");
  });

  it("closes when the surface stops being shown", () => {
    render(menu(true));
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Layer state"]')!;
    act(() => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    });
    expect(document.querySelector("[data-design-state-menu]")).not.toBeNull();
    render(menu(false));
    expect(document.querySelector("[data-design-state-menu]")).toBeNull();
    // Shown again, it stays closed until asked.
    render(menu(true));
    expect(document.querySelector("[data-design-state-menu]")).toBeNull();
  });
});

describe("the read-only rule while a state is held", () => {
  const seen = vi.fn();
  function Panel({ held }: { held: boolean }) {
    const ref = useRef<HTMLElement | null>(null);
    useDesignHeldReadOnly(ref, held);
    return createElement("aside", { ref },
      createElement("div", { "data-radix-scroll-area-viewport": "" },
        createElement("div", { "data-design-state-control": "" },
          createElement("button", { id: "back", type: "button", onClick: () => seen("back") }, "Back to Default")),
        createElement("div", { "data-design-style-property": "border-radius" },
          createElement("input", { id: "radius", defaultValue: "6", onKeyDown: (event: { key: string }) => seen(`key:${event.key}`) }),
          createElement("button", { id: "detach", type: "button", onClick: () => seen("detach") }, "Detach"))));
  }

  const fire = (target: Element, event: Event) => {
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  const key = (target: Element, init: KeyboardEventInit) =>
    fire(target, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

  it("drops presses, typing and field shortcuts in the panel and its popovers, and lets the way out through", () => {
    render(createElement(Panel, { held: true }));
    const popover = document.createElement("div");
    popover.setAttribute("data-design-popover", "");
    const indent = document.createElement("input");
    popover.append(indent);
    document.body.append(popover);
    const radius = document.getElementById("radius")!;
    const detach = document.getElementById("detach")!;
    seen.mockClear();
    act(() => detach.click());
    expect(seen).not.toHaveBeenCalledWith("detach");
    expect(fire(detach, new PointerEvent("pointerdown", { bubbles: true, cancelable: true }))).toBe(true);
    expect(key(radius, { key: "5" })).toBe(true);
    expect(key(radius, { key: "ArrowUp" })).toBe(true);
    expect(key(radius, { key: "ArrowDown", altKey: true })).toBe(true);
    expect(key(radius, { key: "Backspace", altKey: true })).toBe(true);
    expect(fire(radius, new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: "5" }))).toBe(true);
    expect(key(indent, { key: "ArrowDown", altKey: true })).toBe(true);
    expect(fire(indent, new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: "5" }))).toBe(true);
    expect(seen).not.toHaveBeenCalledWith("key:5");
    // Tab, Escape, the caret, undo and redo pass; so does the way back.
    for (const init of [{ key: "Tab" }, { key: "Escape" }, { key: "ArrowLeft" }, { key: "z", metaKey: true }, { key: "z", ctrlKey: true, shiftKey: true }]) {
      expect(key(radius, init), init.key).toBe(false);
    }
    expect(seen).toHaveBeenCalledWith("key:Tab");
    act(() => document.getElementById("back")!.click());
    expect(seen).toHaveBeenCalledWith("back");
    popover.remove();
  });

  it("drops the keys and clipboard edits that change a field's draft, and lets command shortcuts through", () => {
    render(createElement(Panel, { held: true }));
    const radius = document.getElementById("radius")!;
    for (const init of [
      { key: "ArrowUp", metaKey: true },
      { key: "ArrowDown", ctrlKey: true },
      { key: "ArrowUp", shiftKey: true },
      { key: "ArrowDown", metaKey: true, shiftKey: true },
    ]) expect(key(radius, init), JSON.stringify(init)).toBe(true);
    // Cut and paste are events of their own after their shortcut's keydown.
    expect(fire(radius, new Event("cut", { bubbles: true, cancelable: true }))).toBe(true);
    expect(fire(radius, new Event("paste", { bubbles: true, cancelable: true }))).toBe(true);
    for (const init of [{ key: "c", metaKey: true }, { key: "a", metaKey: true }, { key: "x", metaKey: true }, { key: "v", ctrlKey: true }, { key: "y", ctrlKey: true }])
      expect(key(radius, init), init.key).toBe(false);
    expect(fire(radius, new Event("copy", { bubbles: true, cancelable: true }))).toBe(false);
  });

  it("drops presses in popovers the panel opened, not in one opened elsewhere", () => {
    render(createElement(Panel, { held: true }));
    const popover = (id: string, trigger: HTMLElement | null) => {
      const element = document.createElement("div");
      element.id = id;
      element.setAttribute("data-design-popover", "");
      element.append(document.createElement("button"));
      document.body.append(element);
      trigger?.setAttribute("aria-controls", id);
      return element.firstElementChild!;
    };
    // Opened from the panel: its trigger is inside it.
    const inside = document.createElement("button");
    document.querySelector('[data-design-style-property="border-radius"]')!.append(inside);
    const owned = popover("radix-:r1:", inside);
    // The theme editor's colour picker, opened from the canvas chrome.
    const chrome = document.createElement("button");
    document.body.append(chrome);
    const elsewhere = popover("radix-:r2:", chrome);
    // A popover with no trigger, like the panel's token picker, is the panel's.
    const anchored = popover("radix-:r3:", null);
    const press = (target: Element) => fire(target, new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(press(owned)).toBe(true);
    expect(press(anchored)).toBe(true);
    expect(press(elsewhere)).toBe(false);
    expect(key(elsewhere, { key: "5" })).toBe(false);
    for (const node of [owned, elsewhere, anchored]) node.parentElement!.remove();
    chrome.remove();
  });

  it("listens to nothing when no state is held", () => {
    render(createElement(Panel, { held: false }));
    const radius = document.getElementById("radius")!;
    seen.mockClear();
    expect(key(radius, { key: "5" })).toBe(false);
    expect(seen).toHaveBeenCalledWith("key:5");
    act(() => document.getElementById("detach")!.click());
    expect(seen).toHaveBeenCalledWith("detach");
  });
});

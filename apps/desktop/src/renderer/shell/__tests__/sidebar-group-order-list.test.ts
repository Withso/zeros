// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../../shared/ui/primitives/dropdown-menu";
import { SidebarGroupOrderList, type SidebarGroupOrderItem } from "../sidebar-group-order-list";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  for (const name of ["setPointerCapture", "releasePointerCapture"] as const) {
    Element.prototype[name] ??= () => {};
  }
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => {};
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const ITEMS: SidebarGroupOrderItem[] = [
  { key: "needs-you", label: "Needs you", count: 1 },
  { key: "working", label: "Working", count: 2 },
  { key: "idle", label: "Idle", count: 3 },
  { key: "archived", label: "Archived", pinned: true },
];

function render(onReorder = vi.fn(), onToggleHidden = vi.fn()) {
  act(() => root.render(createElement(
    DropdownMenu,
    { open: true },
    createElement(DropdownMenuTrigger, null, "View"),
    createElement(DropdownMenuContent, null,
      createElement(SidebarGroupOrderList, { items: ITEMS, hidden: [], onReorder, onToggleHidden })),
  )));
  return { onReorder, onToggleHidden };
}

const row = (key: string) => document.querySelector<HTMLElement>(`[data-sidebar-group-order="${key}"]`)!;
const fire = (target: Element, type: string, init: MouseEventInit = {}) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })); });
const alt = (target: HTMLElement, key: string) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true })); });

describe("the Group menu's group order list", () => {
  // The grip stopped pointerdown, so the menu item treated the grip's
  // pointerup as a keyboard-free click and toggled the group's eye, and the
  // browser's own click toggled it again.
  it("never hides or shows a group from its drag grip", () => {
    const { onToggleHidden } = render();
    const grip = row("working").querySelector("[data-sidebar-group-grip]")!;
    fire(grip, "pointerdown");
    fire(grip, "pointerup");
    fire(grip, "click");
    expect(onToggleHidden).not.toHaveBeenCalled();
    fire(row("working"), "click");
    expect(onToggleHidden).toHaveBeenCalledTimes(1);
    expect(onToggleHidden).toHaveBeenCalledWith("working", true);
  });

  // Archived always paints after the live groups, so it can be hidden but
  // not moved, and nothing moves below it.
  it("pins Archived last: no grip, no keyboard move, nothing moves past it", () => {
    const { onReorder } = render();
    expect(row("archived").querySelector("[data-sidebar-group-grip]")).toBeNull();
    alt(row("archived"), "ArrowUp");
    expect(onReorder).not.toHaveBeenCalled();
    alt(row("idle"), "ArrowDown");
    expect(onReorder).not.toHaveBeenCalled();
    alt(row("idle"), "ArrowUp");
    expect(onReorder).toHaveBeenLastCalledWith(["needs-you", "idle", "working", "archived"]);
  });
});

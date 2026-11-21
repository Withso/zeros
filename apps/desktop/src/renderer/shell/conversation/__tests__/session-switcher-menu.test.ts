// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../../../shared/ui/primitives/dropdown-menu";
import { buildSessionTree } from "../../../state/session-tree";
import type { ChatThread } from "../../../state/store";
import { ParentMenu } from "../session-switcher";

const chat = (id: string, extra: Partial<ChatThread> = {}): ChatThread => ({
  id, title: id, folder: "/repo", createdAt: 1, ...extra,
} as ChatThread);

vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function press(target: Element) {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
}

describe("parent session menu", () => {
  it("expands a parent from its arrow without selecting it", () => {
    const tree = buildSessionTree([chat("root"), chat("kid", { parentChatId: "root", rootChatId: "root", createdAt: 2 })], "/repo");
    const onSelect = vi.fn();
    const node = document.body.appendChild(document.createElement("div"));
    root = createRoot(node);
    act(() => root!.render(createElement(DropdownMenu, { open: true },
      createElement(DropdownMenuTrigger, null, "open"),
      createElement(DropdownMenuContent, null,
        createElement(ParentMenu, { tree, folder: "/repo", activeId: "kid", onSelect })))));
    const arrow = document.querySelector('[data-session-row="root"] [role="button"]');
    expect(arrow).not.toBeNull();
    act(() => press(arrow!));
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('[data-session-row="kid"]')).not.toBeNull();
  });
});

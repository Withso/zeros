// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../../../shared/ui/primitives/dropdown-menu";
import { buildSessionTree } from "../../../state/session-tree";
import type { ChatThread } from "../../../state/store";
import { editChat } from "../../../state/cloud-chat-edits";
import { ParentMenu, RenameRow, workspaceBadgeLabel } from "../session-switcher";

vi.mock("../../../state/cloud-chat-edits", () => ({ editChat: vi.fn() }));
import type { Workspace } from "../../../platform/git";

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

describe("workspace badge label", () => {
  const annex = { id: "ws_annex", path: "/ws/w-2-2", branch: "zeros/w-2-2", title: "Orchard Annex", parentWorkspaceId: "ws_parent" } as Workspace;
  it("names an archived child workspace by its title", () => {
    expect(workspaceBadgeLabel("/ws/w-2-2", [], [annex])).toBe("Orchard Annex");
    expect(workspaceBadgeLabel("/ws/w-2-2", [annex], [])).toBe("Orchard Annex");
    expect(workspaceBadgeLabel("/ws/gone", [], [annex])).toBe("gone");
  });
});

describe("rename row", () => {
  function mount(title: string) {
    const node = document.body.appendChild(document.createElement("div"));
    root = createRoot(node);
    act(() => root!.render(createElement(DropdownMenu, { open: true },
      createElement(DropdownMenuTrigger, null, "open"),
      createElement(DropdownMenuContent, null, createElement(RenameRow, { chat: chat("c1", { title }) })))));
    return document.querySelector<HTMLInputElement>("[data-session-rename]")!;
  }
  function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  const key = (input: HTMLInputElement, k: string) =>
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  const blur = (input: HTMLInputElement) => act(() => { input.focus(); input.blur(); });

  it("saves a trimmed name once on Enter", () => {
    vi.mocked(editChat).mockClear();
    const input = mount("Old");
    act(() => input.focus());
    type(input, "  New name ");
    key(input, "Enter");
    expect(editChat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(editChat).mock.calls[0]?.[2]).toEqual({ title: "New name" });
  });

  it("Escape discards the draft", () => {
    vi.mocked(editChat).mockClear();
    const input = mount("Old");
    type(input, "Discard me");
    key(input, "Escape");
    blur(input);
    expect(editChat).not.toHaveBeenCalled();
  });

  it("saves the draft when the menu closes without a blur", () => {
    vi.mocked(editChat).mockClear();
    const input = mount("Old");
    type(input, "Outside click");
    act(() => root!.unmount());
    root = undefined;
    expect(vi.mocked(editChat).mock.calls[0]?.[2]).toEqual({ title: "Outside click" });
  });

  it("Escape then close saves nothing", () => {
    vi.mocked(editChat).mockClear();
    const input = mount("Old");
    type(input, "Discard me");
    key(input, "Escape");
    act(() => root!.unmount());
    root = undefined;
    expect(editChat).not.toHaveBeenCalled();
  });

  it("Escape cancels even when the menu closes before the field sees the key", () => {
    vi.mocked(editChat).mockClear();
    const input = mount("Old");
    type(input, "Discard me");
    const closeFirst = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      act(() => root!.unmount());
      root = undefined;
    };
    document.addEventListener("keydown", closeFirst, true);
    try {
      key(input, "Escape");
    } finally {
      document.removeEventListener("keydown", closeFirst, true);
    }
    expect(editChat).not.toHaveBeenCalled();
  });

  it("ignores an empty name", () => {
    vi.mocked(editChat).mockClear();
    const input = mount("Old");
    type(input, "   ");
    blur(input);
    expect(editChat).not.toHaveBeenCalled();
    expect(input.value).toBe("Old");
  });
});

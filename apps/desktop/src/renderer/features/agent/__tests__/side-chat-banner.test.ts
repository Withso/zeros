// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ chats: [] as Array<{ id: string; title: string }> }));
vi.mock("../../../state/store", () => ({
  useWorkspaceStore: (select: (state: { chats: typeof store.chats }) => unknown) => select({ chats: store.chats }),
}));

import { SideChatBranchBanner, firstLineEnd } from "../side-chat-banner";
import type { SideChatSeed } from "../side-chat-seeds";

const seed = (over: Partial<SideChatSeed> = {}): SideChatSeed => ({
  sourceChatId: "source", sourceTitle: "Fix login redirect", messageId: "m2", promptId: "m1",
  role: "agent", quote: "Login now returns people to the page they started from.", pending: true,
  createdAt: 1, sourceUpdatedAt: 1, ...over,
});

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  store.chats = [];
});

function render(value: SideChatSeed, active = true) {
  const node = document.body.appendChild(document.createElement("div"));
  root = createRoot(node);
  act(() => root!.render(createElement(SideChatBranchBanner, { seed: value, active })));
  return node;
}

describe("SideChatBranchBanner", () => {
  it("names only the chat it branched from, whatever it branched from", () => {
    for (const role of ["agent", "user"] as const) {
      const node = render(seed({ role }));
      const from = node.querySelector("[data-side-chat-source]")!;
      expect(from.textContent).toBe("Branched from Fix login redirect");
      expect(node.textContent).not.toMatch(/message/);
      act(() => root?.unmount());
      root = undefined;
    }
  });

  it("follows a renamed source chat", () => {
    store.chats = [{ id: "source", title: "Return to the right page" }];
    expect(render(seed()).querySelector("[data-side-chat-source]")!.textContent).toBe("Branched from Return to the right page");
  });

  it("measures the quote only while its chat is on screen", () => {
    const createRange = vi.spyOn(document, "createRange");
    render(seed(), false);
    expect(createRange).not.toHaveBeenCalled();
    act(() => root!.render(createElement(SideChatBranchBanner, { seed: seed(), active: true })));
    expect(createRange).toHaveBeenCalled();
    createRange.mockRestore();
  });

  it("shows the fork mark and the quote", () => {
    const node = render(seed());
    expect(node.querySelector("[data-side-chat-fork]")).not.toBeNull();
    expect(node.querySelector("blockquote")!.textContent).toContain("Login now returns people");
  });
});

describe("firstLineEnd", () => {
  it("finds where the first line wraps", () => {
    const tops = [0, 0, 0, 0, 18, 18, 18, 36];
    expect(firstLineEnd(tops.length, (i) => tops[i]!)).toBe(4);
  });

  it("returns null when the text fits on one line", () => {
    expect(firstLineEnd(5, () => 0)).toBeNull();
    expect(firstLineEnd(0, () => 0)).toBeNull();
  });
});

// SuggestionStore — load-state threading + async-landing refresh (setData).
//
// Guards the picker UX fix: the popup renders while a trigger is OPEN (even
// with zero items) and reads `status` to show Loading / Couldn't load / empty,
// and an async load landing re-pushes items via setData without a keystroke.

import { describe, expect, it, vi } from "vitest";

import {
  SuggestionStore,
  type SuggestionItem,
} from "../composer-editor/suggestion";
import { buildPathMentions, deriveWorkspaceEntries } from "../mentions";

const item = (n: number): SuggestionItem => ({ number: n, title: `PR ${n}` });
const noop = () => {};

describe("SuggestionStore", () => {
  it("preserves a file mention by path after inserting an earlier-ranked file", () => {
    const s = new SuggestionStore();
    const command = vi.fn();
    const items = buildPathMentions(
      deriveWorkspaceEntries(["a.ts", "b.ts"]),
      "",
    );
    s.open("@", { query: "", items, status: "ready", command });
    s.move(1);
    s.setData({
      items: buildPathMentions(
        deriveWorkspaceEntries(["0.ts", "a.ts", "b.ts"]),
        "",
      ),
      status: "ready",
    });
    s.choose();
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ query: "b.ts" }),
    );
  });
  it("starts closed and ready", () => {
    const s = new SuggestionStore();
    expect(s.getSnapshot()).toMatchObject({ open: false, status: "ready" });
  });

  it("open carries the data-source status (e.g. loading)", () => {
    const s = new SuggestionStore();
    s.open("#", { query: "", items: [], status: "loading", command: noop });
    expect(s.getSnapshot()).toMatchObject({
      open: true,
      trigger: "#",
      status: "loading",
      items: [],
    });
  });

  it("update refreshes items + status and resets the highlight", () => {
    const s = new SuggestionStore();
    s.open("@", {
      query: "f",
      items: [item(1), item(2)],
      status: "ready",
      command: noop,
    });
    s.move(1);
    expect(s.getSnapshot().selectedIndex).toBe(1);
    s.update({ query: "fo", items: [item(3)], status: "ready", command: noop });
    expect(s.getSnapshot()).toMatchObject({
      status: "ready",
      selectedIndex: 0,
    });
    expect(s.getSnapshot().items).toHaveLength(1);
  });

  it("setData flips a loading menu to its results without a keystroke", () => {
    const s = new SuggestionStore();
    s.open("#", { query: "", items: [], status: "loading", command: noop });
    s.setData({ items: [item(7)], status: "ready" });
    const snap = s.getSnapshot();
    expect(snap.status).toBe("ready");
    expect(snap.items).toHaveLength(1);
    expect(snap.selectedIndex).toBe(0);
  });

  it("keeps the highlighted mention through unchanged background refreshes", () => {
    const s = new SuggestionStore();
    const command = vi.fn();
    s.open("#", {
      query: "",
      items: [item(1), item(2)],
      status: "ready",
      command,
    });
    s.move(1);
    s.setData({ items: [item(1), item(2)], status: "ready" });
    s.choose();
    expect(command).toHaveBeenCalledWith(item(2));
  });

  it("does not notify or replace rows when revalidation confirms the same items", () => {
    const s = new SuggestionStore();
    s.open("#", {
      query: "",
      items: [item(1), item(2)],
      status: "ready",
      command: noop,
    });
    const snapshot = s.getSnapshot();
    const notify = vi.fn();
    s.subscribe(notify);
    s.setData({ items: [item(1), item(2)], status: "ready" });
    expect(s.getSnapshot()).toBe(snapshot);
    expect(notify).not.toHaveBeenCalled();
    s.setData({
      items: [item(1), { number: 2, title: "Updated title" }],
      status: "ready",
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("follows the selected mention identity when refreshed rows reorder", () => {
    const s = new SuggestionStore();
    const command = vi.fn();
    s.open("#", {
      query: "",
      items: [item(1), item(2)],
      status: "ready",
      command,
    });
    s.move(1);
    s.setData({ items: [item(3), item(1), item(2)], status: "ready" });
    expect(s.getSnapshot().selectedIndex).toBe(2);
    s.choose();
    expect(command).toHaveBeenCalledWith(item(2));
  });

  it("bounds the highlight when the selected result disappears", () => {
    const s = new SuggestionStore();
    s.open("#", {
      query: "",
      items: [item(1), item(2), item(3)],
      status: "ready",
      command: noop,
    });
    s.move(2);
    s.setData({ items: [item(1), item(2)], status: "ready" });
    expect(s.getSnapshot().selectedIndex).toBe(1);
    s.setData({ items: [], status: "ready" });
    expect(s.getSnapshot().selectedIndex).toBe(0);
  });

  it("setData surfaces an error state (empty + error) on a failed fetch", () => {
    const s = new SuggestionStore();
    s.open("#", { query: "", items: [], status: "loading", command: noop });
    s.setData({ items: [], status: "error" });
    expect(s.getSnapshot()).toMatchObject({
      open: true,
      items: [],
      status: "error",
    });
  });

  it("setData is a no-op once the menu is closed (stale landing is dropped)", () => {
    const s = new SuggestionStore();
    s.open("@", { query: "", items: [], status: "loading", command: noop });
    s.close();
    s.setData({ items: [item(1)], status: "ready" });
    expect(s.getSnapshot()).toMatchObject({ open: false, items: [] });
  });

  it("close clears items (so a reopened menu can't flash the prior list)", () => {
    const s = new SuggestionStore();
    s.open("@", {
      query: "",
      items: [item(1)],
      status: "ready",
      command: noop,
    });
    s.close();
    expect(s.getSnapshot().items).toHaveLength(0);
  });
});

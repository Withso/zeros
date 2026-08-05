// SuggestionStore — load-state threading + async-landing refresh (setData).
//
// Guards the picker UX fix: the popup renders while a trigger is OPEN (even
// with zero items) and reads `status` to show Loading / Couldn't load / empty,
// and an async load landing re-pushes items via setData without a keystroke.

import { describe, expect, it } from "vitest";

import {
  SuggestionStore,
  type SuggestionItem,
} from "../composer-editor/suggestion";

const item = (n: number): SuggestionItem => ({ number: n, title: `PR ${n}` });
const noop = () => {};

describe("SuggestionStore", () => {
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
    s.open("@", { query: "f", items: [item(1), item(2)], status: "ready", command: noop });
    s.move(1);
    expect(s.getSnapshot().selectedIndex).toBe(1);
    s.update({ query: "fo", items: [item(3)], status: "ready", command: noop });
    expect(s.getSnapshot()).toMatchObject({ status: "ready", selectedIndex: 0 });
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

  it("setData surfaces an error state (empty + error) on a failed fetch", () => {
    const s = new SuggestionStore();
    s.open("#", { query: "", items: [], status: "loading", command: noop });
    s.setData({ items: [], status: "error" });
    expect(s.getSnapshot()).toMatchObject({ open: true, items: [], status: "error" });
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
    s.open("@", { query: "", items: [item(1)], status: "ready", command: noop });
    s.close();
    expect(s.getSnapshot().items).toHaveLength(0);
  });
});

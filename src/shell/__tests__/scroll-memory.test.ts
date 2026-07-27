// scroll-memory — the non-React surface: keyed offset map + reattach registry.
// The hook itself needs a real DOM/renderer; these tests pin the registry
// contract that ChatPane (pane-host reparent) and Column3 (collapse→expand)
// depend on: registration marks elements discoverable, restoreScrollWithin
// walks root + descendants, and stale cleanups can't tear down a newer
// registration for the same element.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SCROLL_INTRINSIC_SIZE_ATTR,
  SCROLL_RESTORE_ATTR,
  MAX_SCROLL_MEMORY_ENTRIES,
  captureScrollWithin,
  clearScrollOffsets,
  materializeScrollGeometryWithin,
  preserveScrollGeometryWithin,
  registerScrollRestore,
  restoreScrollWithin,
  saveScrollOffset,
  savedScrollOffset,
} from "../scroll-memory";

/** Minimal Element stand-in — vitest runs node-env, so the registry must
 *  only rely on this structural surface. */
function fakeElement(descendants: FakeEl[] = [], height = 100): FakeEl {
  const attrs = new Set<string>();
  const result = {
    attrs,
    dataset: {} as Record<string, string>,
    style: {
      containIntrinsicBlockSize: "",
      contentVisibility: "",
      removeProperty: (name: string) => {
        if (name === "content-visibility") {
          result.style.contentVisibility = "";
        }
      },
    },
    getBoundingClientRect: () => ({ height, width: 500 }),
    setAttribute: (name: string) => void attrs.add(name),
    removeAttribute: (name: string) => void attrs.delete(name),
    hasAttribute: (name: string) => attrs.has(name),
    querySelectorAll: (selector: string) => {
      const attrName = selector.replace(/^\[|\]$/g, "");
      return descendants.filter((el) => el.attrs.has(attrName));
    },
  } as FakeEl;
  return result;
}

interface FakeEl {
  attrs: Set<string>;
  dataset: Record<string, string>;
  style: {
    containIntrinsicBlockSize: string;
    contentVisibility: string;
    removeProperty: (name: string) => void;
  };
  getBoundingClientRect: () => { height: number; width: number };
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  hasAttribute: (name: string) => boolean;
  querySelectorAll: (selector: string) => FakeEl[];
}

const asElement = (el: FakeEl) => el as unknown as Element;

describe("scroll offsets map", () => {
  beforeEach(() => clearScrollOffsets());

  it("stores and returns offsets per key", () => {
    saveScrollOffset("settings:general", 420);
    saveScrollOffset("settings:providers", 8);
    expect(savedScrollOffset("settings:general")).toBe(420);
    expect(savedScrollOffset("settings:providers")).toBe(8);
  });

  it("isolates same-path tabs and same-workspace filter destinations", () => {
    const fileTabA = JSON.stringify(["file", "/repo", "tab-a", "src/a.ts"]);
    const fileTabB = JSON.stringify(["file", "/repo", "tab-b", "src/a.ts"]);
    const changesAll = JSON.stringify([
      "changes-list",
      "workspace-1",
      "flat",
      "all",
    ]);
    const changesStaged = JSON.stringify([
      "changes-list",
      "workspace-1",
      "flat",
      "staged",
    ]);
    saveScrollOffset(fileTabA, 120);
    saveScrollOffset(fileTabB, 640);
    saveScrollOffset(changesAll, 80);
    saveScrollOffset(changesStaged, 360);

    expect(savedScrollOffset(fileTabA)).toBe(120);
    expect(savedScrollOffset(fileTabB)).toBe(640);
    expect(savedScrollOffset(changesAll)).toBe(80);
    expect(savedScrollOffset(changesStaged)).toBe(360);
  });

  it("returns undefined for unvisited keys", () => {
    expect(savedScrollOffset("repo:nope:workspaces")).toBeUndefined();
  });

  it("overwrites on re-save (last position wins)", () => {
    saveScrollOffset("k", 100);
    saveScrollOffset("k", 250);
    expect(savedScrollOffset("k")).toBe(250);
  });

  it("bounds inactive destinations and evicts the oldest write", () => {
    for (let i = 0; i <= MAX_SCROLL_MEMORY_ENTRIES; i += 1) {
      saveScrollOffset(`view:${i}`, i);
    }
    expect(savedScrollOffset("view:0")).toBeUndefined();
    expect(savedScrollOffset(`view:${MAX_SCROLL_MEMORY_ENTRIES}`)).toBe(
      MAX_SCROLL_MEMORY_ENTRIES,
    );
  });
});

describe("reattach registry", () => {
  it("marks registered elements and restores through the walk", () => {
    const child = fakeElement();
    const root = fakeElement([child]);
    const restoreRoot = vi.fn();
    const restoreChild = vi.fn();
    registerScrollRestore(asElement(root), restoreRoot);
    registerScrollRestore(asElement(child), restoreChild);

    expect(root.attrs.has(SCROLL_RESTORE_ATTR)).toBe(true);
    restoreScrollWithin(asElement(root));
    // Root itself AND registered descendants both restore.
    expect(restoreRoot).toHaveBeenCalledTimes(1);
    expect(restoreChild).toHaveBeenCalledTimes(1);
  });

  it("captures root and descendants before a host move", () => {
    const child = fakeElement();
    const root = fakeElement([child]);
    const captureRoot = vi.fn();
    const captureChild = vi.fn();
    registerScrollRestore(asElement(root), vi.fn(), captureRoot);
    registerScrollRestore(asElement(child), vi.fn(), captureChild);

    captureScrollWithin(asElement(root));
    expect(captureRoot).toHaveBeenCalledTimes(1);
    expect(captureChild).toHaveBeenCalledTimes(1);
  });

  it("skips unregistered descendants and tolerates a null root", () => {
    const registered = fakeElement();
    const unregistered = fakeElement();
    const root = fakeElement([registered, unregistered]);
    const restore = vi.fn();
    registerScrollRestore(asElement(registered), restore);

    restoreScrollWithin(null);
    restoreScrollWithin(asElement(root));
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("unregister removes the marker and the callback", () => {
    const child = fakeElement();
    const root = fakeElement([child]);
    const restore = vi.fn();
    const unregister = registerScrollRestore(asElement(child), restore);

    unregister();
    expect(child.attrs.has(SCROLL_RESTORE_ATTR)).toBe(false);
    restoreScrollWithin(asElement(root));
    expect(restore).not.toHaveBeenCalled();
  });

  it("a stale cleanup cannot tear down a newer registration", () => {
    const child = fakeElement();
    const root = fakeElement([child]);
    const oldRestore = vi.fn();
    const newRestore = vi.fn();
    const unregisterOld = registerScrollRestore(asElement(child), oldRestore);
    // Key change re-registers in the same commit; the old effect's cleanup
    // then runs. It must leave the new registration intact.
    registerScrollRestore(asElement(child), newRestore);
    unregisterOld();

    expect(child.attrs.has(SCROLL_RESTORE_ATTR)).toBe(true);
    restoreScrollWithin(asElement(root));
    expect(newRestore).toHaveBeenCalledTimes(1);
    expect(oldRestore).not.toHaveBeenCalled();
  });

  it("unregister is idempotent", () => {
    const el = fakeElement();
    const unregister = registerScrollRestore(asElement(el), vi.fn());
    unregister();
    expect(() => unregister()).not.toThrow();
  });
});

describe("content-visibility geometry", () => {
  it("freezes exact positive block sizes on marked boundaries", () => {
    const first = fakeElement([], 712.5);
    const second = fakeElement([], 188);
    const invalid = fakeElement([], 0);
    first.attrs.add(SCROLL_INTRINSIC_SIZE_ATTR);
    second.attrs.add(SCROLL_INTRINSIC_SIZE_ATTR);
    invalid.attrs.add(SCROLL_INTRINSIC_SIZE_ATTR);
    const root = fakeElement([first, second, invalid]);

    expect(preserveScrollGeometryWithin(asElement(root))).toBe(2);
    expect(first.style.containIntrinsicBlockSize).toBe("auto 712.5px");
    expect(second.style.containIntrinsicBlockSize).toBe("auto 188px");
    expect(invalid.style.containIntrinsicBlockSize).toBe("");
  });

  it("reads every size before writing any intrinsic style", () => {
    const order: string[] = [];
    const makeTracked = (id: string, height: number): FakeEl => {
      const el = fakeElement([], height);
      el.attrs.add(SCROLL_INTRINSIC_SIZE_ATTR);
      el.getBoundingClientRect = () => {
        order.push(`read:${id}`);
        return { height, width: 500 };
      };
      let value = "";
      el.style = {
        get containIntrinsicBlockSize() {
          return value;
        },
        set containIntrinsicBlockSize(next: string) {
          order.push(`write:${id}`);
          value = next;
        },
        contentVisibility: "",
        removeProperty: () => {},
      };
      return el;
    };
    const first = makeTracked("first", 400);
    const second = makeTracked("second", 800);
    const root = fakeElement([first, second]);

    preserveScrollGeometryWithin(asElement(root));
    expect(order).toEqual([
      "read:first",
      "read:second",
      "write:first",
      "write:second",
    ]);
  });

  it("materializes only missing boundaries through the saved anchor", () => {
    const first = fakeElement([], 400);
    const anchor = fakeElement([], 900);
    const after = fakeElement([], 700);
    for (const element of [first, anchor, after]) {
      element.attrs.add(SCROLL_INTRINSIC_SIZE_ATTR);
    }
    first.style.containIntrinsicBlockSize = "auto 400px";
    first.dataset.scrollIntrinsicInlineSize = "500";
    const root = fakeElement([first, anchor, after]);

    expect(
      materializeScrollGeometryWithin(asElement(root), asElement(anchor)),
    ).toBe(1);
    expect(first.style.containIntrinsicBlockSize).toBe("auto 400px");
    expect(anchor.style.containIntrinsicBlockSize).toBe("auto 900px");
    expect(anchor.style.contentVisibility).toBe("");
    expect(after.style.containIntrinsicBlockSize).toBe("");
  });

  it("re-materializes a warm boundary after its wrapping width changes", () => {
    const anchor = fakeElement([], 1_100);
    anchor.attrs.add(SCROLL_INTRINSIC_SIZE_ATTR);
    anchor.style.containIntrinsicBlockSize = "auto 700px";
    anchor.dataset.scrollIntrinsicInlineSize = "320";
    const root = fakeElement([anchor]);

    expect(
      materializeScrollGeometryWithin(asElement(root), asElement(anchor)),
    ).toBe(1);
    expect(anchor.style.containIntrinsicBlockSize).toBe("auto 1100px");
    expect(anchor.dataset.scrollIntrinsicInlineSize).toBe("500");
  });
});

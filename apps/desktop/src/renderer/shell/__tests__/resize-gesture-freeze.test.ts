// Gesture-time freeze — hidden retained layers and iframes are pinned at
// their pre-gesture size while a seam drag runs, and restored exactly on
// release. See apps/desktop/src/renderer/shell/resize-gesture-freeze.ts for the why. Node-env
// fakes (repo convention, no jsdom) mirror resize-layout-lock's old tests.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RESIZE_FREEZE_SELECTOR,
  freezeResizeFreezeTargets,
  installResizeGestureFreeze,
} from "../resize-gesture-freeze";
import {
  beginContinuousLayoutResize,
  resetContinuousLayoutResizeForTests,
} from "../terminal/continuous-layout-resize";

interface FakeStyle {
  values: Map<string, { value: string; priority: string }>;
  getPropertyValue(name: string): string;
  getPropertyPriority(name: string): string;
  setProperty(name: string, value: string, priority?: string): void;
  removeProperty(name: string): string;
}

function fakeStyle(): FakeStyle {
  const values = new Map<string, { value: string; priority: string }>();
  return {
    values,
    getPropertyValue(name) {
      return values.get(name)?.value ?? "";
    },
    getPropertyPriority(name) {
      return values.get(name)?.priority ?? "";
    },
    setProperty(name, value, priority = "") {
      values.set(name, { value, priority });
    },
    removeProperty(name) {
      const previous = values.get(name)?.value ?? "";
      values.delete(name);
      return previous;
    },
  };
}

function fakeElement(width: number, height: number, events?: string[]) {
  const style = fakeStyle();
  return {
    style,
    getBoundingClientRect() {
      events?.push(`read:${width}x${height}`);
      return { width, height };
    },
  };
}

type FakeEl = ReturnType<typeof fakeElement>;

interface FakeAncestor {
  parentElement: FakeAncestor | null;
  transform?: string;
  scale?: string;
}

/** Element under transformed ancestors — getBoundingClientRect() returns the
 * VISUAL (post-transform) box, exactly like the real DOM, while the ancestor
 * chain carries the computed transform/scale the freeze must normalize by.
 * `ancestors` is listed outermost-first. */
function fakeScaledElement(
  visualWidth: number,
  visualHeight: number,
  ancestors: Array<{ transform?: string; scale?: string }>,
) {
  let parent: FakeAncestor | null = null;
  for (const entry of ancestors) {
    parent = { parentElement: parent, ...entry };
  }
  return {
    style: fakeStyle(),
    parentElement: parent,
    ownerDocument: {
      defaultView: {
        getComputedStyle(node: { transform?: string; scale?: string }) {
          return {
            transform: node.transform ?? "none",
            scale: node.scale ?? "none",
          };
        },
      },
    },
    getBoundingClientRect() {
      return { width: visualWidth, height: visualHeight };
    },
  };
}

function fakeRoot(elements: FakeEl[]): ParentNode {
  return {
    querySelectorAll(selector: string) {
      expect(selector).toBe(RESIZE_FREEZE_SELECTOR);
      return elements;
    },
  } as unknown as ParentNode;
}

let dispose: (() => void) | null = null;

beforeEach(() => {
  resetContinuousLayoutResizeForTests();
});

afterEach(() => {
  dispose?.();
  dispose = null;
  resetContinuousLayoutResizeForTests();
});

describe("freezeResizeFreezeTargets", () => {
  it("pins marked elements at their measured size, reads before writes, and restores on release", () => {
    const events: string[] = [];
    const first = fakeElement(640.25, 480, events);
    const second = fakeElement(511, 320.5, events);
    for (const element of [first, second]) {
      const originalSet = element.style.setProperty.bind(element.style);
      element.style.setProperty = (name, value, priority) => {
        events.push(`write:${name}:${value}`);
        originalSet(name, value, priority);
      };
    }

    const release = freezeResizeFreezeTargets(fakeRoot([first, second]));

    // Batched: every rect read lands before the first style write, so the
    // gesture start costs one layout flush, not one per surface.
    expect(events).toEqual([
      "read:640.25x480",
      "read:511x320.5",
      "write:width:640.25px",
      "write:height:480px",
      "write:width:511px",
      "write:height:320.5px",
    ]);

    release();
    expect(first.style.values.has("width")).toBe(false);
    expect(first.style.values.has("height")).toBe(false);
    expect(second.style.values.has("width")).toBe(false);
    expect(second.style.values.has("height")).toBe(false);
  });

  it("restores pre-existing inline sizes, including their priority", () => {
    const el = fakeElement(300, 200);
    el.style.setProperty("width", "50%", "important");
    el.style.setProperty("height", "10rem");

    const release = freezeResizeFreezeTargets(fakeRoot([el]));
    expect(el.style.values.get("width")).toEqual({
      value: "300px",
      priority: "",
    });
    expect(el.style.values.get("height")).toEqual({
      value: "200px",
      priority: "",
    });

    release();
    expect(el.style.values.get("width")).toEqual({
      value: "50%",
      priority: "important",
    });
    expect(el.style.values.get("height")).toEqual({
      value: "10rem",
      priority: "",
    });
  });

  it("skips zero-size and unmeasurable elements so a collapsed surface revealed mid-gesture is not pinned invisible", () => {
    // A collapsed terminal panel's body region measures 0-height — pinning
    // height:0 would keep the terminal invisible if the drag expands the
    // panel before release.
    const zeroHeight = fakeElement(640, 0);
    const zeroWidth = fakeElement(0, 480);
    const invalid = fakeElement(Number.NaN, Number.NaN);

    const release = freezeResizeFreezeTargets(
      fakeRoot([zeroHeight, zeroWidth, invalid]),
    );
    expect(zeroHeight.style.values.size).toBe(0);
    expect(zeroWidth.style.values.size).toBe(0);
    expect(invalid.style.values.size).toBe(0);
    release();
  });

  it("pins the untransformed layout size under a scaled ancestor (zoomed browser canvas)", () => {
    // Canvas mode wraps the browser iframe in `transform: scale(zoom)`
    // (browser-tab.tsx) with zoom routinely < 1. The rect is the visual box
    // — zoom × layout — but the pin is written as inline LAYOUT px, so it
    // must be normalized back or the iframe really resizes for the drag.
    const el = fakeScaledElement(320.5, 240, [
      { transform: "matrix(0.5, 0, 0, 0.5, 120, 40)" },
    ]);
    const release = freezeResizeFreezeTargets(fakeRoot([el]));
    expect(el.style.values.get("width")?.value).toBe("641px");
    expect(el.style.values.get("height")?.value).toBe("480px");

    release();
    expect(el.style.values.has("width")).toBe(false);
    expect(el.style.values.has("height")).toBe(false);
  });

  it("compounds nested scales across matrix3d and the individual `scale` property", () => {
    const el = fakeScaledElement(150, 60, [
      { scale: "0.5 0.25" },
      {
        transform:
          "matrix3d(0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1)",
      },
    ]);
    const release = freezeResizeFreezeTargets(fakeRoot([el]));
    expect(el.style.values.get("width")?.value).toBe("600px");
    expect(el.style.values.get("height")?.value).toBe("480px");
    release();
  });

  it("keeps the rect's sub-pixel size under translate-only transforms", () => {
    // Translation moves the box without scaling it — the rect width/height
    // ARE the layout size and must pass through untouched.
    const el = fakeScaledElement(640.25, 480, [
      { transform: "matrix(1, 0, 0, 1, 100, 50)" },
    ]);
    const release = freezeResizeFreezeTargets(fakeRoot([el]));
    expect(el.style.values.get("width")?.value).toBe("640.25px");
    expect(el.style.values.get("height")?.value).toBe("480px");
    release();
  });

  it("skips elements collapsed by a zero ancestor scale instead of pinning a non-finite size", () => {
    const el = fakeScaledElement(0, 0, [
      { transform: "matrix(0, 0, 0, 0, 0, 0)" },
    ]);
    const release = freezeResizeFreezeTargets(fakeRoot([el]));
    expect(el.style.values.size).toBe(0);
    release();
  });

  it("release is idempotent (pointerup and lostpointercapture can race)", () => {
    const el = fakeElement(640, 480);
    const release = freezeResizeFreezeTargets(fakeRoot([el]));
    release();
    el.style.setProperty("width", "123px");
    release();
    expect(el.style.values.get("width")?.value).toBe("123px");
  });
});

describe("installResizeGestureFreeze", () => {
  it("freezes on the outermost gesture start and thaws only when the last gesture ends", () => {
    const el = fakeElement(800, 600);
    dispose = installResizeGestureFreeze(fakeRoot([el]));

    const finishFirst = beginContinuousLayoutResize();
    expect(el.style.values.get("width")?.value).toBe("800px");
    expect(el.style.values.get("height")?.value).toBe("600px");

    // A second overlapping gesture must not re-snapshot or thaw early.
    const finishSecond = beginContinuousLayoutResize();
    expect(el.style.values.get("width")?.value).toBe("800px");

    finishFirst();
    expect(el.style.values.get("width")?.value).toBe("800px");

    finishSecond();
    expect(el.style.values.has("width")).toBe(false);
    expect(el.style.values.has("height")).toBe(false);
  });

  it("is idempotent — a second install returns the live installation", () => {
    dispose = installResizeGestureFreeze(fakeRoot([]));
    const again = installResizeGestureFreeze(fakeRoot([]));
    expect(again).toBe(dispose);
  });

  it("returns a no-op without a root (non-DOM runtime)", () => {
    const noop = installResizeGestureFreeze(null);
    noop();
    const finish = beginContinuousLayoutResize();
    finish();
  });

  it("dispose unsubscribes and thaws an in-flight freeze", () => {
    const el = fakeElement(800, 600);
    dispose = installResizeGestureFreeze(fakeRoot([el]));

    const finish = beginContinuousLayoutResize();
    expect(el.style.values.get("width")?.value).toBe("800px");

    dispose();
    dispose = null;
    expect(el.style.values.has("width")).toBe(false);

    // Fresh gestures after dispose no longer freeze anything.
    finish();
    const finishNext = beginContinuousLayoutResize();
    expect(el.style.values.has("width")).toBe(false);
    finishNext();
  });
});

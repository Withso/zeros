import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserFloatEntries,
  browserFloatKey,
  closeBrowserFloat,
  dockBrowserTab,
  floatBrowserTab,
  isBrowserTabFloating,
  MAX_BROWSER_FLOATS_PER_SCOPE,
  moveNodePreservingState,
  normalizeBrowserFloatViewport,
  onBrowserFloatSlotRemoved,
  registerBrowserFloatSlot,
  resetBrowserFloatsForTesting,
  resizeBrowserFloat,
} from "../browser-float-store";
import {
  browserFloatMaxSize,
  browserFloatResize,
  browserFloatSize,
  browserFloatStackBottom,
  browserFloatTitle,
  type BrowserFloatResizeHandle,
} from "../browser-float-stack";

const localScope = "/Users/me/app";
const cloudScope =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

afterEach(() => resetBrowserFloatsForTesting());

describe("float registry", () => {
  it("keys floats by exact scope and tab so equal tab ids never collide", () => {
    floatBrowserTab({ scope: localScope, tabId: "browser-1" });
    expect(isBrowserTabFloating(browserFloatKey(localScope, "browser-1"))).toBe(true);
    expect(isBrowserTabFloating(browserFloatKey(cloudScope, "browser-1"))).toBe(false);
  });

  it("re-floating a tab updates its viewport without adding a second entry", () => {
    floatBrowserTab({ scope: localScope, tabId: "a", viewport: { width: 800, height: 600 } });
    floatBrowserTab({ scope: localScope, tabId: "a", viewport: { width: 393, height: 852 } });
    expect(browserFloatEntries()).toEqual([
      {
        key: browserFloatKey(localScope, "a"),
        scope: localScope,
        tabId: "a",
        viewport: { width: 393, height: 852 },
      },
    ]);
  });

  it("docks the oldest float of the same scope only when the scope is full", () => {
    floatBrowserTab({ scope: cloudScope, tabId: "cloud" });
    for (let index = 0; index <= MAX_BROWSER_FLOATS_PER_SCOPE; index += 1) {
      floatBrowserTab({ scope: localScope, tabId: `local-${index}` });
    }
    const keys = browserFloatEntries().map((entry) => entry.key);
    expect(keys).toContain(browserFloatKey(cloudScope, "cloud"));
    expect(keys).not.toContain(browserFloatKey(localScope, "local-0"));
    expect(
      browserFloatEntries().filter((entry) => entry.scope === localScope),
    ).toHaveLength(MAX_BROWSER_FLOATS_PER_SCOPE);

    dockBrowserTab(browserFloatKey(localScope, "local-1"));
    expect(isBrowserTabFloating(browserFloatKey(localScope, "local-1"))).toBe(false);
  });

  it("closing a float reports when its scope has no float left", () => {
    floatBrowserTab({ scope: localScope, tabId: "a" });
    floatBrowserTab({ scope: localScope, tabId: "b" });
    floatBrowserTab({ scope: cloudScope, tabId: "a" });
    expect(closeBrowserFloat(browserFloatKey(localScope, "a"))).toBe(false);
    expect(closeBrowserFloat(browserFloatKey(localScope, "b"))).toBe(true);
    expect(isBrowserTabFloating(browserFloatKey(localScope, "b"))).toBe(false);
    expect(isBrowserTabFloating(browserFloatKey(cloudScope, "a"))).toBe(true);
    // A float that already docked closes nothing.
    expect(closeBrowserFloat(browserFloatKey(localScope, "b"))).toBe(false);
  });

  it("falls back to a desktop viewport for unmeasured or invalid sizes", () => {
    expect(normalizeBrowserFloatViewport(null)).toEqual({ width: 1280, height: 800 });
    expect(normalizeBrowserFloatViewport({ width: 0, height: Number.NaN })).toEqual({
      width: 1280,
      height: 800,
    });
    expect(normalizeBrowserFloatViewport({ width: 99_999, height: 667.6 })).toEqual({
      width: 7680,
      height: 668,
    });
  });
});

describe("float resize", () => {
  const key = browserFloatKey(localScope, "a");
  const float = () => {
    floatBrowserTab({ scope: localScope, tabId: "a", viewport: { width: 1280, height: 800 } });
  };

  it("stores the resized layout and scale, and drops the scale to restore the automatic fit", () => {
    float();
    resizeBrowserFloat(key, { viewport: { width: 1500.4, height: 800 }, scale: 0.4 });
    expect(browserFloatEntries()).toStrictEqual([
      {
        key,
        scope: localScope,
        tabId: "a",
        viewport: { width: 1500, height: 800 },
        scale: 0.4,
      },
    ]);
    resizeBrowserFloat(key, { viewport: { width: 1280, height: 800 } });
    expect(browserFloatEntries()).toStrictEqual([
      { key, scope: localScope, tabId: "a", viewport: { width: 1280, height: 800 } },
    ]);
  });

  it("clamps a resized layout instead of resetting it and ignores invalid scales", () => {
    float();
    for (const scale of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      resizeBrowserFloat(key, { viewport: { width: 50, height: 99_999 }, scale });
      expect(browserFloatEntries()).toStrictEqual([
        { key, scope: localScope, tabId: "a", viewport: { width: 120, height: 7680 } },
      ]);
    }
  });

  it("keeps the same entries for an unchanged or unknown resize", () => {
    float();
    resizeBrowserFloat(key, { viewport: { width: 1280, height: 800 }, scale: 0.3 });
    const before = browserFloatEntries();
    resizeBrowserFloat(key, { viewport: { width: 1280, height: 800 }, scale: 0.3 });
    resizeBrowserFloat(browserFloatKey(cloudScope, "a"), {
      viewport: { width: 900, height: 600 },
      scale: 0.5,
    });
    expect(browserFloatEntries()).toBe(before);
  });
});

describe("float slots", () => {
  it("hands the removed slot to its rescue before the slot leaves the DOM", () => {
    const key = browserFloatKey(localScope, "a");
    const slot = {} as HTMLElement;
    const rescue = vi.fn();
    const stop = onBrowserFloatSlotRemoved(key, rescue);
    registerBrowserFloatSlot(key, slot);
    registerBrowserFloatSlot(key, null);
    expect(rescue).toHaveBeenCalledWith(slot);

    stop();
    registerBrowserFloatSlot(key, slot);
    registerBrowserFloatSlot(key, null);
    expect(rescue).toHaveBeenCalledTimes(1);
  });
});

describe("moveNodePreservingState", () => {
  const document = {};

  it("moves atomically when both nodes are connected in one document", () => {
    const moveBefore = vi.fn();
    const appendChild = vi.fn();
    const parent = { isConnected: true, ownerDocument: document, moveBefore, appendChild };
    const node = { isConnected: true, ownerDocument: document };
    expect(
      moveNodePreservingState(parent as unknown as Element, node as unknown as Element),
    ).toBe(true);
    expect(moveBefore).toHaveBeenCalledWith(node, null);
    expect(appendChild).not.toHaveBeenCalled();
  });

  it("inserts normally on first attach or when atomic moves are unsupported", () => {
    const appendChild = vi.fn();
    const detached = { isConnected: false, ownerDocument: document };
    const parent = {
      isConnected: true,
      ownerDocument: document,
      moveBefore: vi.fn(),
      appendChild,
    };
    expect(
      moveNodePreservingState(parent as unknown as Element, detached as unknown as Element),
    ).toBe(false);
    const legacy = { isConnected: true, ownerDocument: document, appendChild };
    expect(
      moveNodePreservingState(
        legacy as unknown as Element,
        { isConnected: true, ownerDocument: document } as unknown as Element,
      ),
    ).toBe(false);
    expect(appendChild).toHaveBeenCalledTimes(2);
  });
});

describe("float stack geometry", () => {
  it("keeps the page's aspect ratio inside the picture in picture budget", () => {
    const phone = browserFloatSize({
      availableWidth: 900,
      availableHeight: 700,
      viewport: { width: 375, height: 667 },
    });
    expect(phone.width / phone.height).toBeCloseTo(375 / 667, 2);
    expect(phone.width).toBeLessThanOrEqual(900);
    expect(phone.height).toBeLessThanOrEqual(700);
    expect(phone.scale).toBeCloseTo(phone.width / 375, 2);
  });

  it("stacks above the agent picture in picture only while it is shown", () => {
    expect(browserFloatStackBottom(0)).toBe(16);
    expect(browserFloatStackBottom(200)).toBe(16 + 200 + 8);
  });

  it("names the float by its site, keeping the port of a local dev server", () => {
    expect(browserFloatTitle("Dashboard", "http://localhost:5173/app")).toBe("localhost:5173");
    expect(browserFloatTitle("Example", "https://www.example.com/docs")).toBe("example.com");
    expect(browserFloatTitle(" Notes ", "about:blank")).toBe("Notes");
    expect(browserFloatTitle(undefined, "not a url")).toBe("Browser");
  });

  it("floats a tall page at least as wide as the smallest resize while the height allows", () => {
    const phone = { width: 393, height: 852 };
    expect(
      browserFloatSize({ availableWidth: 900, availableHeight: 800, viewport: phone }),
    ).toMatchObject({ width: 160, height: 347 });
    // A share too short for that width keeps the ratio at the share's height.
    expect(
      browserFloatSize({ availableWidth: 900, availableHeight: 266, viewport: phone }),
    ).toMatchObject({ width: 108, height: 234 });
  });

  it("draws a resized float at its scale and shrinks it to fit the available area", () => {
    const desktop = { width: 1280, height: 800 };
    expect(browserFloatMaxSize({ availableWidth: 900, availableHeight: 700 })).toEqual({
      width: 868,
      height: 668,
    });
    expect(
      browserFloatSize({ availableWidth: 900, availableHeight: 700, viewport: desktop, scale: 0.4 }),
    ).toEqual({ width: 512, height: 320, scale: 0.4 });
    const fitted = browserFloatSize({
      availableWidth: 900,
      availableHeight: 700,
      viewport: desktop,
      scale: 0.8,
    });
    expect(fitted).toEqual({ width: 868, height: 543, scale: 868 / 1280 });
  });

  it("keeps the automatic size when a resize first records its scale", () => {
    for (const viewport of [
      { width: 393, height: 852 },
      { width: 1280, height: 800 },
      { width: 300, height: 200 },
    ]) {
      const automatic = browserFloatSize({ availableWidth: 900, availableHeight: 700, viewport });
      expect(
        browserFloatSize({
          availableWidth: 900,
          availableHeight: 700,
          viewport,
          scale: automatic.scale,
        }),
      ).toEqual(automatic);
    }
  });
});

describe("float resize geometry", () => {
  const desktop = { width: 1280, height: 800 };
  // A 320x200 float anchored at the stack's bottom-right corner.
  const start = (
    handle: BrowserFloatResizeHandle,
    overrides: Partial<Parameters<typeof browserFloatResize>[0]> = {},
  ) => ({ handle, viewport: desktop, scale: 0.25, maxWidth: 600, maxHeight: 500, ...overrides });
  const box = (next: ReturnType<typeof browserFloatResize>) => ({
    width: Math.round(next.viewport.width * next.scale),
    height: Math.round(next.viewport.height * next.scale),
  });
  const handles: BrowserFloatResizeHandle[] = [
    "left",
    "top",
    "top-left",
    "top-right",
    "bottom-left",
  ];

  it("returns the start size for every handle before the pointer moves", () => {
    for (const handle of handles) {
      expect(browserFloatResize(start(handle), 0, 0)).toEqual({ viewport: desktop, scale: 0.25 });
    }
  });

  it("moves the left edge with the pointer and reflows only the page width", () => {
    const wider = browserFloatResize(start("left"), -80, 37);
    expect(wider).toEqual({ viewport: { width: 1600, height: 800 }, scale: 0.25 });
    expect(box(wider)).toEqual({ width: 400, height: 200 });
    expect(browserFloatResize(start("left"), 60, -20)).toEqual({
      viewport: { width: 1040, height: 800 },
      scale: 0.25,
    });
  });

  it("moves the top edge with the pointer and reflows only the page height", () => {
    const taller = browserFloatResize(start("top"), 25, -100);
    expect(taller).toEqual({ viewport: { width: 1280, height: 1200 }, scale: 0.25 });
    expect(box(taller)).toEqual({ width: 320, height: 300 });
  });

  it("keeps an edge within a pixel of the pointer at fractional scales", () => {
    const scale = 0.3127;
    const from = start("left", { scale });
    const startWidth = desktop.width * scale;
    for (let dx = -200; dx <= 150; dx += 7) {
      const next = browserFloatResize(from, dx, 0);
      expect(Math.abs(next.viewport.width * scale - (startWidth - dx))).toBeLessThanOrEqual(1);
    }
  });

  it("stops edges at the available area and at the minimum float size", () => {
    expect(box(browserFloatResize(start("left"), -1000, 0)).width).toBe(600);
    expect(box(browserFloatResize(start("top"), 0, -1000)).height).toBe(500);
    expect(box(browserFloatResize(start("left"), 1000, 0)).width).toBe(160);
    expect(box(browserFloatResize(start("top"), 0, 1000)).height).toBe(100);
  });

  it("never jumps when the start size is outside the limits", () => {
    // The automatic phone float is narrower than the minimum resize width.
    const phone = start("left", { viewport: { width: 393, height: 852 }, scale: 0.352 });
    expect(browserFloatResize(phone, 40, 0).viewport).toEqual(phone.viewport);
    expect(browserFloatResize(phone, -20, 0).viewport.width).toBe(450);
    expect(browserFloatResize({ ...phone, handle: "top-left" }, 30, 30).scale).toBe(0.352);
    // A float the available area no longer holds can shrink but not grow.
    const crowded = start("top-left", { maxWidth: 200, maxHeight: 150 });
    expect(browserFloatResize(crowded, -50, -50).scale).toBe(0.25);
    expect(browserFloatResize(crowded, 32, 0).scale).toBe(0.25);
    expect(browserFloatResize(crowded, 64, 40).scale).toBeCloseTo(0.2);
  });

  it("resizes proportionally from the top-left corner along the dominant axis", () => {
    const wider = browserFloatResize(start("top-left"), -80, -10);
    expect(wider.viewport).toEqual(desktop);
    expect(box(wider)).toEqual({ width: 400, height: 250 });
    const taller = browserFloatResize(start("top-left"), -10, -50);
    expect(box(taller)).toEqual({ width: 400, height: 250 });
    const smaller = browserFloatResize(start("top-left"), 64, 10);
    expect(box(smaller)).toEqual({ width: 304, height: 190 });
  });

  it("resizes proportionally from the anchored corners along their free edge", () => {
    expect(box(browserFloatResize(start("top-right"), 500, -50))).toEqual({
      width: 400,
      height: 250,
    });
    expect(box(browserFloatResize(start("bottom-left"), -80, 500))).toEqual({
      width: 400,
      height: 250,
    });
    expect(browserFloatResize(start("top-right"), -300, 0).scale).toBe(0.25);
    expect(browserFloatResize(start("bottom-left"), 0, -300).scale).toBe(0.25);
  });

  it("stops corners at the available area, actual size and the minimum float size", () => {
    expect(box(browserFloatResize(start("top-left"), -1000, -1000))).toEqual({
      width: 600,
      height: 375,
    });
    expect(
      browserFloatResize(
        start("top-left", {
          viewport: { width: 400, height: 300 },
          scale: 0.5,
          maxWidth: 2000,
          maxHeight: 2000,
        }),
        -1000,
        -1000,
      ).scale,
    ).toBe(1);
    expect(box(browserFloatResize(start("top-left"), 1000, 1000))).toEqual({
      width: 160,
      height: 100,
    });
  });
});

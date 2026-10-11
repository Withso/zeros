import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "../../../shared/ui/primitives";
import {
  BROWSER_DEVICE_MAX_SIZE,
  BROWSER_DEVICE_MIN_HEIGHT,
  BROWSER_DEVICE_MIN_WIDTH,
  BROWSER_DEVICE_PADDING,
  BrowserDeviceToolbar,
  browserDeviceDimensionCommit,
  browserDeviceLayout,
  browserDevicePresetForSize,
  browserDevicePresetLabel,
  browserDeviceResizeSize,
  clampBrowserDeviceSize,
  normalizeBrowserDevicePreset,
  stepBrowserDeviceDimension,
  type BrowserDeviceZoom,
} from "../browser-device-toolbar";

describe("device presets", () => {
  it("treats unknown persisted values as Custom", () => {
    expect(normalizeBrowserDevicePreset("iphone-se")).toBe("iphone-se");
    expect(normalizeBrowserDevicePreset("responsive")).toBe("custom");
    expect(normalizeBrowserDevicePreset(42)).toBe("custom");
    expect(normalizeBrowserDevicePreset(undefined)).toBe("custom");
    expect(browserDevicePresetLabel("custom")).toBe("Custom");
    expect(browserDevicePresetLabel("galaxy-s24-ultra")).toBe(
      "Samsung Galaxy S24 Ultra",
    );
  });

  it("keeps a preset in either orientation and falls back to Custom otherwise", () => {
    expect(browserDevicePresetForSize("iphone-se", 375, 667)).toBe("iphone-se");
    expect(browserDevicePresetForSize("iphone-se", 667, 375)).toBe("iphone-se");
    expect(browserDevicePresetForSize("iphone-se", 376, 667)).toBe("custom");
    expect(browserDevicePresetForSize("custom", 375, 667)).toBe("custom");
  });
});

describe("clampBrowserDeviceSize", () => {
  it("rounds and bounds both edges", () => {
    expect(clampBrowserDeviceSize(393.4, 851.6)).toEqual({
      width: 393,
      height: 852,
    });
    expect(clampBrowserDeviceSize(10, 10)).toEqual({
      width: BROWSER_DEVICE_MIN_WIDTH,
      height: BROWSER_DEVICE_MIN_HEIGHT,
    });
    expect(clampBrowserDeviceSize(99_999, 99_999)).toEqual({
      width: BROWSER_DEVICE_MAX_SIZE,
      height: BROWSER_DEVICE_MAX_SIZE,
    });
    expect(clampBrowserDeviceSize(Number.NaN, Infinity)).toEqual({
      width: BROWSER_DEVICE_MIN_WIDTH,
      height: BROWSER_DEVICE_MIN_HEIGHT,
    });
  });
});

describe("browserDeviceLayout", () => {
  const pad = BROWSER_DEVICE_PADDING;

  it("renders at 100% before a hidden body has been measured", () => {
    const layout = browserDeviceLayout({
      bodyWidth: 0,
      bodyHeight: 0,
      width: 1440,
      height: 900,
      zoom: "fit",
    });
    expect(layout.zoom).toBe(1);
    expect(layout.left).toBe(pad);
    expect(layout.top).toBe(pad);
  });

  it("fits large frames, never enlarges small ones, and centers what fits", () => {
    const large = browserDeviceLayout({
      bodyWidth: 1000,
      bodyHeight: 800,
      width: 3840,
      height: 2160,
      zoom: "fit",
    });
    expect(large.zoom).toBeCloseTo((1000 - 2 * pad) / 3840);
    expect(large.centered).toBe(true);
    expect(large.contentWidth).toBe(1000);

    const phone = browserDeviceLayout({
      bodyWidth: 1000,
      bodyHeight: 1000,
      width: 375,
      height: 667,
      zoom: "fit",
    });
    expect(phone.zoom).toBe(1);
    expect(phone.left).toBe((1000 - 375) / 2);
    expect(phone.centered).toBe(true);
  });

  it("scrolls a fixed zoom that overflows instead of centering it", () => {
    const layout = browserDeviceLayout({
      bodyWidth: 800,
      bodyHeight: 600,
      width: 1440,
      height: 900,
      zoom: 1,
    });
    expect(layout.zoom).toBe(1);
    expect(layout.centered).toBe(false);
    expect(layout.left).toBe(pad);
    expect(layout.contentWidth).toBe(1440 + 2 * pad);
    expect(layout.contentHeight).toBe(900 + 2 * pad);
  });

});

describe("browserDeviceResizeSize", () => {
  const body = { bodyWidth: 1000, bodyHeight: 800 };
  const layoutFor = (
    size: { width: number; height: number },
    zoom: BrowserDeviceZoom,
  ) => browserDeviceLayout({ ...body, ...size, zoom });
  type Scroll = { scrollLeft: number; scrollTop: number };
  /** Drags one knob and returns where the frame edges land on screen,
   * after the body applies the returned scroll. */
  const drag = (
    axis: "left" | "right" | "bottom",
    size: { width: number; height: number },
    zoom: BrowserDeviceZoom,
    dx: number,
    dy = 0,
    scroll: Scroll = { scrollLeft: 0, scrollTop: 0 },
  ) => {
    const before = layoutFor(size, zoom);
    const result = browserDeviceResizeSize(
      { axis, ...size, zoom, ...body, ...scroll },
      dx,
      dy,
    );
    const next = { width: result.width, height: result.height };
    const after = layoutFor(next, zoom);
    const edges = (
      layout: typeof before,
      current: { width: number; height: number },
      offset: Scroll,
    ) => ({
      left: layout.left - offset.scrollLeft,
      right: layout.left + current.width * layout.zoom - offset.scrollLeft,
      bottom: layout.top + current.height * layout.zoom - offset.scrollTop,
    });
    // The scroll the body can actually take for the new content size.
    expect(result.scrollLeft).toBeGreaterThanOrEqual(0);
    expect(result.scrollTop).toBeGreaterThanOrEqual(0);
    expect(result.scrollLeft).toBeLessThanOrEqual(
      after.contentWidth - body.bodyWidth + 1e-9,
    );
    expect(result.scrollTop).toBeLessThanOrEqual(
      after.contentHeight - body.bodyHeight + 1e-9,
    );
    return {
      size: next,
      scroll: { scrollLeft: result.scrollLeft, scrollTop: result.scrollTop },
      before: edges(before, size, scroll),
      after: edges(after, next, result),
      layout: after,
    };
  };
  /** Pointer positions along one drag, for checking it never jumps. */
  const travel = (from: number, to: number) =>
    Array.from({ length: Math.abs(to - from) + 1 }, (_, index) =>
      from + Math.sign(to - from) * index,
    );

  it("keeps a centered side knob under the pointer", () => {
    const right = drag("right", { width: 375, height: 667 }, 1, 50);
    expect(right.size).toEqual({ width: 475, height: 667 });
    expect(right.after.right).toBeCloseTo(right.before.right + 50);

    const left = drag("left", { width: 375, height: 667 }, 1, -50);
    expect(left.size).toEqual({ width: 475, height: 667 });
    expect(left.after.left).toBeCloseTo(left.before.left - 50);
  });

  it("keeps tracking when a fixed-zoom frame starts or stops overflowing", () => {
    // 900 + 2 × 24 fits in 1000; 1026 does not, so the frame flips from
    // centered to left-aligned partway through the drag.
    const grow = drag("right", { width: 900, height: 600 }, 1, 100);
    expect(grow.layout.centered).toBe(false);
    expect(grow.after.right).toBeCloseTo(grow.before.right + 100);

    const shrink = drag("right", { width: 1200, height: 600 }, 1, -400);
    expect(shrink.layout.centered).toBe(true);
    expect(shrink.after.right).toBeCloseTo(shrink.before.right - 400);
  });

  it("grows a centered frame leftwards past the padding without a jump", () => {
    // 800 + 2 × 24 fits in 1000, so the left knob starts 76px inside the
    // padding and the frame overflows partway through the drag.
    const size = { width: 800, height: 600 };
    let previous = size.width;
    for (const dx of travel(0, -200)) {
      const result = drag("left", size, 1, dx);
      expect(Math.abs(result.size.width - previous)).toBeLessThanOrEqual(2);
      expect(Math.abs(result.after.left - (result.before.left + dx))).toBeLessThan(
        0.5,
      );
      previous = result.size.width;
    }
    // Past the padding the body scrolls so the right edge stays at the padding.
    const past = drag("left", size, 1, -100);
    expect(past.layout.centered).toBe(false);
    expect(past.scroll.scrollLeft).toBeGreaterThan(0);
    expect(past.after.right).toBeCloseTo(
      body.bodyWidth - BROWSER_DEVICE_PADDING,
    );
  });

  it("keeps the opposite edge in place while an overflowing frame grows", () => {
    const laptop = { width: 1440, height: 900 };
    const maxScroll = laptop.width + 2 * BROWSER_DEVICE_PADDING - body.bodyWidth;
    const right = drag("right", laptop, 1, 50, 0, {
      scrollLeft: maxScroll,
      scrollTop: 100,
    });
    expect(right.size.width).toBe(1490);
    expect(right.scroll).toEqual({ scrollLeft: maxScroll, scrollTop: 100 });
    expect(right.after.right).toBeCloseTo(right.before.right + 50);

    const left = drag("left", laptop, 1, -50);
    expect(left.size.width).toBe(1490);
    expect(left.after.left).toBeCloseTo(left.before.left - 50);
    expect(left.after.right).toBeCloseTo(left.before.right);
  });

  it("brings an overflowing frame's knob back under the pointer when dragged inward", () => {
    const pad = BROWSER_DEVICE_PADDING;
    const laptop = { width: 1440, height: 900 };
    const tall = { width: 600, height: 1200 };
    const cases = [
      // Scrolled to the end, where the right knob sits at the padding.
      {
        axis: "right",
        size: laptop,
        scroll: {
          scrollLeft: laptop.width + 2 * pad - body.bodyWidth,
          scrollTop: 0,
        },
        sign: -1,
      },
      // Scrolled to the start, where the left knob sits at the padding.
      {
        axis: "left",
        size: laptop,
        scroll: { scrollLeft: 0, scrollTop: 0 },
        sign: 1,
      },
      {
        axis: "bottom",
        size: tall,
        scroll: {
          scrollLeft: 0,
          scrollTop: tall.height + 2 * pad - body.bodyHeight,
        },
        sign: -1,
      },
    ] as const;
    for (const { axis, size, scroll, sign } of cases) {
      const knob = (result: ReturnType<typeof drag>) => ({
        start: result.before[axis],
        now: result.after[axis],
      });
      let previous = axis === "bottom" ? size.height : size.width;
      for (const travelled of travel(0, 300)) {
        const delta = sign * travelled;
        const result =
          axis === "bottom"
            ? drag(axis, size, 1, 0, delta, scroll)
            : drag(axis, size, 1, delta, 0, scroll);
        const current = axis === "bottom" ? result.size.height : result.size.width;
        // No jump: the frame shrinks steadily, a few px per pointer px.
        expect(current).toBeLessThanOrEqual(previous);
        expect(previous - current).toBeLessThan(10);
        previous = current;
        // The knob trails the pointer but never overtakes it, and is back
        // under it after a short catch-up.
        const { start, now } = knob(result);
        const pointer = start + delta;
        expect(sign * (now - start)).toBeGreaterThanOrEqual(-0.5);
        expect(sign * (pointer - now)).toBeGreaterThanOrEqual(-0.5);
        if (travelled >= 120) expect(Math.abs(now - pointer)).toBeLessThan(1);
      }
    }
  });

  it("converts pointer travel through the zoom", () => {
    const half = drag("bottom", { width: 375, height: 667 }, 0.5, 0, 50);
    expect(half.size).toEqual({ width: 375, height: 767 });
    expect(half.after.bottom).toBeCloseTo(half.before.bottom + 50);
  });

  it("tracks the pointer under Fit while the fitted zoom holds", () => {
    // Height-limited: widening does not change the fitted zoom.
    const wide = drag("right", { width: 400, height: 1500 }, "fit", 40);
    expect(wide.layout.zoom).toBeCloseTo(
      (body.bodyHeight - 2 * BROWSER_DEVICE_PADDING) / 1500,
    );
    expect(Math.abs(wide.after.right - (wide.before.right + 40))).toBeLessThan(
      0.5,
    );
  });

  it("keeps a Fit frame inside the panel past its edge, so release cannot snap", () => {
    const tall = drag("bottom", { width: 375, height: 667 }, "fit", 0, 400);
    expect(tall.size.height).toBe(1067);
    expect(tall.layout.zoom).toBeLessThan(1);
    expect(tall.layout.contentWidth).toBe(body.bodyWidth);
    expect(tall.layout.contentHeight).toBe(body.bodyHeight);
    expect(tall.after.bottom).toBeCloseTo(
      body.bodyHeight - BROWSER_DEVICE_PADDING,
    );
  });

  it("brings a panel-filling Fit frame back under the pointer when dragged inward", () => {
    // Height-limited: 986 tall fills the 752px of usable height at ~76%.
    const size = { width: 871, height: 986 };
    const start = drag("bottom", size, "fit", 0, 0);
    expect(start.layout.zoom).toBeLessThan(1);
    // No jump on the first pixel.
    expect(size.height - drag("bottom", size, "fit", 0, -1).size.height).toBeLessThan(5);
    // Mid-recovery the knob is between where it started and the pointer.
    const mid = drag("bottom", size, "fit", 0, -40);
    expect(mid.after.bottom).toBeLessThanOrEqual(mid.before.bottom + 0.5);
    expect(mid.after.bottom).toBeGreaterThanOrEqual(mid.before.bottom - 40 - 0.5);
    // Then it tracks exactly.
    for (const dy of [-150, -250]) {
      const result = drag("bottom", size, "fit", 0, dy);
      expect(Math.abs(result.after.bottom - (result.before.bottom + dy))).toBeLessThan(1);
    }

    // Width-limited Laptop preset, dragged narrower from its right knob.
    const laptop = { width: 1440, height: 900 };
    const narrower = drag("right", laptop, "fit", -80);
    expect(Math.abs(narrower.after.right - (narrower.before.right - 80))).toBeLessThan(1);
    // Making it wider keeps it fitted: the knob stays at the padding.
    const wider = drag("right", laptop, "fit", 80);
    expect(wider.size.width).toBeGreaterThan(laptop.width);
    expect(wider.layout.contentWidth).toBe(body.bodyWidth);
  });

  it("restores the start size at the start pointer and clamps the extremes", () => {
    expect(drag("right", { width: 375, height: 667 }, "fit", 0).size).toEqual({
      width: 375,
      height: 667,
    });
    expect(drag("left", { width: 375, height: 667 }, 1, 5_000).size.width).toBe(
      BROWSER_DEVICE_MIN_WIDTH,
    );
    expect(
      drag("right", { width: 375, height: 667 }, 0.5, 50_000).size.width,
    ).toBe(BROWSER_DEVICE_MAX_SIZE);
    expect(
      drag("bottom", { width: 375, height: 667 }, 1, 0, -5_000).size.height,
    ).toBe(BROWSER_DEVICE_MIN_HEIGHT);
  });
});

describe("dimension fields", () => {
  it("steps from the shown value within the device bounds", () => {
    expect(stepBrowserDeviceDimension("375", 375, 1, BROWSER_DEVICE_MIN_WIDTH)).toBe(376);
    expect(stepBrowserDeviceDimension("", 400, -10, BROWSER_DEVICE_MIN_WIDTH)).toBe(390);
    expect(stepBrowserDeviceDimension("320", 320, -1, BROWSER_DEVICE_MIN_WIDTH)).toBe(
      BROWSER_DEVICE_MIN_WIDTH,
    );
    expect(
      stepBrowserDeviceDimension("7680", 7680, 10, BROWSER_DEVICE_MIN_HEIGHT),
    ).toBe(BROWSER_DEVICE_MAX_SIZE);
  });

  it("commits only an edited, changed number", () => {
    // An untouched field must not write its stale text back over a size that
    // changed while it was focused (for example by a knob drag).
    expect(browserDeviceDimensionCommit(null, 400)).toBeNull();
    expect(browserDeviceDimensionCommit("986", 900)).toBe(986);
    expect(browserDeviceDimensionCommit("900", 900)).toBeNull();
    expect(browserDeviceDimensionCommit("", 900)).toBeNull();
  });
});

describe("BrowserDeviceToolbar", () => {
  it("shows the preset, both dimensions and the effective zoom", () => {
    const render = (presetId: "custom" | "iphone-se", effectiveZoom: number) =>
      renderToStaticMarkup(
        createElement(
          TooltipProvider,
          null,
          createElement(BrowserDeviceToolbar, {
            presetId,
            width: 375,
            height: 667,
            zoom: "fit",
            effectiveZoom,
            onPresetChange: () => {},
            onSizeChange: () => {},
            onRotate: () => {},
            onZoomChange: () => {},
            onClose: () => {},
          }),
        ),
      );
    const custom = render("custom", 0.5);
    expect(custom).toContain("Dimensions:");
    expect(custom).toContain('aria-label="Dimensions: Custom"');
    expect(custom).toContain('aria-label="Viewport width"');
    expect(custom).toContain('value="375"');
    expect(custom).toContain('value="667"');
    expect(custom).toContain('aria-label="Zoom: 50%"');
    expect(custom).toContain('aria-label="Rotate viewport"');
    expect(custom).toContain('aria-label="Close device toolbar"');
    expect(render("iphone-se", 1)).toContain('aria-label="Dimensions: iPhone SE"');
  });
});

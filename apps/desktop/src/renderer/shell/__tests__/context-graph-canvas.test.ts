// Layout/rendering contract for the Context canvas: one deterministic diamond,
// fixed square slots, cursor-anchored zoom, and the lightweight card variants.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ContextGraphCanvas,
  contextGraphCardRenderKey,
  contextGraphImageOrientationTransform,
  contextGraphImageLoadPriority,
  contextGraphItemContentRevision,
  contextGraphShareControlCompensation,
  contextGraphThumbnailFailureIsPermanent,
  contextGraphThumbnailDimension,
  computeContextGraphLayout,
  computeDiamondRowCounts,
  fitContextGraphViewport,
  projectParallaxViewport,
  shouldLoadImageThumbnailsAtScale,
  zoomViewportAtPoint,
} from "../workbench/tabs/context-graph-canvas";
import type { ContextGraphItemWire } from "@/renderer/platform/context-graph";

function item(over: Partial<ContextGraphItemWire>): ContextGraphItemWire {
  return {
    relPath: ".context-graph/local/attachments/att-1/a.png",
    name: "a.png",
    scope: "local",
    category: "attachment",
    kind: "image",
    bytes: 10,
    mtimeMs: 1,
    attachmentId: "att-1",
    ...over,
  };
}

describe("computeContextGraphLayout", () => {
  it("is deterministic for the same input", () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      item({ relPath: `p/${i}`, name: `${i}.png` }),
    );
    const a = computeContextGraphLayout(items);
    const b = computeContextGraphLayout(items);
    expect(a.placed.map((p) => [p.x, p.y])).toEqual(
      b.placed.map((p) => [p.x, p.y]),
    );
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
  });

  it("keeps an attachment in place when sharing changes its path", () => {
    const localItems = Array.from({ length: 10 }, (_, i) =>
      item({
        attachmentId: `att-${i}`,
        relPath: `.context-graph/local/attachments/att-${i}/${i}.png`,
        name: `${i}.png`,
      }),
    );
    const sharedItems = localItems.map((entry, index) =>
      index === 5
        ? {
            ...entry,
            scope: "shared" as const,
            relPath: `.context-graph/shared/attachments/${entry.attachmentId}/${entry.name}`,
          }
        : entry,
    );

    expect(
      computeContextGraphLayout(localItems).placed.map(
        ({ x, y, depthPlane, itemKey }) => [x, y, depthPlane, itemKey],
      ),
    ).toEqual(
      computeContextGraphLayout(sharedItems).placed.map(
        ({ x, y, depthPlane, itemKey }) => [x, y, depthPlane, itemKey],
      ),
    );
  });

  it("keeps a card's React identity when an appended item reflows the diamond", () => {
    const firstFour = Array.from({ length: 4 }, (_, i) =>
      item({
        attachmentId: `att-${i}`,
        relPath: `a/${i}`,
        name: `${i}.png`,
      }),
    );
    const before = computeContextGraphLayout(firstFour).placed.find(
      ({ itemKey }) => itemKey === "att-3/3.png",
    )!;
    const after = computeContextGraphLayout([
      ...firstFour,
      item({ attachmentId: "att-4", relPath: "a/4", name: "4.png" }),
    ]).placed.find(({ itemKey }) => itemKey === "att-3/3.png")!;

    expect([before.row, before.column]).not.toEqual([after.row, after.column]);
    expect(contextGraphCardRenderKey(before)).toBe(
      contextGraphCardRenderKey(after),
    );
  });

  it("invalidates a decoded preview when exact file metadata changes", () => {
    const revision = { mtimeMs: 100, ctimeMs: 200, bytes: 42 };

    expect(contextGraphItemContentRevision(revision)).not.toBe(
      contextGraphItemContentRevision({ ...revision, ctimeMs: 201 }),
    );
    expect(contextGraphItemContentRevision(revision)).not.toBe(
      contextGraphItemContentRevision({ ...revision, bytes: 43 }),
    );
  });

  it("prioritises a newly written image ahead of an older overview backlog", () => {
    const older = contextGraphImageLoadPriority({
      mtimeMs: 100,
      ctimeMs: 100,
    });
    const newlyWritten = contextGraphImageLoadPriority({
      mtimeMs: 200,
      ctimeMs: 210,
    });

    expect(newlyWritten).toBeGreaterThan(older);
  });

  it("gives manually duplicated local/shared attachment ids distinct jitter", () => {
    const duplicate = item({
      attachmentId: "duplicate",
      name: "same.png",
      relPath: ".context-graph/local/attachments/duplicate/same.png",
    });
    const layout = computeContextGraphLayout([
      item({ attachmentId: "first", name: "first.png" }),
      duplicate,
      {
        ...duplicate,
        scope: "shared",
        relPath: ".context-graph/shared/attachments/duplicate/same.png",
      },
    ]);

    expect(layout.placed[1]?.row).toBe(layout.placed[2]?.row);
    expect(layout.placed[1]?.itemKey).not.toBe(layout.placed[2]?.itemKey);
    expect(layout.placed[1]?.y).not.toBe(layout.placed[2]?.y);
  });

  it("merges every graph file into one centered diamond", () => {
    const items = [
      item({ relPath: "a/1", category: "attachment" }),
      item({
        relPath: "d/1",
        category: "doc",
        attachmentId: undefined,
        kind: "markdown",
      }),
      item({ relPath: "a/2", category: "attachment" }),
      item({ relPath: "a/3", category: "attachment" }),
    ];
    const layout = computeContextGraphLayout(items);

    expect(layout.placed.map((placed) => placed.item)).toEqual(items);
    expect(layout.placed.map((placed) => placed.row)).toEqual([0, 1, 1, 2]);
    expect(layout.sections).toEqual([]);
  });

  it("builds tapered rows for small and large graphs", () => {
    expect(computeDiamondRowCounts(0)).toEqual([]);
    expect(computeDiamondRowCounts(1)).toEqual([1]);
    expect(computeDiamondRowCounts(3)).toEqual([1, 2]);
    expect(computeDiamondRowCounts(4)).toEqual([1, 2, 1]);
    expect(computeDiamondRowCounts(10)).toEqual([1, 2, 4, 2, 1]);

    const large = computeDiamondRowCounts(100);
    expect(large.reduce((sum, count) => sum + count, 0)).toBe(100);
    expect(large[0]).toBeLessThan(large[Math.floor(large.length / 2)]!);
    expect(large.at(-1)).toBeLessThan(large[Math.floor(large.length / 2)]!);
  });

  it("gives every card a distinct slot with room for the jitter", () => {
    const items = Array.from({ length: 24 }, (_, i) =>
      item({ relPath: `a/${i}`, name: `${i}.png` }),
    );
    const layout = computeContextGraphLayout(items);
    const seen = new Set<string>();
    for (const p of layout.placed) {
      // Cards are 224px in generously spaced slots with bounded jitter, so
      // every logical slot has room for its card, halo, and share rail.
      const slot = `${p.row}:${p.column}`;
      expect(seen.has(slot)).toBe(false);
      seen.add(slot);
    }
    // Everything stays inside the reported canvas bounds.
    expect(
      Math.max(...layout.placed.map((p) => p.x)) + 224,
    ).toBeLessThanOrEqual(layout.width);
    expect(Math.max(...layout.placed.map((p) => p.y))).toBeLessThan(
      layout.height,
    );
    expect(new Set(layout.placed.map((p) => p.depthPlane)).size).toBe(5);
  });

  it("bounds close-up depth to a slight edge overlap through pan and zoom", () => {
    const items = Array.from({ length: 400 }, (_, i) =>
      item({
        attachmentId: `att-${i}`,
        relPath: `a/${i}`,
        name: `${i}.png`,
      }),
    );
    const layout = computeContextGraphLayout(items);
    const viewportSize = { width: 1_200, height: 800 };
    const canvasSize = { width: layout.width, height: layout.height };
    const depthFactors = [-1, -0.5, 0, 0.5, 1];
    const overview = fitContextGraphViewport(canvasSize, viewportSize);
    const viewports = [
      overview,
      { ...overview, x: overview.x + 640, y: overview.y - 420 },
      zoomViewportAtPoint(overview, 600, 400, -320),
      zoomViewportAtPoint(overview, 180, 120, -640),
      { x: -2_800, y: 1_900, scale: 2 },
    ];

    for (const viewport of viewports) {
      const rects = layout.placed.map((placed) => {
        const projected = projectParallaxViewport(
          viewport,
          viewportSize,
          canvasSize,
          depthFactors[placed.depthPlane]!,
          false,
        );
        return {
          name: placed.item.name,
          card: {
            left: projected.x + placed.x * projected.scale,
            top: projected.y + placed.y * projected.scale,
            right: projected.x + (placed.x + 224) * projected.scale,
            bottom: projected.y + (placed.y + 224) * projected.scale,
          },
          interaction: {
            left: projected.x + (placed.x - 8) * projected.scale,
            top: projected.y + (placed.y - 32) * projected.scale,
            right: projected.x + (placed.x + 232) * projected.scale,
            bottom: projected.y + (placed.y + 232) * projected.scale,
          },
        };
      });
      const penetrations = { card: [] as number[], interaction: [] as number[] };
      for (const footprint of ["card", "interaction"] as const) {
        for (let a = 0; a < rects.length; a += 1) {
          for (let b = a + 1; b < rects.length; b += 1) {
            const first = rects[a]!;
            const second = rects[b]!;
            const firstBounds = first[footprint];
            const secondBounds = second[footprint];
            const overlapX =
              Math.min(firstBounds.right, secondBounds.right) -
              Math.max(firstBounds.left, secondBounds.left);
            const overlapY =
              Math.min(firstBounds.bottom, secondBounds.bottom) -
              Math.max(firstBounds.top, secondBounds.top);
            if (overlapX > 0 && overlapY > 0) {
              // Penetration is the shortest distance needed to separate the
              // rectangles. At full close-up cards may kiss/intrude by only a
              // few canvas pixels; hover rails get the larger visual budget.
              penetrations[footprint].push(Math.min(overlapX, overlapY));
            }
          }
        }
      }
      const maxCardPenetration = Math.max(0, ...penetrations.card);
      const maxInteractionPenetration = Math.max(
        0,
        ...penetrations.interaction,
      );
      expect(maxCardPenetration / viewport.scale).toBeLessThanOrEqual(4.1);
      expect(maxInteractionPenetration / viewport.scale).toBeLessThanOrEqual(
        44.1,
      );
    }
  });

  it("reports a non-degenerate size for an empty graph", () => {
    const layout = computeContextGraphLayout([]);
    expect(layout.placed).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("keeps the same canvas point under the cursor across zoom and clamps extremes", () => {
    const before = { x: -120, y: 40, scale: 0.5 };
    const anchor = { x: 640, y: 360 };
    const canvasPoint = {
      x: (anchor.x - before.x) / before.scale,
      y: (anchor.y - before.y) / before.scale,
    };
    const after = zoomViewportAtPoint(before, anchor.x, anchor.y, -120);

    expect(after.x + canvasPoint.x * after.scale).toBeCloseTo(anchor.x);
    expect(after.y + canvasPoint.y * after.scale).toBeCloseTo(anchor.y);
    expect(zoomViewportAtPoint(before, 0, 0, 1_000_000).scale).toBe(0.08);
    expect(zoomViewportAtPoint(before, 0, 0, -1_000_000).scale).toBe(2);
  });

  it("keeps a tiny preview at fitted overview zoom instead of leaving image cards blank", () => {
    expect(shouldLoadImageThumbnailsAtScale(0.08)).toBe(true);
    expect(contextGraphThumbnailDimension(0.08, 2)).toBe(64);
    expect(contextGraphThumbnailDimension(0.2, 2)).toBe(128);
  });

  it("upgrades thumbnail detail for rendered size and display density", () => {
    expect(contextGraphThumbnailDimension(0.3, 1)).toBe(128);
    expect(contextGraphThumbnailDimension(0.6, 2)).toBe(512);
    expect(contextGraphThumbnailDimension(1.5, 2)).toBe(1024);
    expect(contextGraphThumbnailDimension(2, 2)).toBe(1536);
    expect(contextGraphThumbnailDimension(2, 3)).toBe(1536);
  });

  it("corrects raw EXIF fallback pixels without changing their aspect ratio", () => {
    expect(contextGraphImageOrientationTransform(6)).toBe("rotate(90deg)");
    expect(contextGraphImageOrientationTransform(8)).toBe("rotate(-90deg)");
    expect(contextGraphImageOrientationTransform()).toBeUndefined();
  });

  it("retries thumbnail errors but caches a size-limit rejection", () => {
    expect(
      contextGraphThumbnailFailureIsPermanent({
        kind: "error",
        path: "a.png",
        bytes: 10,
        error: "temporarily missing",
      }),
    ).toBe(false);
    expect(
      contextGraphThumbnailFailureIsPermanent({
        kind: "too-large",
        path: "a.png",
        bytes: 100_000_001,
        error: "too large",
      }),
    ).toBe(true);
    expect(contextGraphThumbnailFailureIsPermanent(null)).toBe(false);
  });

  it("keeps the Shared control usable at overview zoom and lets it grow close-up", () => {
    expect(contextGraphShareControlCompensation(0.5)).toBe(2);
    expect(contextGraphShareControlCompensation(1)).toBe(1);
    expect(contextGraphShareControlCompensation(1.5)).toBe(1);
    expect(contextGraphShareControlCompensation(0.08)).toBe(8);
  });

  it("intensifies bounded depth as the user zooms in and disables it for reduced motion", () => {
    const viewport = { x: -200, y: 80, scale: 0.5 };
    const size = { width: 1_200, height: 800 };
    const canvas = { width: 2_000, height: 1_600 };
    const far = projectParallaxViewport(viewport, size, canvas, -1, false);
    const near = projectParallaxViewport(viewport, size, canvas, 1, false);
    const movedNear = projectParallaxViewport(
      { ...viewport, x: viewport.x + 100 },
      size,
      canvas,
      1,
      false,
    );
    const movedFar = projectParallaxViewport(
      { ...viewport, x: viewport.x + 100 },
      size,
      canvas,
      -1,
      false,
    );

    expect(far.scale).toBe(viewport.scale);
    expect(near.scale).toBe(viewport.scale);
    expect(movedNear.x - near.x).toBeGreaterThan(movedFar.x - far.x);
    expect(movedNear.x - near.x).toBeLessThan(112);
    expect(movedFar.x - far.x).toBeGreaterThan(88);

    const lowZoom = { x: 25, y: 0, scale: 0.5 };
    const highZoom = { x: -1_700, y: -1_200, scale: 2 };
    const lowFar = projectParallaxViewport(lowZoom, size, canvas, -1, false);
    const lowNear = projectParallaxViewport(lowZoom, size, canvas, 1, false);
    const highFar = projectParallaxViewport(highZoom, size, canvas, -1, false);
    const highNear = projectParallaxViewport(highZoom, size, canvas, 1, false);
    const lowCanvasSeparation =
      Math.hypot(lowNear.x - lowFar.x, lowNear.y - lowFar.y) / lowZoom.scale;
    const highCanvasSeparation =
      Math.hypot(highNear.x - highFar.x, highNear.y - highFar.y) /
      highZoom.scale;
    expect(highCanvasSeparation).toBeGreaterThan(lowCanvasSeparation * 1.5);

    const centeredHighZoom = {
      x: size.width / 2 - (canvas.width / 2) * 2,
      y: size.height / 2 - (canvas.height / 2) * 2,
      scale: 2,
    };
    const centeredFar = projectParallaxViewport(
      centeredHighZoom,
      size,
      canvas,
      -1,
      false,
    );
    const centeredNear = projectParallaxViewport(
      centeredHighZoom,
      size,
      canvas,
      1,
      false,
    );
    expect(
      Math.hypot(
        centeredNear.x - centeredFar.x,
        centeredNear.y - centeredFar.y,
      ),
    ).toBeGreaterThan(120);

    const extremeNear = projectParallaxViewport(
      { x: -1_000_000, y: 1_000_000, scale: 2 },
      size,
      canvas,
      1,
      false,
    );
    expect(Math.abs(extremeNear.x + 1_000_000)).toBeLessThanOrEqual(108);
    expect(Math.abs(extremeNear.y - 1_000_000)).toBeLessThanOrEqual(108);
    expect(projectParallaxViewport(viewport, size, canvas, 1, true)).toEqual(
      viewport,
    );
  });

  it("centers every plane exactly at fit-to-view", () => {
    const viewportSize = { width: 1_440, height: 900 };
    const canvasSize = { width: 4_800, height: 3_600 };
    const fit = fitContextGraphViewport(canvasSize, viewportSize);

    for (const depthFactor of [-1, -0.5, 0, 0.5, 1]) {
      expect(
        projectParallaxViewport(
          fit,
          viewportSize,
          canvasSize,
          depthFactor,
          false,
        ),
      ).toEqual(fit);
    }
  });

  it("renders fixed square document cards without the old metadata footer", () => {
    const html = renderToStaticMarkup(
      createElement(ContextGraphCanvas, {
        cwd: "/repo",
        items: [
          item({
            name: "notes.md",
            relPath: "a/notes.md",
            kind: "markdown",
            previewText: "Short note",
          }),
        ],
        active: false,
        onToggleShared: vi.fn(async () => {}),
        pendingToggles: new Set<string>(),
      }),
    );

    expect(html).toContain('data-context-card-kind="document"');
    expect(html).toContain('data-context-card-title=""');
    expect(html).toContain("notes.md");
    expect(html).toContain("size-[224px]");
    expect(html).toContain("data-context-parallax-layer");
    // A permanent transform hint freezes Chromium's initial low-resolution
    // raster and leaves cards blurry after zoom settles. The runtime may add
    // the hint during a gesture, but server/static markup must start crisp.
    expect(html).not.toMatch(
      /origin-top-left\s+will-change-transform(?:\s|")/,
    );
    expect(html).toContain(
      "group-data-[navigating]/context-canvas:will-change-transform",
    );
    expect(html).toContain('data-context-share-control=""');
    expect(html).toContain('data-context-share-checkbox=""');
    expect(html).toContain("--context-share-compensation");
    expect(html).toContain("--context-share-offset");
    expect(html).toContain("scale(var(--context-share-compensation))");
    expect(html).toContain("-left-2");
    expect(html).toContain("bottom:calc(100%+var(--context-share-offset))");
    expect(html).toContain("h-9");
    expect(html).toContain("origin-bottom-left");
    expect(html).toContain("items-start");
    expect(html).toContain("h-7 items-center");
    expect(html).toContain("-inset-2");
    expect(html).not.toContain("-inset-4");
    expect(html).not.toContain("Attachment ·");
    expect(html).not.toContain("border-t");
  });

  it("keeps image cards titleless while preserving an accessible filename", () => {
    const html = renderToStaticMarkup(
      createElement(ContextGraphCanvas, {
        cwd: "/repo",
        items: [item({ name: "portrait.png" })],
        active: false,
        onToggleShared: vi.fn(async () => {}),
        pendingToggles: new Set<string>(),
      }),
    );

    expect(html).toContain('data-context-card-kind="image"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="portrait.png"');
    expect(html).not.toContain('data-context-card-title=""');
  });

  it("removes the pointer affordance while a share toggle is pending", () => {
    const html = renderToStaticMarkup(
      createElement(ContextGraphCanvas, {
        cwd: "/repo",
        items: [item({ name: "pending.png" })],
        active: false,
        onToggleShared: vi.fn(async () => {}),
        pendingToggles: new Set(["att-1"]),
      }),
    );
    const labelClasses = html.match(
      /<label data-context-share-label="" class="([^"]+)"/,
    )?.[1];

    expect(labelClasses).toContain("cursor-default");
    expect(labelClasses).not.toContain("cursor-pointer");
  });
});

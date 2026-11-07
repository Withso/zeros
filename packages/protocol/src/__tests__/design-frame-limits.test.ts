import { describe, expect, it } from "vitest";
import {
  DESIGN_CATALOG_DESCRIPTOR_LIMIT,
  DESIGN_PAGE_SCOPED_MUTATIONS_CAPABILITY,
  designCatalogBatchSchema,
  designCatalogFrameSchema,
  designNavigationReadSchema,
  designPageHashesSchema,
  designPageScopedCatalogSchema,
  designPreparedFrameSchema,
} from "../design-catalog";
import {
  DESIGN_MAX_FRAMES_PER_PAGE,
  DESIGN_MAX_PAGES,
  designPageCatalogSchema,
  designPageDeleteInputSchema,
} from "../design-pages";
import {
  designFramesMoveSchema,
  designMovementGuardSchema,
} from "../design-relocation";

const page = (index: number, frames: number) => ({
  id: `page_${index}`,
  title: `Page ${index}`,
  folder: `page-${index}`,
  frameFiles: Array.from(
    { length: frames },
    (_, frame) => `page-${index}/frame-${frame}.html`,
  ),
  frameIds: Array.from({ length: frames }, (_, frame) => `f_${index}_${frame}`),
});

const descriptor = {
  id: "home",
  pageId: "p",
  source: "home.html",
  title: "Home",
  kind: "html",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  z: 0,
  order: 0,
  preparation: "unprepared",
};

describe("Design frame admission limits", () => {
  it("admits a thousand frames per page and no directory-wide frame cap", () => {
    expect(DESIGN_MAX_FRAMES_PER_PAGE).toBe(1_000);
    expect(DESIGN_MAX_PAGES).toBe(64);
    const pages = Array.from({ length: 26 }, (_, index) =>
      page(index + 1, DESIGN_MAX_FRAMES_PER_PAGE),
    );
    expect(designPageCatalogSchema.safeParse(pages).success).toBe(true);
    expect(
      designPageCatalogSchema.safeParse([
        page(1, DESIGN_MAX_FRAMES_PER_PAGE + 1),
      ]).success,
    ).toBe(false);
  });

  it("keeps the page cap in one constant", () => {
    const pages = (count: number) =>
      Array.from({ length: count }, (_, index) => page(index + 1, 0));
    expect(designPageCatalogSchema.safeParse(pages(DESIGN_MAX_PAGES)).success).toBe(true);
    expect(
      designPageCatalogSchema.safeParse(pages(DESIGN_MAX_PAGES + 1)).success,
    ).toBe(false);
  });

  it("confirms a full page for deletion", () => {
    const expectedFrameIds = page(1, DESIGN_MAX_FRAMES_PER_PAGE).frameIds;
    expect(
      designPageDeleteInputSchema.safeParse({ pageId: "page_1", expectedFrameIds })
        .success,
    ).toBe(true);
    expect(
      designPageDeleteInputSchema.safeParse({
        pageId: "page_1",
        expectedFrameIds: [...expectedFrameIds, "one_more"],
      }).success,
    ).toBe(false);
  });

  it("admits per-page stacking positions 0 through the page cap in every wire geometry", () => {
    const geometry = { x: 0, y: 0, w: 10, h: 10 };
    for (const z of [0, DESIGN_MAX_FRAMES_PER_PAGE]) {
      expect(designCatalogFrameSchema.safeParse({ ...descriptor, z }).success).toBe(true);
      expect(
        designMovementGuardSchema.safeParse({ sourceVersion: "v", geometry: { ...geometry, z } })
          .success,
      ).toBe(true);
      expect(
        designFramesMoveSchema.safeParse([
          { frame: "home.html", from: { ...geometry, z }, to: { ...geometry, z } },
        ]).success,
      ).toBe(true);
    }
    const tooHigh = DESIGN_MAX_FRAMES_PER_PAGE + 1;
    expect(designCatalogFrameSchema.safeParse({ ...descriptor, z: tooHigh }).success).toBe(false);
    expect(designPreparedFrameSchema.shape.z.safeParse(tooHigh).success).toBe(false);
    expect(
      designMovementGuardSchema.safeParse({ sourceVersion: "v", geometry: { ...geometry, z: tooHigh } })
        .success,
    ).toBe(false);
  });

  it("derives the catalog ceiling from the page and per-page caps", () => {
    expect(DESIGN_CATALOG_DESCRIPTOR_LIMIT).toBe(
      DESIGN_MAX_PAGES * DESIGN_MAX_FRAMES_PER_PAGE,
    );
    const pages = Array.from({ length: 26 }, (_, index) => ({
      id: `page_${index}`,
      title: `Page ${index}`,
      folder: `page-${index}`,
      count: DESIGN_MAX_FRAMES_PER_PAGE,
    }));
    const batch = {
      kind: "design-catalog",
      version: 1,
      status: "ready",
      owner: { workspaceId: "local", directoryId: "design_test", organizationId: null, placement: "local" },
      binding: "b".repeat(64),
      revision: "a".repeat(64),
      intent: 1,
      pages,
      total: 26 * DESIGN_MAX_FRAMES_PER_PAGE,
      offset: 25 * DESIGN_MAX_FRAMES_PER_PAGE + 999,
      frames: [
        { ...descriptor, id: "last", pageId: "page_25", source: "page-25/last.html", z: 999, order: 999 },
      ],
      coverage: "partial",
      nextCursor: null,
    };
    expect(designCatalogBatchSchema.safeParse(batch).success).toBe(true);
    expect(
      designCatalogBatchSchema.safeParse({
        ...batch,
        pages: [...pages.slice(0, -1), { ...pages.at(-1)!, count: DESIGN_MAX_FRAMES_PER_PAGE + 1 }],
        total: batch.total + 1,
      }).success,
    ).toBe(false);
  });
});

describe("page-scoped write acknowledgements", () => {
  const hash = (seed: string) => seed.repeat(32).slice(0, 32);
  const pages = [
    { id: "one", title: "One", folder: "one", count: 2, hash: hash("a") },
    { id: "two", title: "Two", folder: "two", count: 1, hash: hash("b") },
  ];
  const frame = (id: string, pageId: string, order: number) => ({
    ...descriptor, id, pageId, source: `${pageId}/${id}.html`, order, z: order,
  });

  it("negotiates per-page hashes and carries descriptors only for whole pages", () => {
    expect(DESIGN_PAGE_SCOPED_MUTATIONS_CAPABILITY).toBe("design.page-scoped-mutations.v1");
    expect(designNavigationReadSchema.parse({ workspaceId: "w", pageHashes: true })).toEqual({ workspaceId: "w", pageHashes: true });
    expect(designNavigationReadSchema.safeParse({ workspaceId: "w", pageHashes: false }).success).toBe(false);
    expect(designPageHashesSchema.safeParse({ one: hash("a") }).success).toBe(true);
    expect(designPageHashesSchema.safeParse({ one: "not-a-hash" }).success).toBe(false);
    const catalog = { revision: "a".repeat(64), pages, frames: [frame("b1", "two", 0)] };
    expect(designPageScopedCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(designPageScopedCatalogSchema.safeParse({ ...catalog, frames: [] }).success).toBe(true);
    for (const frames of [
      [frame("a1", "one", 0)],
      [frame("b1", "two", 1)],
      [frame("x", "missing", 0)],
      [frame("b1", "two", 0), frame("a1", "one", 0), frame("a2", "one", 1)],
    ])
      expect(designPageScopedCatalogSchema.safeParse({ ...catalog, frames }).success).toBe(false);
    expect(designPageScopedCatalogSchema.safeParse({
      ...catalog, frames: [frame("a1", "one", 0), frame("a2", "one", 1), frame("b1", "two", 0)],
    }).success).toBe(true);
  });
});

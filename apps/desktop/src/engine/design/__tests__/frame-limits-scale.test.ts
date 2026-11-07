import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { MAX_BRIDGE_FRAME_BYTES } from "@zeros/protocol/schemas";
import { DESIGN_MAX_FRAMES_PER_PAGE } from "@zeros/protocol/design-pages";
import { projectDesignCatalog } from "../catalog";
import { decodeCanvasFile, encodeCanvasFile } from "../canvas-file";
import type { CanvasDocument } from "../document-model";
import { pagedCanvasFixture } from "./frame-limit-fixtures";

const MAX_CANVAS_METADATA_BYTES = 16 * 1024 * 1024;
const CATALOG_SNAPSHOT_ESTIMATE_BYTES = 48 * 1024 * 1024;

describe("large Design directories stay within their byte budgets", () => {
  it.each([1, 10, 26])("%i full pages: canvas, catalog and page catalog sizes", (pages) => {
    const frames = pages * DESIGN_MAX_FRAMES_PER_PAGE;
    const source = JSON.stringify(pagedCanvasFixture(pages, DESIGN_MAX_FRAMES_PER_PAGE), null, 2) + "\n";
    const started = performance.now();
    const document = decodeCanvasFile(source, { version: 2 }) as unknown as CanvasDocument;
    const decoded = performance.now();
    expect(encodeCanvasFile(document as never, { version: 2 })).toBe(source);
    const encoded = performance.now();
    const catalog = projectDesignCatalog(document);
    const projected = performance.now();
    const catalogBytes = Buffer.byteLength(JSON.stringify(catalog.frames));
    const pageCatalogBytes = Buffer.byteLength(JSON.stringify(catalog.pages.map((page) => ({
      ...page,
      frameFiles: catalog.frames.filter((frame) => frame.pageId === page.id).map((frame) => frame.source),
      frameIds: catalog.frames.filter((frame) => frame.pageId === page.id).map((frame) => frame.id),
    }))));
    expect(catalog.frames).toHaveLength(frames);
    expect(Buffer.byteLength(source)).toBeLessThan(MAX_CANVAS_METADATA_BYTES);
    expect(catalogBytes * 2).toBeLessThan(CATALOG_SNAPSHOT_ESTIMATE_BYTES);
    // A write acknowledgement carries every descriptor and page list.
    expect(catalogBytes + pageCatalogBytes).toBeLessThan(MAX_BRIDGE_FRAME_BYTES);
    console.info(JSON.stringify({ pages, frames, canvasBytes: Buffer.byteLength(source), catalogBytes, pageCatalogBytes,
      decodeMs: Math.round(decoded - started), encodeMs: Math.round(encoded - decoded), projectMs: Math.round(projected - encoded) }));
  });
});

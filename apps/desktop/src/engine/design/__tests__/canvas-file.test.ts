import { describe, expect, it } from "vitest";
import { decodeCanvasFile, encodeCanvasFile } from "../canvas-file";

const canvas = {
  version: 1,
  id: "main",
  title: "Product",
  pages: [{ id: "screens", title: "Screens", frames: ["home"], custom: true }],
  frames: {
    home: {
      kind: "html",
      source: "home.html",
      title: "Home",
      x: 0,
      y: 0,
      width: 390,
      height: 844,
      annotation: "Keep this",
    },
  },
  foundation: { version: 1 },
  extension: { nullable: null },
};

const pagedCanvas = {
  ...canvas,
  version: 2,
  pages: [
    { id: "checkout", title: "Checkout", folder: "checkout", frames: ["checkout_home"], custom: { keep: true } },
    { id: "screens", title: "Screens", folder: "page-1", frames: ["home"], custom: true },
  ],
  frames: {
    checkout_home: { ...canvas.frames.home, source: "checkout/home.html" },
    home: { ...canvas.frames.home, source: "page-1/home.html" },
  },
};

describe("editable canvas.json", () => {
  it("retains legacy bytes and internal journal hash input without adding enumerable fields", () => {
    const document = decodeCanvasFile(JSON.stringify(canvas));
    expect(JSON.stringify(document)).toBe(JSON.stringify({
      version: 3, id: "main", title: "Product",
      foundation: canvas.foundation, extension: canvas.extension,
      pages: canvas.pages,
      frames: { "home.html": { x: 0, y: 0, w: 390, h: 844, z: 0 } },
      frame_info: { "home.html": { annotation: "Keep this", id: "home", title: "Home", kind: "frame" } },
    }));
    expect(encodeCanvasFile(document)).toBe(JSON.stringify(canvas, null, 2) + "\n");
    expect(document.pages).toEqual(canvas.pages);
    expect(document.pages).not.toHaveProperty("0.folder");
  });

  it("round trips ordered pages, membership, repeated basenames and extensions", () => {
    const document = decodeCanvasFile(JSON.stringify(pagedCanvas));
    expect(document.pages).toEqual(pagedCanvas.pages);
    expect(Object.keys(document.frames as object)).toEqual(["checkout/home.html", "page-1/home.html"]);
    expect(JSON.parse(encodeCanvasFile(document, { version: 2 }))).toEqual(pagedCanvas);
    expect(() => encodeCanvasFile(document, { version: 1 })).toThrow();
  });

  it("does not rebuild page membership or order from directory-wide z ordering", () => {
    const document = decodeCanvasFile(JSON.stringify(pagedCanvas));
    (document.frames as Record<string, { z: number }>)["checkout/home.html"].z = 5;
    (document.frames as Record<string, { z: number }>)["page-1/home.html"].z = 0;
    const result = JSON.parse(encodeCanvasFile(document, { version: 2 }));
    expect(result.pages).toEqual(pagedCanvas.pages);
    expect(result.frames.checkout_home.z).toBe(5);
    expect(decodeCanvasFile(JSON.stringify(result)).frames).toEqual(document.frames);
  });

  it("derives implicit stacking from each page's own frame order", () => {
    const value = {
      ...pagedCanvas,
      pages: pagedCanvas.pages.map((page) => ({ ...page, frames: [...page.frames, `${page.id}_second`] })),
      frames: {
        ...pagedCanvas.frames,
        checkout_second: { ...pagedCanvas.frames.checkout_home, source: "checkout/second.html" },
        screens_second: { ...pagedCanvas.frames.home, source: "page-1/second.html" },
      },
    };
    const document = decodeCanvasFile(JSON.stringify(value));
    const frames = document.frames as Record<string, { z: number }>;
    expect(Object.fromEntries(Object.entries(frames).map(([file, geometry]) => [file, geometry.z]))).toEqual({
      "checkout/home.html": 0, "checkout/second.html": 1,
      "page-1/home.html": 0, "page-1/second.html": 1,
    });
    expect(JSON.parse(encodeCanvasFile(document, { version: 2 }))).toEqual(value);
  });

  it.each([
    { ...pagedCanvas, pages: [] },
    { ...pagedCanvas, pages: Array.from({ length: 65 }, (_, index) => ({ id: `p${index}`, title: "Page", folder: `p${index}`, frames: [] })), frames: {} },
    { ...pagedCanvas, pages: [pagedCanvas.pages[0], { ...pagedCanvas.pages[1], id: "checkout" }] },
    { ...pagedCanvas, pages: [pagedCanvas.pages[0], { ...pagedCanvas.pages[1], folder: "checkout" }] },
    { ...pagedCanvas, pages: [pagedCanvas.pages[0], { ...pagedCanvas.pages[1], folder: "meta" }] },
    { ...pagedCanvas, pages: [pagedCanvas.pages[0], { ...pagedCanvas.pages[1], folder: "Page-1" }] },
    { ...pagedCanvas, pages: [pagedCanvas.pages[0], { ...pagedCanvas.pages[1], frames: [] }] },
    { ...pagedCanvas, pages: [pagedCanvas.pages[0], { ...pagedCanvas.pages[1], frames: ["checkout_home", "home"] }] },
    { ...pagedCanvas, frames: { ...pagedCanvas.frames, home: { ...pagedCanvas.frames.home, source: "checkout/other.html" } } },
    { ...pagedCanvas, frames: { ...pagedCanvas.frames, home: { ...pagedCanvas.frames.home, source: "page-1/HOME.html" }, other: { ...pagedCanvas.frames.home, source: "page-1/home.html" } }, pages: [pagedCanvas.pages[0], { ...pagedCanvas.pages[1], frames: ["home", "other"] }] },
  ])("rejects invalid pages or cross-page source membership", (value) => {
    expect(() => decodeCanvasFile(JSON.stringify(value))).toThrow();
  });

  it("defaults a canvas v1 without pages to the same virtual root page", () => {
    const { pages: _pages, ...withoutPages } = canvas;
    expect(decodeCanvasFile(JSON.stringify(withoutPages)).pages).toEqual([
      { id: "main", title: "Design", frames: ["home"] },
    ]);
  });
  it("round trips authored metadata without a duplicate document or node tree", () => {
    const document = decodeCanvasFile(JSON.stringify(canvas));
    expect(document.frames).toEqual({
      "home.html": { x: 0, y: 0, w: 390, h: 844, z: 0 },
    });
    expect(JSON.parse(encodeCanvasFile(document))).toEqual(canvas);
  });

  it("keeps frame identity when an agent renames its source", () => {
    const renamed = structuredClone(canvas);
    renamed.frames.home.source = "welcome.html";
    const document = decodeCanvasFile(JSON.stringify(renamed));
    expect(JSON.parse(encodeCanvasFile(document)).frames.home.source).toBe(
      "welcome.html",
    );
  });

  it("imports legacy geometry, text frames, extensions and Foundation metadata", () => {
    const document = {
      version: 3,
      frames: { "label.html": { x: 10, y: 20, w: 300, h: 80, z: 0 } },
      frame_info: { "label.html": { title: "Label", kind: "text" } },
      foundation: { custom: { value: null } },
      extension: { retained: true },
    };
    const decoded = decodeCanvasFile(encodeCanvasFile(document));
    expect(decoded).toMatchObject(document);
    expect(JSON.parse(encodeCanvasFile(decoded))).toEqual(
      JSON.parse(encodeCanvasFile(document)),
    );
  });

  it("writes visual geometry and ordering back into the authored metadata", () => {
    const document = decodeCanvasFile(JSON.stringify(canvas));
    (document.frames as Record<string, { x: number }>)["home.html"].x = 420;
    expect(JSON.parse(encodeCanvasFile(document)).frames.home.x).toBe(420);
  });

  it("migrates the old defaulted geometry contract but rejects damaged current geometry", () => {
    const old = { version: 1, frames: { "home.html": { x: 24 } } };
    expect(decodeCanvasFile(encodeCanvasFile(old)).frames).toEqual({
      "home.html": { x: 24, y: 0, w: 1440, h: 900, z: 0 },
    });
    expect(() => encodeCanvasFile({ ...old, version: 3 })).toThrow();
    expect(() => encodeCanvasFile({ version: 3, frames: null })).toThrow();
  });

  it.each([
    { ...canvas, version: 99 },
    {
      ...canvas,
      frames: { home: { ...canvas.frames.home, source: "../outside.html" } },
    },
    { ...canvas, frames: { home: { ...canvas.frames.home, kind: "react" } } },
    { ...canvas, frames: { home: { ...canvas.frames.home, width: -1 } } },
    {
      ...canvas,
      frames: { home: canvas.frames.home, duplicate: canvas.frames.home },
    },
    {
      ...canvas,
      pages: [{ id: "main", title: "Screens", frames: ["missing"] }],
    },
    {
      ...canvas,
      pages: [{ id: "main", title: "Screens", frames: ["home", "home"] }],
    },
  ])(
    "rejects invalid or unsupported authored metadata without guessing",
    (value) => {
      expect(() => decodeCanvasFile(JSON.stringify(value))).toThrow();
    },
  );
});

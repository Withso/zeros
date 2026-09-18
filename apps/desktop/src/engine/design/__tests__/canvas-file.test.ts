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

describe("editable canvas.json", () => {
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

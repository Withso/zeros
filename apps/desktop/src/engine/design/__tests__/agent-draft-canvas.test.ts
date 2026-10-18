import { describe, expect, it } from "vitest";
import {
  designAgentCanvasRegistrations,
  isDesignAgentCanvasFile,
} from "../agent-draft-canvas";

const canvas = {
  version: 2,
  id: "main",
  title: "Design",
  pages: [{ id: "page_1", title: "Page 1", folder: "page-1", frames: ["home", "card"] }],
  frames: {
    home: { kind: "html", source: "page-1/home.html", title: "Home", x: 0, y: 0, width: 1440, height: 900 },
    card: { kind: "html", source: "page-1/card.html", title: "Card", x: 1600, y: 40, width: 390, height: 844 },
  },
};

describe("Design agent canvas registrations", () => {
  it("names the canvas files an agent may write", () => {
    expect(isDesignAgentCanvasFile("meta/canvas.json")).toBe(true);
    expect(isDesignAgentCanvasFile("canvas.json")).toBe(true);
    expect(isDesignAgentCanvasFile("page-1/canvas.json")).toBe(false);
    expect(isDesignAgentCanvasFile("meta/design.toml")).toBe(false);
  });

  it("reads every fully received frame of a complete canvas", () => {
    expect(designAgentCanvasRegistrations(JSON.stringify(canvas, null, 2))).toEqual([
      { file: "page-1/home.html", x: 0, y: 0, width: 1440, height: 900, title: "Home" },
      { file: "page-1/card.html", x: 1600, y: 40, width: 390, height: 844, title: "Card" },
    ]);
  });

  it("places a frame only once its path and all four numbers have arrived", () => {
    const text = JSON.stringify(canvas, null, 2);
    const card = text.indexOf('"card": {');
    const height = text.indexOf('"height": 844');
    // The card's height may still be growing ("8" of "844").
    const streaming = text.slice(0, height + '"height": 8'.length);
    expect(designAgentCanvasRegistrations(streaming)).toEqual([
      { file: "page-1/home.html", x: 0, y: 0, width: 1440, height: 900, title: "Home" },
    ]);
    // A half-received path never places a frame.
    const path = text.indexOf('"page-1/card.html"', card);
    expect(designAgentCanvasRegistrations(text.slice(0, path + 8))).toHaveLength(1);
    expect(designAgentCanvasRegistrations(`${text.slice(0, height + '"height": 844'.length)},`)).toHaveLength(2);
  });

  it("keeps a frame whose title is still streaming, without the title", () => {
    const text = JSON.stringify({
      version: 2,
      frames: { card: { kind: "html", source: "page-1/card.html", x: 10, y: 20, width: 390, height: 844, title: "Check" } },
    });
    expect(designAgentCanvasRegistrations(text.slice(0, text.indexOf("Check") + 3))).toEqual([
      { file: "page-1/card.html", x: 10, y: 20, width: 390, height: 844 },
    ]);
  });

  it("ignores unsafe sources, out-of-range geometry, duplicates and non-canvas text", () => {
    const text = JSON.stringify({
      version: 2,
      frames: {
        a: { source: "../outside.html", x: 0, y: 0, width: 10, height: 10 },
        b: { source: "page-1/big.html", x: 0, y: 0, width: 99_999, height: 10 },
        c: { source: "page-1/ok.html", x: 0, y: 0, width: 10, height: 10 },
        d: { source: "page-1/ok.html", x: 5, y: 5, width: 10, height: 10 },
        e: { source: "page-1/far.html", x: 2_000_000, y: 0, width: 10, height: 10 },
      },
    });
    expect(designAgentCanvasRegistrations(text)).toEqual([
      { file: "page-1/ok.html", x: 0, y: 0, width: 10, height: 10 },
    ]);
    expect(designAgentCanvasRegistrations("")).toBeNull();
    expect(designAgentCanvasRegistrations("[1, 2]")).toBeNull();
    expect(designAgentCanvasRegistrations('{"version": 2, "pages": []')).toEqual([]);
  });
});

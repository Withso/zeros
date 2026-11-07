import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESIGN_FRAME_MAX_LAYER } from "@zeros/design-core";
import {
  DESIGN_MAX_FRAMES_PER_PAGE,
  DESIGN_MAX_PAGES,
} from "@zeros/protocol/design-pages";
import { decodeCanvasFile, encodeCanvasFile } from "../canvas-file";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument } from "../document";
import { discoverFrameFiles, readCanvas } from "../document-storage";
import { pagedCanvasFixture } from "./frame-limit-fixtures";

describe("Design page frame admission", () => {
  it("mirrors the protocol per-page cap in the transaction layer bound", () => {
    expect(DESIGN_FRAME_MAX_LAYER).toBe(DESIGN_MAX_FRAMES_PER_PAGE);
    expect(DESIGN_MAX_FRAMES_PER_PAGE).toBe(1_000);
    expect(DESIGN_MAX_PAGES).toBe(64);
  });

  describe("canvas.json", () => {
    it("decodes and re-encodes 26 full pages byte for byte", () => {
      const source = JSON.stringify(pagedCanvasFixture(26, DESIGN_MAX_FRAMES_PER_PAGE), null, 2) + "\n";
      const started = performance.now();
      const document = decodeCanvasFile(source, { version: 2 });
      const decoded = performance.now();
      expect(Object.keys(document.frames as object)).toHaveLength(26_000);
      expect(encodeCanvasFile(document, { version: 2 })).toBe(source);
      // Diagnostics only: quadratic membership lookups took tens of seconds here.
      console.info(`26x1000 canvas.json ${Buffer.byteLength(source)} bytes; decode ${Math.round(decoded - started)} ms, encode ${Math.round(performance.now() - decoded)} ms`);
    });

    it("refuses a page above the cap with a plain reason instead of a schema dump", () => {
      const paged = pagedCanvasFixture(2, DESIGN_MAX_FRAMES_PER_PAGE);
      const extra = "frame_extra";
      paged.frames[extra] = { ...Object.values(paged.frames)[0]!, source: "page-2/extra.html" };
      paged.pages[1]!.frames.push(extra);
      expect(() => decodeCanvasFile(JSON.stringify(paged), { version: 2 })).toThrow(
        'Design page "Page 2" has 1,001 frames; a page holds at most 1,000.',
      );
      const single = pagedCanvasFixture(1, DESIGN_MAX_FRAMES_PER_PAGE + 1, { version: 1 });
      expect(() => decodeCanvasFile(JSON.stringify(single), { version: 1 })).toThrow(
        'Design page "Page 1" has 1,001 frames; a page holds at most 1,000.',
      );
      const full = pagedCanvasFixture(1, DESIGN_MAX_FRAMES_PER_PAGE, { version: 1 });
      expect(Object.keys(decodeCanvasFile(JSON.stringify(full), { version: 1 }).frames as object)).toHaveLength(1_000);
    });

    it("admits explicit per-page stacking up to the cap", () => {
      const paged = pagedCanvasFixture(1, 2);
      const [first] = Object.keys(paged.frames);
      paged.frames[first!]!.z = DESIGN_MAX_FRAMES_PER_PAGE;
      const document = decodeCanvasFile(JSON.stringify(paged), { version: 2 });
      expect(Object.values(document.frames as Record<string, { z: number }>)[0]!.z).toBe(1_000);
      expect(JSON.parse(encodeCanvasFile(document, { version: 2 })).frames[first!].z).toBe(1_000);
      paged.frames[first!]!.z = DESIGN_MAX_FRAMES_PER_PAGE + 1;
      expect(() => decodeCanvasFile(JSON.stringify(paged), { version: 2 })).toThrow();
    });

    it("clamps legacy geometry to the same per-page stacking bound", () => {
      const encoded = JSON.parse(encodeCanvasFile({
        version: 1,
        frames: { "home.html": { x: 0, y: 0, w: 10, h: 10, z: 5_000 } },
      }));
      expect(Object.values(encoded.frames as Record<string, { z: number }>)[0]!.z).toBe(1_000);
    });
  });

  describe("legacy layouts", () => {
    let root: string;
    const directory = () => path.join(root, DESIGN_DIRECTORY_NAME);
    const writeFrames = async (count: number) => {
      await mkdir(directory(), { recursive: true });
      await Promise.all(Array.from({ length: count }, (_, index) =>
        writeFile(path.join(directory(), `frame-${String(index).padStart(4, "0")}.html`),
          `<!doctype html><html><head><title>Frame ${index}</title></head><body><main data-oid="m${index}">${index}</main></body></html>`)));
    };
    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "zeros-design-frame-limits-"));
      process.env.ZEROS_DATA_DIR = path.join(root, "private");
    });
    afterEach(async () => {
      delete process.env.ZEROS_DATA_DIR;
      await rm(root, { recursive: true, force: true });
    });

    it("discovers and registers every root frame past the old 256 instead of dropping the rest", async () => {
      await writeFrames(300);
      expect(await discoverFrameFiles(root)).toHaveLength(300);
      await initializeDesignDocument(root);
      const canvas = await readCanvas(root);
      expect(Object.keys(canvas.frames)).toHaveLength(300);
      expect(canvas.pages).toHaveLength(1);
      expect(canvas.pages![0]!.frames).toHaveLength(300);
    });

    it("fails a root above the page cap closed and leaves the directory untouched", async () => {
      await writeFrames(DESIGN_MAX_FRAMES_PER_PAGE + 1);
      const reason = /has 1,001 frames; a page holds at most 1,000/;
      await expect(discoverFrameFiles(root)).rejects.toThrow(reason);
      await expect(initializeDesignDocument(root)).rejects.toThrow(reason);
      expect(existsSync(path.join(directory(), "meta"))).toBe(false);
      expect((await readdir(directory())).filter((name) => name.endsWith(".html"))).toHaveLength(1_001);
    });

    it("reads legacy canvas metadata above 256 frames and refuses one above the page cap", async () => {
      for (const [count, ok] of [[300, true], [DESIGN_MAX_FRAMES_PER_PAGE + 1, false]] as const) {
        await rm(directory(), { recursive: true, force: true });
        await writeFrames(count);
        const frames = Object.fromEntries(Array.from({ length: count }, (_, index) => [
          `frame-${String(index).padStart(4, "0")}.html`, { x: index, y: 0, w: 100, h: 100, z: 0 },
        ]));
        await writeFile(path.join(directory(), ".zeros-canvas.json"), JSON.stringify({ version: 1, frames }));
        if (ok) expect(Object.keys((await readCanvas(root)).frames)).toHaveLength(count);
        else await expect(readCanvas(root)).rejects.toThrow(/has 1,001 frames; a page holds at most 1,000/);
      }
    });
  });
});

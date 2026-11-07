import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeCanvasFile, encodeCanvasFile } from "../canvas-file";
import type { CanvasDocument } from "../document-model";
import { readCanvas, writeCanvas } from "../document-storage";
import { withDesignDirectoryNameLease } from "../directory-registry";
import { pagedCanvasFixture } from "./frame-limit-fixtures";
import { pagesCanvas, pagesDirectory, pagesManifest } from "./pages-fixtures";

/** Values a JSON copy changes or drops: negative zero, explicit undefined,
 * nested extension data. */
function addEdgeValues(document: Record<string, any>, file: string, pageIndex = 0, ghosts = false) {
  document.frames[file] = { x: -0, y: 10.5, w: 300, h: 200, z: 1, note: undefined };
  document.frame_info[file] = { id: "edge_frame", title: "Edge", kind: "frame", extra: { nested: [1, { deep: true }] }, empty: undefined };
  document.pages[pageIndex].frames.push("edge_frame");
  if (!ghosts) return;
  document.frames[file.replace("edge", "ghost")] = undefined;
  document.frame_info[file.replace("edge", "ghost")] = undefined;
}

describe("canvas writes", () => {
  const roots: string[] = [];
  afterEach(() => {
    delete process.env.ZEROS_DATA_DIR;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("encodes a canvas object exactly as its JSON copy", () => {
    const document = decodeCanvasFile(JSON.stringify(pagedCanvasFixture(26, 999)), { version: 2 }) as Record<string, any>;
    addEdgeValues(document, "page-3/edge.html", 2, true);
    expect(encodeCanvasFile(document, { version: 2 })).toBe(encodeCanvasFile(JSON.parse(JSON.stringify(document)), { version: 2 }));
  });

  it("writes the same canvas bytes encoding directly as through a JSON copy", async () => {
    const setup = () => {
      const root = mkdtempSync(path.join(tmpdir(), "zeros-canvas-write-"));
      roots.push(root);
      mkdirSync(path.join(root, pagesDirectory, "meta"), { recursive: true });
      writeFileSync(path.join(root, pagesDirectory, "meta/design.toml"), pagesManifest);
      writeFileSync(path.join(root, pagesDirectory, "meta/canvas.json"), JSON.stringify(pagesCanvas));
      for (const file of ["page-1/home.html", "checkout/home.html", "page-1/edge.html"]) {
        mkdirSync(path.dirname(path.join(root, pagesDirectory, file)), { recursive: true });
        writeFileSync(path.join(root, pagesDirectory, file), '<!doctype html><html><body><main data-oid="m">x</main></body></html>');
      }
      return root;
    };
    const write = async (root: string, pinned: boolean) => {
      process.env.ZEROS_DATA_DIR = path.join(root, "private");
      await withDesignDirectoryNameLease(root, pagesDirectory, async () => {
        const canvas = await readCanvas(root);
        addEdgeValues(canvas as unknown as Record<string, any>, "page-1/edge.html");
        canvas.frames["page-1/home.html"]!.x = 42;
        // Spreading drops the read snapshot, which forces the JSON copy.
        await writeCanvas(root, pinned ? canvas : ({ ...canvas } as CanvasDocument));
      });
      return readFileSync(path.join(root, pagesDirectory, "meta/canvas.json"), "utf8");
    };
    const direct = await write(setup(), true);
    const copied = await write(setup(), false);
    expect(direct).toBe(copied);
    expect(JSON.parse(direct).frames.edge_frame).toMatchObject({ x: 0, y: 10.5, width: 300 });
  });
});

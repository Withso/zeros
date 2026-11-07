import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument, prepareDesignNavigationFrames, readDesignNavigationSnapshot } from "../document";
import { readCanvas } from "../document-storage";
import { prepareFrameRenderSource } from "../render-preparation";
import { designSurfaceCost, designTextImageBytes } from "../surface-document";

// A 1x1 transparent PNG: 8 decoded bytes.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const FORMS_SVG = `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`;
const viewport = { width: 320, height: 240 };

describe("surface cost", () => {
  it("charges SVG data URIs at their declared size and keeps unknown vector content unknown", () => {
    expect(designTextImageBytes(`.a { background: ${FORMS_SVG} }`)).toBe(20 * 20 * 8);
    expect(designTextImageBytes(`.a { background: url(data:image/svg+xml;base64,${Buffer.from('<svg width="24" height="16"></svg>').toString("base64")}) }`)).toBe(24 * 16 * 8);
    expect(designTextImageBytes(`.a { background: url('data:image/svg+xml;utf8,<svg width="10px" height="5" viewBox="0 0 99 99"></svg>') }`)).toBe(10 * 5 * 8);
    expect(designTextImageBytes(`.a { background: url( data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2012%2012%22%3E%3C%2Fsvg%3E ) }`)).toBe(12 * 12 * 8);
    expect(designTextImageBytes(`<img src="data:image/png;base64,${PNG}"><i style="background:url('data:image/svg+xml,%3csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 20 20%22%3e%3c/svg%3e')"></i>`)).toBe(8 + 20 * 20 * 8);
    for (const unknown of [
      `url("data:image/svg+xml,%3csvg viewBox='0 0 20 20'%3e%3canimate/%3e%3c/svg%3e")`,
      `url("data:image/svg+xml,%3csvg width='9' height='9'%3e%3cimage href='x.png'/%3e%3c/svg%3e")`,
      `url("data:image/svg+xml,%3csvg width='100%25' height='9'%3e%3c/svg%3e")`,
      `url("data:image/svg+xml,%3csvg width='99999' height='9'%3e%3c/svg%3e")`,
      `url("data:image/svg+xml,%E0%A4%A")`,
      `url("data:image/bmp;base64,Qk0=")`,
    ]) expect(designTextImageBytes(`.a { background: ${unknown} }`), unknown).toBeNull();
    expect(designTextImageBytes(`.a { width: ${"9".repeat(200_000)}x }`)).toBe(0);
  });

  it("keeps a placeholder unknown unless the CSS it stands for was measured", () => {
    const skeleton = '<!doctype html><html><head><style data-zeros-sheet="s0-x"></style></head><body><main data-oid="m"></main></body></html>';
    expect(designSurfaceCost(skeleton, [{ css: "", bytes: 100 }])).toBeNull();
    expect(designSurfaceCost(skeleton, [{ css: "", bytes: 100, imageBytes: 64 }])).toEqual({
      sourceBytes: Buffer.byteLength(skeleton) + 100, nodes: 5, imageBytes: 64,
    });
  });

  describe("frames with imported style sources", () => {
    let root: string;
    let folder: string;
    const frame = "page-1/home.html";
    const html = '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="main" class="hero"><select data-oid="pick" class="picker"></select></main></body></html>';
    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "zeros-surface-cost-"));
      process.env.ZEROS_DATA_DIR = path.join(root, "private");
      folder = path.join(root, DESIGN_DIRECTORY_NAME);
      await initializeDesignDocument(root);
      await mkdir(path.join(root, "styles"), { recursive: true });
      await writeFile(path.join(folder, "tokens.css"), ":root { --gap: 4px; }");
      // Kept: the frame uses .hero and .picker. Pruned: .unused carries an image the frame never shows.
      await writeFile(path.join(root, "styles/app.css"), [
        `.hero { background: url(data:image/png;base64,${PNG}); }`,
        `.picker { background-image: ${FORMS_SVG}; }`,
        `.unused { background: url(data:image/png;base64,${PNG}), url(data:image/bmp;base64,Qk0=); }`,
      ].join("\n"));
      await writeFile(path.join(folder, frame), html);
      const file = path.join(folder, "meta/canvas.json");
      const canvas = JSON.parse(await readFile(file, "utf8"));
      canvas.styles = [{ id: "app", title: "App", kind: "css", path: "styles/app.css" }];
      canvas.frames.home = { kind: "html", source: frame, title: "Home", x: 0, y: 0, width: 320, height: 240 };
      canvas.pages[0].frames.push("home");
      await writeFile(file, JSON.stringify(canvas, null, 2));
    });
    afterEach(async () => {
      delete process.env.ZEROS_DATA_DIR;
      await rm(root, { recursive: true, force: true });
    });

    it("measures an identity read as the composed document costs, without composing it", async () => {
      const canvas = await readCanvas(root);
      const identity = await prepareFrameRenderSource(root, html, viewport, undefined, undefined, frame, canvas, { identityOnly: true });
      const composed = await prepareFrameRenderSource(root, html, viewport, undefined, undefined, frame, canvas);
      expect(identity.sanitized).toMatch(/data-zeros-style-source="app" data-zeros-sheet="[^"]+"><\/style>/);
      expect(composed.sanitized).toContain(".picker");
      expect(composed.sanitized).not.toContain(".unused");
      expect(identity.surfaceCost).toEqual({ sourceBytes: expect.any(Number), nodes: expect.any(Number), imageBytes: 8 + 20 * 20 * 8 });
      expect(identity.surfaceCost).toEqual(composed.surfaceCost);
      const navigation = await readDesignNavigationSnapshot(root);
      const prepared = await prepareDesignNavigationFrames(root, navigation.catalogRevision, [frame]);
      expect(prepared.frames[0]!.surfaceCost).toEqual(composed.surfaceCost);
    });

    it("stays unknown when the CSS a frame keeps carries an image it cannot size", async () => {
      const unknown = html.replace('class="picker"', 'class="picker unused"');
      await writeFile(path.join(folder, frame), unknown);
      const canvas = await readCanvas(root);
      const identity = await prepareFrameRenderSource(root, unknown, viewport, undefined, undefined, frame, canvas, { identityOnly: true });
      expect(identity.surfaceCost).toBeNull();
      expect((await prepareFrameRenderSource(root, unknown, viewport, undefined, undefined, frame, canvas)).surfaceCost).toBeNull();
    });
  });
});

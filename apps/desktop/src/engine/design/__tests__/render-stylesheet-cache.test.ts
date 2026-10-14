import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument } from "../document";
import {
  designStylesheetCacheStatsForTests,
  prepareFrameRenderSource,
  resetDesignStylesheetCacheForTests,
} from "../render-preparation";

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const viewport = { width: 320, height: 240 };
const frame = (body: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="m">${body}</main></body></html>`;

describe("shared stylesheet preparation", () => {
  let root: string;
  let folder: string;
  const touch = async (file: string, body: string | Buffer, offsetMs: number) => {
    await writeFile(file, body);
    const time = new Date(Date.now() + offsetMs);
    await utimes(file, time, time);
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-stylesheet-cache-"));
    folder = path.join(root, DESIGN_DIRECTORY_NAME);
    await initializeDesignDocument(root);
    await mkdir(path.join(folder, "assets"), { recursive: true });
    await writeFile(path.join(folder, "assets/dot.png"), PNG);
    await writeFile(
      path.join(folder, "tokens.css"),
      ":root { --gap: 4px; } .hero { background: url(assets/dot.png); }",
    );
    resetDesignStylesheetCacheForTests();
  });
  afterEach(async () => {
    resetDesignStylesheetCacheForTests();
    await rm(root, { recursive: true, force: true });
  });

  it("prepares a stylesheet once for every frame in a page folder", async () => {
    for (let index = 0; index < 5; index += 1) {
      await prepareFrameRenderSource(root, frame(`Frame ${index}`), viewport, undefined, undefined, `page-1/frame-${index}.html`);
    }
    expect(designStylesheetCacheStatsForTests()).toEqual({ hits: 4, misses: 1 });
  });

  it("computes the same generation without building the document", async () => {
    const source = frame("Home");
    const full = await prepareFrameRenderSource(root, source, viewport, undefined, undefined, "page-1/home.html");
    const identity = await prepareFrameRenderSource(root, source, viewport, undefined, undefined, "page-1/home.html", undefined, { identityOnly: true });
    expect(identity.sourceVersion).toBe(full.sourceVersion);
    expect(full.sanitized).toContain("--gap: 4px");
    expect(full.sanitized).toMatch(/<style data-zeros-source="tokens\.css" data-zeros-sheet="0-[a-f0-9]{24}">:root/);
    expect(full.sanitized).toContain("data:image/png;base64,");
    expect(identity.sanitized).not.toContain("--gap");
    expect(identity.sanitized).toMatch(/data-zeros-sheet="0-[a-f0-9]{24}"><\/style>/);
  });

  it("gives frames a new generation when the stylesheet or an image it inlines changes", async () => {
    const source = frame("Home");
    const render = () => prepareFrameRenderSource(root, source, viewport, undefined, undefined, "page-1/home.html");
    const first = await render();
    await touch(path.join(folder, "tokens.css"), ":root { --gap: 8px; } .hero { background: url(assets/dot.png); }", 5_000);
    const edited = await render();
    expect(edited.sourceVersion).not.toBe(first.sourceVersion);
    expect(edited.sanitized).toContain("--gap: 8px");
    await touch(path.join(folder, "assets/dot.png"), Buffer.concat([PNG, Buffer.from([0])]), 10_000);
    const reimaged = await render();
    expect(reimaged.sourceVersion).not.toBe(edited.sourceVersion);
    expect(designStylesheetCacheStatsForTests().misses).toBe(3);
  });

  it("inlines the fonts a stylesheet's @font-face rules use, but not from HTML attributes", async () => {
    const font = Buffer.from("wOF2 fixture font");
    await writeFile(path.join(folder, "assets/brand.woff2"), font);
    await writeFile(
      path.join(folder, "tokens.css"),
      '@font-face { font-family: Brand; src: url(assets/brand.woff2) format("woff2"); } :root { --gap: 4px; }',
    );
    const source = '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"><style>@font-face { font-family: Own; src: url(../assets/brand.woff2); }</style></head><body><main data-oid="m"><img data-oid="i" src="../assets/brand.woff2"></main></body></html>';
    const render = () => prepareFrameRenderSource(root, source, viewport, undefined, undefined, "page-1/home.html");
    const first = await render();
    const embedded = `url("data:font/woff2;base64,${font.toString("base64")}")`;
    expect(first.sanitized).toContain(`src: ${embedded} format("woff2")`);
    expect(first.sanitized).toContain(`font-family: Own; src: ${embedded}`);
    expect(first.sanitized).toContain('src="../assets/brand.woff2"');
    await touch(path.join(folder, "assets/brand.woff2"), Buffer.concat([font, Buffer.from([1])]), 5_000);
    expect((await render()).sourceVersion).not.toBe(first.sourceVersion);
  });

  it("reports an oversized frame from its identity as well as its document", async () => {
    await writeFile(path.join(folder, "tokens.css"), `:root { --pad: "${"x".repeat(1_200_000)}"; }`);
    const links = Array.from({ length: 14 }, (_, index) => `<link rel="stylesheet" href="../tokens.css?copy=${index}">`).join("");
    const source = `<!doctype html><html><head>${links}</head><body><main data-oid="m">Big</main></body></html>`;
    const render = (identityOnly: boolean) =>
      prepareFrameRenderSource(root, source, viewport, undefined, undefined, "page-1/big.html", undefined, { identityOnly });
    await expect(render(false)).rejects.toThrow(/15 MiB/);
    await expect(render(true)).rejects.toThrow(/15 MiB/);
  });

  it("prepares a separately rebased copy for each page folder", async () => {
    await prepareFrameRenderSource(root, frame("A"), viewport, undefined, undefined, "page-1/a.html");
    await prepareFrameRenderSource(root, frame("B"), viewport, undefined, undefined, "page-2/b.html");
    expect(designStylesheetCacheStatsForTests()).toEqual({ hits: 0, misses: 2 });
  });
});

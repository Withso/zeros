import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as safeFiles from "../safe-files";
import { primeDesignDirectoryName, forgetDesignDirectoryName } from "../directory-registry";
import { readDesignNavigationSnapshot, prepareDesignNavigationFrames, readDesignFrame } from "../document";

let root: string;
const directory = "Product - Design";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-design-navigation-"));
  primeDesignDirectoryName(root, directory);
  await mkdir(path.join(root, directory, "meta"), { recursive: true });
  await mkdir(path.join(root, directory, "page-1"), { recursive: true });
  await writeFile(path.join(root, directory, "meta/design.toml"), 'format = "zeros-design"\nversion = 3\nid = "design_test"\ncanvas = "canvas.json"\n');
  const ids = Array.from({ length: 256 }, (_, i) => `f${i}`);
  await writeFile(path.join(root, directory, "meta/canvas.json"), JSON.stringify({ version: 2,
    pages: [{ id: "page", title: "Page", folder: "page-1", frames: ids }],
    frames: Object.fromEntries(ids.map((id, i) => [id, { source: `page-1/${id}.html`, title: id,
      kind: "html", x: i * 500, y: 0, width: 400, height: 300, z: 0 }])) }));
  await Promise.all(ids.map((id) => writeFile(path.join(root, directory, `page-1/${id}.html`), `<html><head><link rel="stylesheet" href="../shared.css"></head><body data-oid="root">${id}</body></html>`)));
  await writeFile(path.join(root, directory, "shared.css"), "body { color: red }");
});
afterEach(async () => { vi.restoreAllMocks(); forgetDesignDirectoryName(root); await rm(root, { recursive: true, force: true }); });

it("opens 256 descriptors without reading frame HTML, then prepares only the requested files", async () => {
  const reads = vi.spyOn(safeFiles, "readSafeRegularFile");
  const navigation = await readDesignNavigationSnapshot(root);
  expect(navigation.snapshot.pages[0]!.frameFiles).toHaveLength(256);
  expect(navigation.snapshot.frames).toEqual([]);
  expect(navigation.snapshot.lint.checkedFiles).toEqual([]);
  expect(reads.mock.calls.filter(([, file]) => file.endsWith(".html"))).toHaveLength(0);
  const result = await prepareDesignNavigationFrames(root, navigation.catalogRevision, ["page-1/f0.html", "page-1/f1.html"]);
  expect(result.frames.map((frame) => frame.file)).toEqual(["page-1/f0.html", "page-1/f1.html"]);
  expect(new Set(reads.mock.calls.filter(([, file]) => file.endsWith(".html")).map(([, file]) => path.basename(file))))
    .toEqual(new Set(["f0.html", "f1.html"]));
});

it("revalidates source and shared dependencies independently of the metadata revision", async () => {
  const navigation = await readDesignNavigationSnapshot(root);
  const prepare = () => prepareDesignNavigationFrames(root, navigation.catalogRevision, ["page-1/f0.html"]);
  const first = (await prepare()).frames[0]!;
  await writeFile(path.join(root, directory, "shared.css"), "body { color: blue }");
  const css = (await prepare()).frames[0]!;
  expect(css.sourceVersion).not.toBe(first.sourceVersion);
  await writeFile(path.join(root, directory, first.file), '<html><body data-oid="root">Changed</body></html>');
  const html = (await prepare()).frames[0]!;
  expect(html.sourceVersion).not.toBe(css.sourceVersion);
  expect((await readDesignNavigationSnapshot(root)).catalogRevision).toBe(navigation.catalogRevision);
});

it("hydrates a registered fallback document without scanning siblings and refuses foreign metadata", async () => {
  const reads = vi.spyOn(safeFiles, "readSafeRegularFile");
  const frame = await readDesignFrame(root, "page-1/f0.html");
  expect(frame.srcDoc).toContain("f0");
  expect(new Set(reads.mock.calls.filter(([, file]) => file.endsWith(".html")).map(([, file]) => path.basename(file))))
    .toEqual(new Set(["f0.html"]));
  await expect(prepareDesignNavigationFrames(root, "0".repeat(64), [frame.file])).rejects.toThrow(/changed|stale/i);
});

it("includes local image, font and theme changes in source authority and revalidates resized metadata", async () => {
  const dir = path.join(root, directory);
  await writeFile(path.join(dir, "page-1/f0.html"), '<html><head><link rel="stylesheet" href="../tokens.css"><link rel="stylesheet" href="../shared.css"></head><body data-oid="root"><img data-oid="image" src="../mark.png"></body></html>');
  await writeFile(path.join(dir, "shared.css"), '@font-face{font-family:Fixture;src:url("./fixture.woff2")}body{font-family:Fixture;color:var(--ink)}');
  // External SVGs are intentionally unsupported; dependency authority covers
  // the raster formats the renderer actually embeds.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=", "base64");
  await writeFile(path.join(dir, "mark.png"), png);
  await writeFile(path.join(dir, "fixture.woff2"), Buffer.from("fixture-font-one"));
  await writeFile(path.join(dir, "tokens.css"), ':root{--ink:blue}[data-zd-theme="dark"]{--ink:white}');
  let navigation = await readDesignNavigationSnapshot(root);
  const prepare = async () => (await prepareDesignNavigationFrames(root, navigation.catalogRevision, ["page-1/f0.html"])).frames[0]!;
  const first = await prepare();
  const document = await readDesignFrame(root, first.file);
  expect(document.srcDoc).toContain("data:image/png;base64,");
  expect(document.srcDoc).toContain("data:font/woff2;base64,");
  expect(document.sourceVersion).toBe(first.sourceVersion);
  await writeFile(path.join(dir, "mark.png"), Buffer.concat([png, Buffer.from([0])]));
  const image = await prepare();
  expect(image.sourceVersion).not.toBe(first.sourceVersion);
  await writeFile(path.join(dir, "fixture.woff2"), Buffer.from("fixture-font-two"));
  const font = await prepare();
  expect(font.sourceVersion).not.toBe(image.sourceVersion);
  await writeFile(path.join(dir, "tokens.css"), ':root{--ink:blue}[data-zd-theme="dark"]{--ink:yellow}');
  const theme = await prepare();
  expect(theme.sourceVersion).not.toBe(font.sourceVersion);
  expect((await readDesignNavigationSnapshot(root)).catalogRevision).toBe(navigation.catalogRevision);
  const canvasPath = path.join(dir, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
  canvas.frames.f0.width = 500;
  await writeFile(canvasPath, JSON.stringify(canvas));
  await expect(prepare()).rejects.toThrow(/changed|stale/i);
  navigation = await readDesignNavigationSnapshot(root);
  const resized = await prepare();
  expect(resized.width).toBe(500);
  expect(resized.sourceVersion).not.toBe(theme.sourceVersion);
});

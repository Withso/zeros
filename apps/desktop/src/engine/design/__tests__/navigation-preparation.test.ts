import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as safeFiles from "../safe-files";
import { primeDesignDirectoryName, forgetDesignDirectoryName } from "../directory-registry";
import {
  prepareDesignNavigationFrames,
  readDesignElementOffsetMap,
  readDesignFrame,
  readDesignFrameRenderIdentity,
  readDesignFrameSelectionIdentity,
  readDesignMutationSnapshot,
  readDesignNavigationSnapshot,
} from "../document";
import { designSharedCanvasReadsForTests, readCanvas } from "../document-storage";
import { designSharedCatalogProjectionsForTests } from "../catalog-storage";
import { readDesignProtocolResource } from "../protocol-resource";

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
  expect(navigation.snapshot.pages![0]!.frameFiles).toHaveLength(256);
  expect(navigation.snapshot.frames).toEqual([]);
  expect(navigation.snapshot.lint.checkedFiles).toEqual([]);
  expect(reads.mock.calls.filter(([, file]) => file.endsWith(".html"))).toHaveLength(0);
  const result = await prepareDesignNavigationFrames(root, navigation.catalogRevision, ["page-1/f0.html", "page-1/f1.html"]);
  expect(result.frames.map((frame) => frame.file)).toEqual(["page-1/f0.html", "page-1/f1.html"]);
  expect(new Set(reads.mock.calls.filter(([, file]) => file.endsWith(".html")).map(([, file]) => path.basename(file))))
    .toEqual(new Set(["f0.html", "f1.html"]));
});

it("acknowledges an edit among 256 frames by preparing only affected source, with complete metadata", async () => {
  const reads = vi.spyOn(safeFiles, "readSafeRegularFile");
  const snapshot = await readDesignMutationSnapshot(root, ["page-1/f0.html", "removed.html"]);
  expect(snapshot.frames.map(frame => frame.file)).toEqual(["page-1/f0.html"]);
  expect(snapshot.mutationCatalog?.frames).toHaveLength(256);
  expect(snapshot.pages![0]!.frameFiles).toHaveLength(256);
  expect(new Set(reads.mock.calls.filter(([, file]) => file.endsWith(".html")).map(([, file]) => path.basename(file))))
    .toEqual(new Set(["f0.html"]));
  expect(snapshot.frames[0]!.sourceVersion).toBe((await readDesignFrame(root, "page-1/f0.html")).sourceVersion);
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

it("reuses a batch's decoded canvas only while the catalog revision is unchanged", async () => {
  const navigation = await readDesignNavigationSnapshot(root);
  const prepare = (revision: string, file: string) => prepareDesignNavigationFrames(root, revision, [file]);
  expect((await prepare(navigation.catalogRevision, "page-1/f0.html")).frames[0]!.x).toBe(0);
  expect((await prepare(navigation.catalogRevision, "page-1/f1.html")).frames[0]!.x).toBe(500);
  const file = path.join(root, directory, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(file, "utf8"));
  canvas.frames.f1.x = 777;
  await writeFile(file, JSON.stringify(canvas));
  await expect(prepare(navigation.catalogRevision, "page-1/f1.html")).rejects.toThrow(/stale/);
  const next = await readDesignNavigationSnapshot(root);
  expect((await prepare(next.catalogRevision, "page-1/f1.html")).frames[0]!.x).toBe(777);
});

it("serves frame documents from one decoded canvas while its bytes are unchanged", async () => {
  const reads = designSharedCanvasReadsForTests();
  for (const file of ["page-1/f0.html", "page-1/f1.html", "page-1/f2.html"])
    expect((await readDesignProtocolResource(root, { path: file, sourceVersion: null })).status).toBe(200);
  expect(designSharedCanvasReadsForTests() - reads).toBe(1);
  const file = path.join(root, directory, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(file, "utf8"));
  canvas.pages[0].frames = canvas.pages[0].frames.filter((id: string) => id !== "f2");
  delete canvas.frames.f2;
  await writeFile(file, JSON.stringify(canvas));
  expect((await readDesignProtocolResource(root, { path: "page-1/f2.html", sourceVersion: null })).status).toBe(404);
  expect((await readDesignProtocolResource(root, { path: "page-1/f0.html", sourceVersion: null })).status).toBe(200);
  expect(designSharedCanvasReadsForTests() - reads).toBe(2);
});

it("reads frame identities and element offsets from the shared canvas, failing wherever a fresh read would", async () => {
  await writeFile(path.join(root, directory, "page-1/f2.html"), '<html><body><main data-oid="m">f2</main></body></html>');
  const reads = designSharedCanvasReadsForTests();
  const navigation = await readDesignNavigationSnapshot(root);
  const prepared = await prepareDesignNavigationFrames(root, navigation.catalogRevision, ["page-1/f0.html"]);
  expect((await readDesignFrameSelectionIdentity(root, "page-1/f0.html")).sourceVersion).toBe(prepared.frames[0]!.sourceVersion);
  expect((await readDesignFrameRenderIdentity(root, "page-1/f1.html")).file).toBe("page-1/f1.html");
  expect((await readDesignElementOffsetMap(root, "page-1/f2.html")).map((offset) => offset.oid)).toEqual(["m"]);
  expect(designSharedCanvasReadsForTests() - reads).toBe(1);
  const outcome = (read: Promise<unknown>) => read.then(() => "read", (error: Error) => error.message);
  const matchesFreshRead = async () =>
    expect(await outcome(readDesignFrameSelectionIdentity(root, "page-1/f0.html"))).toBe(await outcome(readCanvas(root)));
  await writeFile(path.join(root, directory, ".zeros-canvas.json"), "{}");
  await matchesFreshRead();
  await rm(path.join(root, directory, ".zeros-canvas.json"));
  await rename(path.join(root, directory, "page-1"), path.join(root, directory, "page-1-real"));
  await symlink(path.join(root, directory, "page-1-real"), path.join(root, directory, "page-1"));
  expect(await outcome(readCanvas(root))).toMatch(/real directories/);
  await matchesFreshRead();
});

it("serves navigation at an unchanged revision from one shared decode and projection", async () => {
  const first = await readDesignNavigationSnapshot(root, undefined, { pageHashes: true });
  const reads = designSharedCanvasReadsForTests();
  const projections = designSharedCatalogProjectionsForTests();
  expect(await readDesignNavigationSnapshot(root, undefined, { pageHashes: true })).toEqual(first);
  expect(designSharedCanvasReadsForTests() - reads).toBe(0);
  expect(designSharedCatalogProjectionsForTests() - projections).toBe(0);
  const file = path.join(root, directory, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(file, "utf8"));
  canvas.frames.f1.x = 777;
  await writeFile(file, JSON.stringify(canvas));
  const moved = await readDesignNavigationSnapshot(root, undefined, { pageHashes: true });
  expect(moved.catalogRevision).not.toBe(first.catalogRevision);
  expect(moved.pageHashes).not.toEqual(first.pageHashes);
  expect(designSharedCatalogProjectionsForTests() - projections).toBe(1);
  expect(moved.snapshot.pages).toEqual(first.snapshot.pages);
});

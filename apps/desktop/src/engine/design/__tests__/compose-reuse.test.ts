import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument, prepareDesignNavigationFrames, readDesignNavigationSnapshot } from "../document";
import { designDirectoryNameFor } from "../directory-registry";
import { resetDesignIdentityCacheForTests } from "../identity-cache";
import { designDirectoryEntry } from "../metadata";
import { configureRetainedDesignFramesForTests, noteDesignRecordedCanvas, retainedDesignFrameStatsForTests } from "../retained-frames";
import * as tailwind from "../style-tailwind";
import { composeDesignThumbnailBatches } from "../thumbnail-batch";

let root: string;
let folder: string;
const files = Array.from({ length: 4 }, (_, index) => `page-1/f${index}.html`);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function prepare() {
  const navigation = await readDesignNavigationSnapshot(root);
  const prepared = await prepareDesignNavigationFrames(root, navigation.catalogRevision, files);
  expect(prepared.errors).toEqual([]);
  return prepared.frames.map(({ file, sourceVersion }) => ({ file, sourceVersion: sourceVersion! }));
}
async function compose(frames: Array<{ file: string; sourceVersion: string }>) {
  const result = await composeDesignThumbnailBatches(root, { workspaceId: "w", directoryId: designDirectoryEntry(root, designDirectoryNameFor(root))!.id,
    theme: null, colorScheme: "light", maxDimension: 256, frames });
  // Each request carries a fresh random revision; everything else must match.
  return { ...result, batches: result.batches.map(({ request, frames: items }) => ({ request: { ...request, revision: "" }, frames: [...items] })) };
}
const reused = () => retainedDesignFrameStatsForTests().reused;

beforeEach(async () => {
  resetDesignIdentityCacheForTests();
  configureRetainedDesignFramesForTests();
  root = await mkdtemp(path.join(tmpdir(), "zeros-compose-reuse-"));
  process.env.ZEROS_DATA_DIR = path.join(root, "private");
  folder = path.join(root, DESIGN_DIRECTORY_NAME);
  await initializeDesignDocument(root);
  await mkdir(path.join(folder, "page-1"), { recursive: true });
  await mkdir(path.join(folder, "components"), { recursive: true });
  await mkdir(path.join(root, "styles"), { recursive: true });
  await writeFile(path.join(folder, "tokens.css"), ".hero { color: red; }");
  await writeFile(path.join(root, "styles/app.css"), `.card { padding: 1px; background: url(data:image/png;base64,${PNG}); } .unused { margin: 9px; }`);
  await writeFile(path.join(folder, "components/card.html"), "<!doctype html><html><head><style>.c { margin: 2px; }</style></head><body><article class=\"c\"><slot></slot></article></body></html>");
  const canvasFile = path.join(folder, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
  canvas.styles = [{ id: "app", title: "App", kind: "css", path: "styles/app.css" }];
  for (const [index, file] of files.entries()) {
    await writeFile(path.join(folder, file), `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main class="hero card">${index}<zd-card>x</zd-card></main></body></html>`);
    canvas.frames[`frame_${index}`] = { kind: "html", source: file, title: file, x: index * 400, y: 0, width: 320, height: 200 };
    canvas.pages[0].frames.push(`frame_${index}`);
  }
  await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
  noteDesignRecordedCanvas(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  configureRetainedDesignFramesForTests();
  delete process.env.ZEROS_DATA_DIR;
  await rm(root, { recursive: true, force: true });
});

it("composes a prepared frame from its identity read, byte for byte, and only once", async () => {
  const frames = await prepare();
  const before = reused();
  const fromRead = await compose(frames);
  expect(reused() - before).toBe(files.length);
  expect(fromRead.failed).toEqual([]);
  expect(fromRead.stale).toEqual([]);
  // The read is used up: the same capture again composes from the source.
  const fromSource = await compose(frames);
  expect(reused() - before).toBe(files.length);
  expect(fromRead).toEqual(fromSource);
});

it("composes from the source when a file the read saw, or the frame's canvas context, changed", async () => {
  const frames = await prepare();
  await writeFile(path.join(folder, "tokens.css"), ".hero { color: blue; }");
  const before = reused();
  const changed = await compose(frames);
  expect(reused() - before).toBe(0);
  // Exactly what composing without a kept read reports: every frame moved on.
  expect(changed.stale.map(({ file }) => file).sort()).toEqual([...files].sort());

  const current = await prepare();
  const canvasFile = path.join(folder, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
  canvas.styles = [];
  await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
  const restyled = await compose(current);
  expect(reused() - before).toBe(0);
  expect(restyled.stale.map(({ file }) => file).sort()).toEqual([...files].sort());
});

it("keeps nothing past its budget, and composes those frames from the source", async () => {
  configureRetainedDesignFramesForTests({ budget: 64 });
  const frames = await prepare();
  expect(retainedDesignFrameStatsForTests().held).toBe(0);
  const before = reused();
  const composed = await compose(frames);
  expect(reused() - before).toBe(0);
  expect(composed.failed).toEqual([]);
  expect(composed.batches.flatMap((batch) => batch.request.items)).toHaveLength(files.length);
});

it("keeps no reads for a checkout whose canvas hasn't asked for recordings", async () => {
  configureRetainedDesignFramesForTests();
  const frames = await prepare();
  expect(retainedDesignFrameStatsForTests().held).toBe(0);
  const before = reused();
  expect((await compose(frames)).failed).toEqual([]);
  expect(reused() - before).toBe(0);
});

it("keeps a frame's Tailwind candidates from its identity read, composing byte for byte", async () => {
  const canvasFile = path.join(folder, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
  canvas.styles.push({ id: "tw", title: "Tailwind", kind: "tailwind", path: "styles/tw.css" });
  await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
  await writeFile(path.join(root, "styles/tw.css"), '@import "tailwindcss";');
  for (const file of files) await writeFile(path.join(folder, file), (await readFile(path.join(folder, file), "utf8"))
    .replace('class="hero card"', 'class="hero card p-2 underline"'));
  const frames = await prepare();
  const candidates = vi.spyOn(tailwind, "designTailwindCandidates");
  const before = reused();
  const fromRead = await compose(frames);
  expect(reused() - before).toBe(files.length);
  // The kept candidates stand in for reading each frame's HTML again (a
  // batch's whole sources read none).
  const framesRead = () => candidates.mock.calls.filter(([html]) => html !== "").length;
  expect(framesRead()).toBe(0);
  const fromSource = await compose(frames);
  expect(framesRead()).toBe(files.length);
  expect(fromRead.failed).toEqual([]);
  expect(fromRead).toEqual(fromSource);
  expect(JSON.stringify(fromRead.batches[0]!.request.stylesheets)).toContain("text-decoration-line: underline");
});


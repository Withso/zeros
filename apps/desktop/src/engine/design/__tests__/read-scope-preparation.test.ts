import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument, prepareDesignNavigationFrames, readDesignNavigationSnapshot } from "../document";
import { designDirectoryNameFor } from "../directory-registry";
import { resetDesignIdentityCacheForTests } from "../identity-cache";
import { designDirectoryEntry } from "../metadata";
import { composeDesignThumbnailBatches } from "../thumbnail-batch";

// Every safe read opens through this module: counting its opens counts the
// files a request read, not the calls that asked for them.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let root: string;
let folder: string;
const files = Array.from({ length: 12 }, (_, index) => `page-1/f${index}.html`);
const opens = (target: string) => vi.mocked(open).mock.calls.filter(([file]) => String(file) === target).length;

beforeEach(async () => {
  resetDesignIdentityCacheForTests();
  root = await mkdtemp(path.join(tmpdir(), "zeros-read-scope-"));
  process.env.ZEROS_DATA_DIR = path.join(root, "private");
  folder = path.join(root, DESIGN_DIRECTORY_NAME);
  await initializeDesignDocument(root);
  await mkdir(path.join(folder, "page-1"), { recursive: true });
  await mkdir(path.join(root, "styles"), { recursive: true });
  await writeFile(path.join(folder, "tokens.css"), ".hero { color: red; }");
  await writeFile(path.join(root, "styles/app.css"), ".card { padding: 1px; }");
  const canvasFile = path.join(folder, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
  canvas.styles = [{ id: "app", title: "App", kind: "css", path: "styles/app.css" }];
  for (const [index, file] of files.entries()) {
    await writeFile(path.join(folder, file), `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="m" class="hero card">${index}</main></body></html>`);
    canvas.frames[`frame_${index}`] = { kind: "html", source: file, title: file, x: index * 400, y: 0, width: 320, height: 200 };
    canvas.pages[0].frames.push(`frame_${index}`);
  }
  await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
});
afterEach(async () => {
  delete process.env.ZEROS_DATA_DIR;
  await rm(root, { recursive: true, force: true });
});

it("opens each file a batch's frames share once, whether preparing or composing them", async () => {
  const navigation = await readDesignNavigationSnapshot(root);
  vi.mocked(open).mockClear();
  const prepared = await prepareDesignNavigationFrames(root, navigation.catalogRevision, files);
  expect(prepared.errors).toEqual([]);
  // One inspection and, the first time, one read.
  expect(opens(path.join(folder, "tokens.css"))).toBeLessThanOrEqual(2);
  expect(opens(path.join(root, "styles/app.css"))).toBeLessThanOrEqual(2);
  for (const file of files) expect(opens(path.join(folder, file))).toBe(1);

  vi.mocked(open).mockClear();
  const composed = await composeDesignThumbnailBatches(root, { workspaceId: "w", directoryId: designDirectoryEntry(root, designDirectoryNameFor(root))!.id,
    theme: null, colorScheme: "light", maxDimension: 256, frames: prepared.frames.map(({ file, sourceVersion }) => ({ file, sourceVersion: sourceVersion! })) });
  expect(composed.failed).toEqual([]);
  expect(composed.batches.flatMap((batch) => batch.request.items)).toHaveLength(files.length);
  expect(opens(path.join(folder, "tokens.css"))).toBeLessThanOrEqual(2);
  expect(opens(path.join(root, "styles/app.css"))).toBeLessThanOrEqual(2);
});

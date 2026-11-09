import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument, prepareDesignNavigationFrames, readDesignNavigationSnapshot } from "../document";
import { designIdentityCacheStatsForTests, resetDesignIdentityCacheForTests } from "../identity-cache";
import {
  configureDesignPreparationWorkersForTests,
  designPreparationWorkerCount,
  designPreparationWorkerStatsForTests,
  prepareFrameIdentitiesInWorkers,
  stopDesignPreparationWorkers,
} from "../preparation-pool";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** The worker as one ESM file. Node cannot load the engine's TypeScript in
 * a worker thread (Bun, which ships the engine, can), so tests bundle it. */
let bundle: { directory: string; url: URL };
beforeAll(async () => {
  // Inside the checkout, so the bundle's external packages resolve from its node_modules.
  const cache = path.resolve(__dirname, "../../../../../../node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, "zeros-preparation-worker-"));
  const outfile = path.join(directory, "preparation-worker.mjs");
  await build({
    entryPoints: [path.join(__dirname, "../preparation-worker.ts")],
    bundle: true, platform: "node", format: "esm", target: "node22", outfile, logLevel: "error",
    external: ["better-sqlite3", "node-pty", "bun:sqlite", "fsevents", "@tailwindcss/oxide", "lightningcss", "*.node"],
    banner: { js: 'import { createRequire as __workerRequire } from "node:module"; const require = __workerRequire(import.meta.url);' },
  });
  bundle = { directory, url: pathToFileURL(outfile) };
}, 120_000);
afterAll(async () => {
  await rm(bundle.directory, { recursive: true, force: true });
});

describe("Design preparation workers", () => {
  let root: string;
  let folder: string;
  const files = Array.from({ length: 6 }, (_, index) => `page-1/f${index}.html`);
  beforeEach(async () => {
    resetDesignIdentityCacheForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-preparation-pool-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    folder = path.join(root, DESIGN_DIRECTORY_NAME);
    await initializeDesignDocument(root);
    await mkdir(path.join(folder, "page-1"), { recursive: true });
    await mkdir(path.join(folder, "components"), { recursive: true });
    await mkdir(path.join(root, "styles"), { recursive: true });
    await writeFile(path.join(folder, "tokens.css"), ".hero { color: red; }");
    await writeFile(path.join(root, "styles/app.css"), `.card { padding: 1px; background: url(data:image/png;base64,${PNG}); }`);
    await writeFile(path.join(folder, "components/card.html"), "<!doctype html><html><head><style>.c { margin: 2px; }</style></head><body><article class=\"c\"><slot></slot></article></body></html>");
    const canvasFile = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    canvas.styles = [{ id: "app", title: "App", kind: "css", path: "styles/app.css" }];
    for (const [index, file] of files.entries()) {
      await writeFile(path.join(folder, file), `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="m" class="hero card">${index}<zd-card data-oid="c">x</zd-card><svg data-oid="s" viewBox="0 0 2 2"><path d="M0 0h2"/></svg></main></body></html>`);
      canvas.frames[`frame_${index}`] = { kind: "html", source: file, title: file, x: index * 400, y: 0, width: 320, height: 200 };
      canvas.pages[0].frames.push(`frame_${index}`);
    }
    await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
  });
  afterEach(async () => {
    configureDesignPreparationWorkersForTests(null);
    await stopDesignPreparationWorkers();
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("stays off unless asked, leaving two cores", () => {
    expect(designPreparationWorkerCount({}, 8)).toBe(0);
    expect(designPreparationWorkerCount({ ZEROS_DESIGN_PREPARATION_WORKERS: "4" }, 8)).toBe(4);
    expect(designPreparationWorkerCount({ ZEROS_DESIGN_PREPARATION_WORKERS: "4" }, 4)).toBe(2);
    expect(designPreparationWorkerCount({ ZEROS_DESIGN_PREPARATION_WORKERS: "4" }, 2)).toBe(0);
    expect(designPreparationWorkerCount({ ZEROS_DESIGN_PREPARATION_WORKERS: "x" }, 8)).toBe(0);
  });

  it("prepares cold frames on workers exactly as the engine's own thread does, and remembers them", async () => {
    const navigation = await readDesignNavigationSnapshot(root);
    const single = await prepareDesignNavigationFrames(root, navigation.catalogRevision, files);
    expect(single.errors).toEqual([]);
    resetDesignIdentityCacheForTests();
    configureDesignPreparationWorkersForTests(2, { workerUrl: bundle.url });
    const before = designPreparationWorkerStatsForTests().frames;
    const pooled = await prepareDesignNavigationFrames(root, navigation.catalogRevision, files);
    expect(designPreparationWorkerStatsForTests().frames - before).toBe(files.length);
    expect(pooled).toEqual(single);
    // The engine remembered what the workers prepared.
    configureDesignPreparationWorkersForTests(0);
    const hits = designIdentityCacheStatsForTests().hits;
    expect(await prepareDesignNavigationFrames(root, navigation.catalogRevision, files)).toEqual(single);
    expect(designIdentityCacheStatsForTests().hits - hits).toBe(files.length);
  }, 60_000);

  it("keeps the workers of a batch in flight when the previous batch's idle deadline passes", async () => {
    const navigation = await readDesignNavigationSnapshot(root);
    configureDesignPreparationWorkersForTests(2, { workerUrl: bundle.url });
    const prepared = (results: Awaited<ReturnType<typeof prepareFrameIdentitiesInWorkers>>) =>
      results.filter((result) => "identity" in result).length;
    // Only the pool's own idle deadline moves; the workers run on real time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(prepared(await prepareFrameIdentitiesInWorkers(root, navigation.catalogRevision, files))).toBe(files.length);
      vi.advanceTimersByTime(29_000);
      const second = prepareFrameIdentitiesInWorkers(root, navigation.catalogRevision, files);
      vi.advanceTimersByTime(2_000);
      expect(prepared(await second)).toBe(files.length);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("stays on the engine's thread, warning once, when a worker cannot start", async () => {
    const navigation = await readDesignNavigationSnapshot(root);
    const single = await prepareDesignNavigationFrames(root, navigation.catalogRevision, files);
    resetDesignIdentityCacheForTests();
    configureDesignPreparationWorkersForTests(2, { workerUrl: pathToFileURL(path.join(root, "missing-worker.mjs")) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const before = designPreparationWorkerStatsForTests().frames;
      expect(await prepareDesignNavigationFrames(root, navigation.catalogRevision, files)).toEqual(single);
      resetDesignIdentityCacheForTests();
      expect(await prepareDesignNavigationFrames(root, navigation.catalogRevision, files)).toEqual(single);
      expect(designPreparationWorkerStatsForTests().frames).toBe(before);
      expect(warn.mock.calls.filter(([message]) => String(message).includes("preparation workers unavailable"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it("leaves batches with App fonts to the engine's own thread", async () => {
    const canvasFile = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    canvas.fonts = [{ family: "Inter", provider: "google" }];
    await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
    const navigation = await readDesignNavigationSnapshot(root);
    configureDesignPreparationWorkersForTests(2, { workerUrl: bundle.url });
    const before = designPreparationWorkerStatsForTests().frames;
    const prepared = await prepareDesignNavigationFrames(root, navigation.catalogRevision, files);
    expect(prepared.frames).toHaveLength(files.length);
    expect(designPreparationWorkerStatsForTests().frames).toBe(before);
  }, 60_000);
});

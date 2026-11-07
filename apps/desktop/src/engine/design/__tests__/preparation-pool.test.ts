import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument, prepareDesignNavigationFrames, readDesignNavigationSnapshot } from "../document";
import { designIdentityCacheStatsForTests, resetDesignIdentityCacheForTests } from "../identity-cache";
import {
  configureDesignPreparationWorkersForTests,
  designPreparationWorkerCount,
  designPreparationWorkerStatsForTests,
  stopDesignPreparationWorkers,
} from "../preparation-pool";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

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
    configureDesignPreparationWorkersForTests(2);
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

  it("leaves batches with App fonts to the engine's own thread", async () => {
    const canvasFile = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    canvas.fonts = [{ family: "Inter", provider: "google" }];
    await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
    const navigation = await readDesignNavigationSnapshot(root);
    configureDesignPreparationWorkersForTests(2);
    const before = designPreparationWorkerStatsForTests().frames;
    const prepared = await prepareDesignNavigationFrames(root, navigation.catalogRevision, files);
    expect(prepared.frames).toHaveLength(files.length);
    expect(designPreparationWorkerStatsForTests().frames).toBe(before);
  }, 60_000);
});

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureDurableDesignDependencies,
  durableDesignDependenciesCurrent,
  namedDesignPathPolicy,
  observeDesignDependencyCheck,
  observeDesignFileDependency,
} from "../dependency-read-set";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument, prepareDesignNavigationFrames, readDesignNavigationSnapshot } from "../document";
import {
  configureDesignIdentityCacheForTests,
  designIdentityCacheStatsForTests,
  flushDesignIdentityCacheForTests,
  resetDesignIdentityCacheForTests,
} from "../identity-cache";
import { resetDesignStylesheetCacheForTests } from "../render-preparation";
import { sharedDesignParseStatsForTests } from "../shared-parse";

// A 1x1 transparent PNG, and a 2x1 one.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const WIDE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNkYGD4z8DAwMAAAA4AAWHKSr8AAAAASUVORK5CYII=", "base64");

describe("durable Design frame identities", () => {
  let root: string;
  let folder: string;
  const frames = ["page-1/a.html", "page-1/b.html"];
  const write = async (file: string, body: string | Buffer, offsetMs = 0) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    if (offsetMs) await utimes(target, new Date(Date.now() + offsetMs), new Date(Date.now() + offsetMs));
  };
  const editCanvas = async (edit: (canvas: Record<string, any>) => void) => {
    const file = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(file, "utf8"));
    edit(canvas);
    await writeFile(file, JSON.stringify(canvas, null, 2));
  };
  const prepare = async () => {
    const navigation = await readDesignNavigationSnapshot(root);
    const prepared = await prepareDesignNavigationFrames(root, navigation.catalogRevision, frames);
    expect(prepared.errors).toEqual([]);
    return prepared.frames;
  };
  /** The same preparation with nothing remembered. */
  const fresh = async () => {
    resetDesignIdentityCacheForTests();
    resetDesignStylesheetCacheForTests();
    return prepare();
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-identity-cache-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    folder = path.join(root, DESIGN_DIRECTORY_NAME);
    await initializeDesignDocument(root);
    configureDesignIdentityCacheForTests({ durable: false });
    resetDesignIdentityCacheForTests();
    resetDesignStylesheetCacheForTests();
    const design = path.relative(root, folder);
    await write(`${design}/assets/dot.png`, PNG);
    await write(`${design}/tokens.css`, ":root { --gap: 4px; } .hero { background: url(assets/dot.png); }");
    await write(`${design}/components/card.html`, '<!doctype html><html><head><style>.card { padding: 2px; }</style></head><body><article class="card"><slot></slot></article></body></html>');
    await write("styles/app.css", ".hero { color: red; } .unused { color: blue; }");
    await write(`${design}/page-1/a.html`, '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="m" class="hero"><zd-card data-oid="c">x</zd-card><img data-oid="i" src="../assets/dot.png"><img data-oid="p" src="../assets/photo.png"></main></body></html>');
    await write(`${design}/assets/photo.png`, PNG);
    await write(`${design}/page-1/b.html`, '<!doctype html><html><head></head><body><main data-oid="m">b</main></body></html>');
    await editCanvas((canvas) => {
      canvas.styles = [{ id: "app", title: "App", kind: "css", path: "styles/app.css" }];
      for (const [index, file] of frames.entries()) {
        canvas.frames[`frame_${index}`] = { kind: "html", source: file, title: file, x: index * 400, y: 0, width: 320, height: 240 };
        canvas.pages[0].frames.push(`frame_${index}`);
      }
    });
  });
  afterEach(async () => {
    configureDesignIdentityCacheForTests({});
    resetDesignIdentityCacheForTests();
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("serves an unchanged frame's identity from its fingerprints without preparing it again", async () => {
    const first = await prepare();
    const stats = designIdentityCacheStatsForTests();
    const parses = sharedDesignParseStatsForTests();
    expect(await prepare()).toEqual(first);
    expect(designIdentityCacheStatsForTests().hits - stats.hits).toBe(2);
    expect(designIdentityCacheStatsForTests().misses - stats.misses).toBe(0);
    expect(sharedDesignParseStatsForTests().parses - parses.parses).toBe(0);
  });

  it("prepares a frame again when any input it read changes, exactly as a fresh preparation would", async () => {
    const design = path.relative(root, folder);
    const changes: Array<[string, () => Promise<void>]> = [
      ["frame source", () => write(`${design}/page-1/a.html`, '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="m" class="hero"><zd-card data-oid="c">changed</zd-card><img data-oid="i" src="../assets/dot.png"><img data-oid="p" src="../assets/photo.png"></main></body></html>', 2_000)],
      ["linked stylesheet", () => write(`${design}/tokens.css`, ":root { --gap: 8px; } .hero { background: url(assets/dot.png); }", 4_000)],
      ["asset a stylesheet inlines", () => write(`${design}/assets/dot.png`, WIDE, 6_000)],
      ["component definition", () => write(`${design}/components/card.html`, '<!doctype html><html><head><style>.card { padding: 9px; }</style></head><body><article class="card"><slot></slot></article></body></html>', 8_000)],
      ["asset only an image reads", () => write(`${design}/assets/photo.png`, WIDE, 9_000)],
      ["asset removed", () => rm(path.join(folder, "assets/photo.png"))],
      ["imported style source", () => write("styles/app.css", ".hero { color: green; }", 10_000)],
      ["style declarations", () => editCanvas((canvas) => { canvas.styles[0].title = "App styles"; })],
      ["frame size", () => editCanvas((canvas) => { canvas.frames.frame_0.width = 360; })],
    ];
    let before = await prepare();
    for (const [input, change] of changes) {
      await change();
      const after = await prepare();
      expect(after, input).toEqual(await fresh());
      // Every frame imports the canvas style sources; only frame a reads the rest.
      const shared = input === "imported style source" || input === "style declarations";
      if (input !== "style declarations")
        expect(after[0]!.sourceVersion, input).not.toBe(before[0]!.sourceVersion);
      if (!shared) expect(after[1]!.sourceVersion, input).toBe(before[1]!.sourceVersion);
      before = after;
    }
  });

  it("keeps a frame's identity when it only moves", async () => {
    await prepare();
    await editCanvas((canvas) => { canvas.frames.frame_0.x = 5_000; canvas.frames.frame_1.y = 900; });
    const stats = designIdentityCacheStatsForTests();
    const moved = await prepare();
    expect(designIdentityCacheStatsForTests().hits - stats.hits).toBe(2);
    expect(moved[0]!.x).toBe(5_000);
    expect(moved).toEqual(await fresh());
  });

  it("serves identities across a restart only to the same engine build", async () => {
    configureDesignIdentityCacheForTests({ durable: true, build: "build-1" });
    const first = await prepare();
    await flushDesignIdentityCacheForTests();
    resetDesignIdentityCacheForTests();
    let stats = designIdentityCacheStatsForTests();
    expect(await prepare()).toEqual(first);
    expect(designIdentityCacheStatsForTests().hits - stats.hits).toBe(2);
    configureDesignIdentityCacheForTests({ durable: true, build: "build-2" });
    resetDesignIdentityCacheForTests();
    stats = designIdentityCacheStatsForTests();
    expect(await prepare()).toEqual(first);
    expect(designIdentityCacheStatsForTests().misses - stats.misses).toBe(2);
  });
});

describe("durable dependency read sets", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-read-set-"));
    await writeFile(path.join(root, "a.css"), "a");
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("stores named policies, keeps checks and unnamed policies in memory, and re-verifies by bytes", async () => {
    const target = path.join(root, "a.css");
    const fingerprint = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";
    const named = namedDesignPathPolicy("test-only", () => true);
    const stored = await captureDurableDesignDependencies(async () => {
      observeDesignFileDependency(root, { target, limit: 10, fingerprint, allowCanonicalPath: named });
    });
    expect(stored.durable).toEqual([{ root, target, limit: 10, fingerprint, policies: ["test-only"] }]);
    const memo = new Map<string, string | null>();
    expect(durableDesignDependenciesCurrent(stored.durable!, memo)).toBe(true);
    await writeFile(target, "b");
    expect(durableDesignDependenciesCurrent(stored.durable!, memo)).toBe(true);
    expect(durableDesignDependenciesCurrent(stored.durable!)).toBe(false);
    expect(stored.current()).toBe(false);
    const checked = await captureDurableDesignDependencies(async () => { observeDesignDependencyCheck(() => undefined); });
    expect(checked.durable).toBeNull();
    expect(checked.current()).toBe(true);
    const unnamed = await captureDurableDesignDependencies(async () => {
      observeDesignFileDependency(root, { target, limit: 10, fingerprint: null, allowCanonicalPath: () => true });
    });
    expect(unnamed.durable).toBeNull();
    const changing = await captureDurableDesignDependencies(async () => {
      observeDesignFileDependency(root, { target, limit: 10, fingerprint: "1".repeat(64) });
      observeDesignFileDependency(root, { target, limit: 10, fingerprint: "2".repeat(64) });
      return "read";
    });
    expect(changing).toMatchObject({ value: "read", complete: false });
  });
});

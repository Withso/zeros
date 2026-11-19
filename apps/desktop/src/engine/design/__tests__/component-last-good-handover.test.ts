import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({ count: 0, reply: null as null | ((frames: Array<{ file: string; sourceVersion?: string }>) => Promise<unknown[]>) }));
vi.mock("../preparation-pool", async (original) => ({
  ...await original<typeof import("../preparation-pool")>(),
  designPreparationWorkerCount: () => pool.count,
  composeFrameSourcesInWorkers: (_root: string, frames: Array<{ file: string; sourceVersion?: string }>) => pool.reply!(frames),
}));

import {
  adoptDesignComponentRenderFromWorker, designComponentRenderBytesForTests, designComponentRenderMark, forgetDesignComponentRender,
  lastGoodDesignComponentRender, rememberDesignComponentRender, resetDesignComponentRendersForTests,
} from "../component-last-good";
import { designDirectoryNameFor } from "../directory-registry";
import { createDesignFrame, DESIGN_DIRECTORY_NAME, prepareDesignNavigationFrames, readDesignFrame, readDesignNavigationSnapshot } from "../document";
import { readCanvas, writeCanvas } from "../document-storage";
import { resetDesignIdentityCacheForTests } from "../identity-cache";
import { designDirectoryEntry } from "../metadata";
import { composeDesignThumbnailBatches } from "../thumbnail-batch";

const MAIN = `<!doctype html><html><head><title>Chip</title>
<template data-zd-options>
<zd-option name="label" type="text" default="Send"></zd-option>
</template></head>
<body><div data-oid="root"><b data-oid="b">{{ label }}</b></div></body></html>`;
const PLAIN = '<!doctype html><html><head></head><body><p data-oid="p">plain</p></body></html>';
const OLDER = "<!doctype html><html><body>composed by a worker from an earlier source</body></html>";

describe("a last good render a preparation worker hands to the engine", () => {
  let root: string;
  let main: string;
  let files: string[];
  beforeEach(async () => {
    resetDesignComponentRendersForTests();
    resetDesignIdentityCacheForTests();
    pool.count = 0;
    root = await mkdtemp(path.join(tmpdir(), "zeros-last-good-handover-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    const created = [await createDesignFrame(root, { title: "Chip" }), await createDesignFrame(root, { title: "Plain" })];
    files = created.map(({ file }) => file);
    main = files[0]!;
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main), MAIN);
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, files[1]!), PLAIN);
    const canvas = await readCanvas(root);
    canvas.frame_info[main] = { ...canvas.frame_info[main]!, component: "chip" } as never;
    await writeCanvas(root, canvas);
  });
  afterEach(async () => {
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  /** Composes every frame on held "workers"; `during` runs while their reply is held. */
  const composeHeld = async (during: () => Promise<void>) => {
    const prepared = await prepareDesignNavigationFrames(root, (await readDesignNavigationSnapshot(root)).catalogRevision, files);
    expect(prepared.errors).toEqual([]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let dispatched!: () => void;
    const sent = new Promise<void>((resolve) => { dispatched = resolve; });
    pool.reply = async (frames) => {
      dispatched();
      await held;
      return frames.map(({ file, sourceVersion }) => ({ file, sourceVersion: sourceVersion!, sanitized: PLAIN, ...(file === main ? { lastGood: OLDER } : {}) }));
    };
    pool.count = 2;
    const input = { workspaceId: "w", directoryId: designDirectoryEntry(root, designDirectoryNameFor(root))!.id, theme: null,
      colorScheme: "light" as const, maxDimension: 256, frames: prepared.frames.map(({ file, sourceVersion }) => ({ file, sourceVersion: sourceVersion! })) };
    const composing = composeDesignThumbnailBatches(root, input as never);
    await sent;
    await during();
    release();
    await composing;
  };

  it("never replaces a render the engine recorded while the workers composed", async () => {
    let newer: string | undefined;
    await composeHeld(async () => {
      await readDesignFrame(root, main);
      newer = lastGoodDesignComponentRender(root, main);
    });
    expect(newer).toBeDefined();
    expect(newer).not.toBe(OLDER);
    expect(lastGoodDesignComponentRender(root, main)).toBe(newer);
  });

  it("is kept when the engine recorded nothing for that frame meanwhile", async () => {
    await composeHeld(async () => {});
    expect(lastGoodDesignComponentRender(root, main)).toBe(OLDER);
  });

  it("is dropped when the engine forgot that frame while the workers composed", async () => {
    await composeHeld(async () => {
      await readDesignFrame(root, main);
      expect(lastGoodDesignComponentRender(root, main)).toBeDefined();
      forgetDesignComponentRender(root, main);
    });
    expect(lastGoodDesignComponentRender(root, main)).toBeUndefined();
  });
});

describe("what the engine keeps to judge a worker's render", () => {
  beforeEach(() => resetDesignComponentRendersForTests());
  const frames = 1000;

  it("stays bounded however many frames with a last good render are deleted", () => {
    for (let i = 0; i < frames; i++) {
      rememberDesignComponentRender("/w", `page/f${i}.html`, "<p>good</p>");
      forgetDesignComponentRender("/w", `page/f${i}.html`);
    }
    expect(designComponentRenderBytesForTests().frames).toBe(0);
    expect(designComponentRenderBytesForTests().stamps).toBeLessThan(frames / 2);
  });

  it("still refuses a worker's render of a frame forgotten long before the reply", () => {
    rememberDesignComponentRender("/w", "page/main.html", "<p>newer</p>");
    const mark = designComponentRenderMark();
    forgetDesignComponentRender("/w", "page/main.html");
    for (let i = 0; i < frames; i++) {
      rememberDesignComponentRender("/w", `page/f${i}.html`, "<p>good</p>");
      forgetDesignComponentRender("/w", `page/f${i}.html`);
    }
    adoptDesignComponentRenderFromWorker("/w", "page/main.html", "<p>older</p>", mark);
    expect(lastGoodDesignComponentRender("/w", "page/main.html")).toBeUndefined();
  });
});

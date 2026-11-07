import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withWorkspaceMutation } from "../../git/mutation-lock";
import { initializeDesignDocument, readDesignNavigationSnapshot } from "../document";

describe("Design navigation reads waiting for the workspace lane", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-navigation-reads-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    await initializeDesignDocument(root);
  });
  afterEach(async () => {
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("share one read until it starts, so retries cannot pile up behind the lane", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => { entered = resolve; });
    const lane = withWorkspaceMutation(root, async () => { entered(); await held; });
    await holding;
    const first = readDesignNavigationSnapshot(root);
    const retries = [readDesignNavigationSnapshot(root), readDesignNavigationSnapshot(root)];
    const withHashes = readDesignNavigationSnapshot(root, undefined, { pageHashes: true });
    release();
    await lane;
    const [read, ...again] = await Promise.all([first, ...retries]);
    for (const retry of again) expect(retry).toBe(read);
    expect(await withHashes).not.toBe(read);
    // Once a read has finished, the next request reads again.
    const later = await readDesignNavigationSnapshot(root);
    expect(later).not.toBe(read);
    expect(later.catalogRevision).toBe(read.catalogRevision);
  });
});

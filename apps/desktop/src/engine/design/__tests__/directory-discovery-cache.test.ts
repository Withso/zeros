import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  designDiscoveryCacheStatsForTests,
  discoverDesignDirectories,
  resetDesignDiscoveryCacheForTests,
} from "../directory";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  return stdout.trim();
}

describe("discoverDesignDirectories evidence-keyed cache", () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    resetDesignDiscoveryCacheForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-discovery-"));
    repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, "code.txt"), "code\n");
    await mkdir(path.join(repo, "Zeros Design"), { recursive: true });
    await writeFile(path.join(repo, "Zeros Design", ".zeros-canvas.json"), "{}\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns committed markers and serves repeats from cache", async () => {
    expect(await discoverDesignDirectories(repo)).toEqual(["Zeros Design"]);
    const afterCold = designDiscoveryCacheStatsForTests();
    expect(afterCold.misses).toBeGreaterThan(0);
    expect(await discoverDesignDirectories(repo)).toEqual(["Zeros Design"]);
    const afterWarm = designDiscoveryCacheStatsForTests();
    expect(afterWarm.hits).toBeGreaterThanOrEqual(afterCold.hits + 2);
    expect(afterWarm.misses).toBe(afterCold.misses);
  });

  it("observes a newly staged marker immediately (index invalidation)", async () => {
    expect(await discoverDesignDirectories(repo)).toEqual(["Zeros Design"]);
    await mkdir(path.join(repo, "apps", "web", "designs"), { recursive: true });
    await writeFile(
      path.join(repo, "apps", "web", "designs", ".zeros-canvas.json"),
      "{}\n",
    );
    await git(repo, "add", "apps/web/designs/.zeros-canvas.json");
    expect(await discoverDesignDirectories(repo)).toEqual(
      ["Zeros Design", "apps/web/designs"].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("observes a HEAD move immediately (soft reset without index change is keyed by oid)", async () => {
    await mkdir(path.join(repo, "second"), { recursive: true });
    await writeFile(path.join(repo, "second", ".zeros-canvas.json"), "{}\n");
    await git(repo, "add", "second/.zeros-canvas.json");
    await git(repo, "commit", "-q", "-m", "second design dir");
    expect(await discoverDesignDirectories(repo)).toEqual(
      ["Zeros Design", "second"].sort((a, b) => a.localeCompare(b)),
    );
    // Move HEAD back one commit without rewriting the index: the committed
    // (HEAD) evidence changes while the staged evidence still lists both.
    await git(repo, "reset", "-q", "--soft", "HEAD~1");
    const afterSoftReset = await discoverDesignDirectories(repo);
    expect(afterSoftReset).toContain("Zeros Design");
    // HEAD-tree evidence for the older commit must not include "second"; it
    // survives only through the still-staged index entry.
    await git(repo, "rm", "-q", "--cached", "second/.zeros-canvas.json");
    expect(await discoverDesignDirectories(repo)).toEqual(["Zeros Design"]);
  });

  it("observes marker removal committed to HEAD", async () => {
    expect(await discoverDesignDirectories(repo)).toEqual(["Zeros Design"]);
    await git(repo, "rm", "-q", "Zeros Design/.zeros-canvas.json");
    await git(repo, "commit", "-q", "-m", "remove design marker");
    expect(await discoverDesignDirectories(repo)).toEqual([]);
  });

  it("shares the immutable HEAD-tree scan across checkouts at the same commit", async () => {
    await discoverDesignDirectories(repo);
    const clone = path.join(root, "clone");
    await git(root, "clone", "-q", repo, clone);
    const before = designDiscoveryCacheStatsForTests();
    expect(await discoverDesignDirectories(clone)).toEqual(["Zeros Design"]);
    const after = designDiscoveryCacheStatsForTests();
    // The clone's index differs (fresh file), but its HEAD oid is identical,
    // so the expensive full-tree scan is served from cache.
    expect(after.hits).toBeGreaterThan(before.hits);
  });

  it("keeps working in a non-Git directory without caching", async () => {
    const plain = path.join(root, "plain");
    await mkdir(plain, { recursive: true });
    expect(await discoverDesignDirectories(plain)).toEqual([]);
    expect(await discoverDesignDirectories(plain)).toEqual([]);
  });
});

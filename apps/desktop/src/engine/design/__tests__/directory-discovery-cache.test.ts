import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
    await writeFile(
      path.join(repo, "Zeros Design", ".zeros-canvas.json"),
      "{}\n",
    );
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

  // A linked worktree's `.git` is a FILE holding `gitdir: …`, so this is the
  // branch that classifies and then reads that entry. Conductor runs every
  // agent in one, and it owns a per-worktree index — the identity the cache
  // keys on — so both halves are exercised here.
  it("keys a linked worktree on its own index, not the main checkout's", async () => {
    const linked = path.join(root, "linked");
    await git(repo, "worktree", "add", "-q", "-b", "wt", linked);
    expect(await discoverDesignDirectories(linked)).toEqual(["Zeros Design"]);
    const afterCold = designDiscoveryCacheStatsForTests();
    expect(await discoverDesignDirectories(linked)).toEqual(["Zeros Design"]);
    expect(designDiscoveryCacheStatsForTests().hits).toBeGreaterThan(
      afterCold.hits,
    );

    // Staging into the worktree writes the worktree's index. The cached
    // listing must not survive it.
    await mkdir(path.join(linked, "linked-design"), { recursive: true });
    await writeFile(
      path.join(linked, "linked-design", ".zeros-canvas.json"),
      "{}\n",
    );
    await git(linked, "add", "linked-design/.zeros-canvas.json");
    expect(await discoverDesignDirectories(linked)).toEqual([
      "linked-design",
      "Zeros Design",
    ]);
    // The main checkout shares HEAD but not that index, so it is unaffected.
    expect(await discoverDesignDirectories(repo)).toEqual(["Zeros Design"]);
  });

  // A `.git` reached through a symlink cannot be pinned to one inode, so it
  // establishes no index identity and its listing is never cached. Both repos
  // here are UNBORN on purpose: with no HEAD the immutable-tree cache sits out
  // entirely, leaving the index side as the only thing the counters can move.
  it("refuses to cache an index reached through a symlinked .git", async () => {
    const seed = async (dir: string): Promise<void> => {
      await mkdir(path.join(dir, "Zeros Design"), { recursive: true });
      await writeFile(
        path.join(dir, "Zeros Design", ".zeros-canvas.json"),
        "{}\n",
      );
      await git(dir, "add", "Zeros Design/.zeros-canvas.json");
    };

    // Control: a real `.git` on an unborn repo caches its index listing.
    const unborn = path.join(root, "unborn");
    await mkdir(unborn, { recursive: true });
    await git(unborn, "init", "-q", "-b", "main");
    await seed(unborn);
    const beforeControl = designDiscoveryCacheStatsForTests();
    expect(await discoverDesignDirectories(unborn)).toEqual(["Zeros Design"]);
    expect(designDiscoveryCacheStatsForTests().misses).toBe(
      beforeControl.misses + 1,
    );

    // Same repository, reached through an aliased `.git`: identical answer,
    // but nothing is recorded, so every call re-reads the real index.
    const aliased = path.join(root, "aliased");
    await mkdir(aliased, { recursive: true });
    await symlink(path.join(unborn, ".git"), path.join(aliased, ".git"));
    const before = designDiscoveryCacheStatsForTests();
    expect(await discoverDesignDirectories(aliased)).toEqual(["Zeros Design"]);
    expect(await discoverDesignDirectories(aliased)).toEqual(["Zeros Design"]);
    const after = designDiscoveryCacheStatsForTests();
    expect(after.misses).toBe(before.misses);
    expect(after.hits).toBe(before.hits);
  });

  it("keeps working in a non-Git directory without caching", async () => {
    const plain = path.join(root, "plain");
    await mkdir(plain, { recursive: true });
    expect(await discoverDesignDirectories(plain)).toEqual([]);
    expect(await discoverDesignDirectories(plain)).toEqual([]);
  });
});

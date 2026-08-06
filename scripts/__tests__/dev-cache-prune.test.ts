// Per-worktree Chromium profiles live at
// ~/Library/Caches/com.zeros.dev.<slug>. They used to leak forever — dead
// worktrees left hundreds of MB each until the disk filled
// and the installed alpha could no longer stage auto-updates (ENOSPC,
// 2026-08-06). These tests pin the prune's safety envelope: only regenerable
// entries inside stale `com.zeros.dev.*` profiles go; durable browser state,
// the profile root, the primary dev profile, the launching instance's own
// profile, fresh profiles, symlinks and installed channels are untouchable.

import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs module without type declarations
import {
  pruneStaleDevCaches,
  STALE_DEV_CACHE_MS,
} from "../dev-cache-prune.mjs";

const NOW = 1_800_000_000_000;
const OLD_SECONDS = (NOW - STALE_DEV_CACHE_MS - 24 * 60 * 60 * 1000) / 1000;
const FRESH_SECONDS = (NOW - 60 * 1000) / 1000;

let root: string;

function makeCacheDir(name: string, ageSeconds: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const child = join(dir, "Cache_Data");
  mkdirSync(child);
  // Order matters: touching the child updates the parent's mtime, so age the
  // parent last.
  utimesSync(child, ageSeconds, ageSeconds);
  utimesSync(dir, ageSeconds, ageSeconds);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zeros-cache-prune-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pruneStaleDevCaches", () => {
  it("preserves durable browser state while pruning regenerable data", () => {
    const profile = makeCacheDir(
      "com.zeros.dev.dormant-worktree-ab12",
      OLD_SECONDS,
    );
    const regenerable = [
      "Cache",
      "Code Cache",
      "GPUCache",
      "DawnWebGPUCache",
      "DawnGraphiteCache",
      "Shared Dictionary",
      "VideoDecodeStats",
    ];
    const durable = [
      "Local Storage",
      "Session Storage",
      "IndexedDB",
      "WebStorage",
      "SharedStorage",
      "future-durable-state",
    ];

    for (const entry of [...regenerable, ...durable]) {
      const dir = join(profile, entry);
      mkdirSync(dir);
      writeFileSync(join(dir, "sentinel"), entry);
      utimesSync(dir, OLD_SECONDS, OLD_SECONDS);
    }
    for (const entry of ["Cookies", "Cookies-journal", "SharedStorage-wal"]) {
      const file = join(profile, entry);
      writeFileSync(file, entry);
      utimesSync(file, OLD_SECONDS, OLD_SECONDS);
    }
    utimesSync(profile, OLD_SECONDS, OLD_SECONDS);

    expect(pruneStaleDevCaches({ cachesRoot: root, now: NOW })).toEqual([
      "com.zeros.dev.dormant-worktree-ab12",
    ]);

    expect(existsSync(profile)).toBe(true);
    for (const entry of regenerable) {
      expect(existsSync(join(profile, entry))).toBe(false);
    }
    for (const entry of durable) {
      expect(readFileSync(join(profile, entry, "sentinel"), "utf8")).toBe(
        entry,
      );
    }
    for (const entry of ["Cookies", "Cookies-journal", "SharedStorage-wal"]) {
      expect(readFileSync(join(profile, entry), "utf8")).toBe(entry);
    }
  });

  it("prunes regenerable data only from stale instance profiles", () => {
    const stale = makeCacheDir("com.zeros.dev.dead-branch-ab12", OLD_SECONDS);
    const fresh = makeCacheDir("com.zeros.dev.live-branch-cd34", FRESH_SECONDS);
    const staleCache = join(stale, "Cache");
    const freshCache = join(fresh, "Cache");
    mkdirSync(staleCache);
    mkdirSync(freshCache);
    utimesSync(staleCache, OLD_SECONDS, OLD_SECONDS);
    utimesSync(stale, OLD_SECONDS, OLD_SECONDS);

    const pruned = pruneStaleDevCaches({ cachesRoot: root, now: NOW });

    expect(pruned).toEqual(["com.zeros.dev.dead-branch-ab12"]);
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(staleCache)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(freshCache)).toBe(true);
  });

  it("never touches the primary dev dir or installed-channel caches", () => {
    const primary = makeCacheDir("com.zeros.dev", OLD_SECONDS);
    const prod = makeCacheDir("com.zeros", OLD_SECONDS);
    const alpha = makeCacheDir("com.zeros.alpha", OLD_SECONDS);
    const beta = makeCacheDir("com.zeros.beta", OLD_SECONDS);
    const shipIt = makeCacheDir("com.zeros.alpha.ShipIt", OLD_SECONDS);

    const pruned = pruneStaleDevCaches({ cachesRoot: root, now: NOW });

    expect(pruned).toEqual([]);
    for (const dir of [primary, prod, alpha, beta, shipIt]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("spares the launching instance's own cache even when stale", () => {
    const own = makeCacheDir("com.zeros.dev.bilbao-1a2b", OLD_SECONDS);

    const pruned = pruneStaleDevCaches({
      cachesRoot: root,
      currentSlug: "bilbao-1a2b",
      now: NOW,
    });

    expect(pruned).toEqual([]);
    expect(existsSync(own)).toBe(true);
  });

  it("treats recent child activity as liveness even if the top dir is old", () => {
    const dir = makeCacheDir("com.zeros.dev.busy-9f9f", OLD_SECONDS);
    const child = join(dir, "Cache_Data");
    utimesSync(child, FRESH_SECONDS, FRESH_SECONDS);
    utimesSync(dir, OLD_SECONDS, OLD_SECONDS);

    expect(pruneStaleDevCaches({ cachesRoot: root, now: NOW })).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("skips symlinks instead of following them", () => {
    const target = makeCacheDir("real-data", OLD_SECONDS);
    symlinkSync(target, join(root, "com.zeros.dev.sneaky-link"));

    const pruned = pruneStaleDevCaches({ cachesRoot: root, now: NOW });

    expect(pruned).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });

  it("returns empty and stays quiet for a missing caches root", () => {
    expect(
      pruneStaleDevCaches({ cachesRoot: join(root, "nope"), now: NOW }),
    ).toEqual([]);
  });

  it("handles plain files matching the prefix without deleting them", () => {
    const file = join(root, "com.zeros.dev.stray-file");
    writeFileSync(file, "not a dir");
    utimesSync(file, OLD_SECONDS, OLD_SECONDS);

    expect(pruneStaleDevCaches({ cachesRoot: root, now: NOW })).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});

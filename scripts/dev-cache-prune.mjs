// ──────────────────────────────────────────────────────────
// Stale per-worktree dev cache pruning (macOS)
// ──────────────────────────────────────────────────────────
//
// Every named dev instance gets its own Chromium cache at
// ~/Library/Caches/com.zeros.dev.<slug> — and nothing ever deleted them. Dead
// worktrees left ~200-300MB each behind forever: 30+ dirs / 8.9GB found
// 2026-08-04 with only two live worktrees, and the 2026-08-06 recurrence filled
// the disk far enough that the installed ALPHA app could no longer stage its
// auto-update (Squirrel's extraction died with ENOSPC on every 5-minute retry).
//
// Caches are regenerable by definition, so `pnpm electron:dev` reclaims any
// instance cache that hasn't been touched in STALE_DEV_CACHE_MS. Never touched:
// the primary `com.zeros.dev` dir (no trailing dot-segment — the everyday dev
// loop), the launching worktree's own cache, non-directories (symlinks are not
// followed), and anything outside the `com.zeros.dev.` prefix — the installed
// com.zeros / com.zeros.alpha / com.zeros.beta caches never match it.
//
// Lives in its own module (like ./dev-ports.mjs) because dev-instance.mjs
// spawns the dev stack at import time and can't be imported by a test.
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Instance caches untouched for this long belong to worktrees that are gone
 *  or dormant; either way the cache rebuilds on the next launch. */
export const STALE_DEV_CACHE_MS = 14 * 24 * 60 * 60 * 1000;

const DEV_CACHE_PREFIX = "com.zeros.dev.";

/** Newest mtime across the dir and its immediate children. Chromium doesn't
 *  reliably touch the top-level cache dir itself on every run, but each run
 *  churns entries directly under it. */
function lastActivityMs(dir) {
  let newest = fs.lstatSync(dir).mtimeMs;
  for (const child of fs.readdirSync(dir)) {
    try {
      newest = Math.max(newest, fs.lstatSync(path.join(dir, child)).mtimeMs);
    } catch {
      /* child vanished mid-scan — the dir is live; that mtime is counted above */
    }
  }
  return newest;
}

/**
 * Delete stale per-worktree dev instance caches. Returns the pruned dir names.
 * Never throws — cache hygiene must not be able to block a dev launch.
 *
 * @param {object} [options]
 * @param {string} [options.cachesRoot] override for tests (defaults to
 *   ~/Library/Caches; the function no-ops off darwin unless a root is given).
 * @param {string} [options.currentSlug] the launching instance's slug — its own
 *   cache is never a candidate, even if it looks stale.
 * @param {number} [options.staleMs] staleness threshold.
 * @param {number} [options.now] clock override for tests.
 */
export function pruneStaleDevCaches({
  cachesRoot,
  currentSlug = "",
  staleMs = STALE_DEV_CACHE_MS,
  now = Date.now(),
} = {}) {
  if (!cachesRoot) {
    if (process.platform !== "darwin") return [];
    cachesRoot = path.join(os.homedir(), "Library", "Caches");
  }
  const keep = currentSlug ? DEV_CACHE_PREFIX + currentSlug : "";
  const pruned = [];
  let entries;
  try {
    entries = fs.readdirSync(cachesRoot);
  } catch {
    return pruned;
  }
  for (const entry of entries) {
    if (!entry.startsWith(DEV_CACHE_PREFIX) || entry === keep) continue;
    const dir = path.join(cachesRoot, entry);
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
      if (now - lastActivityMs(dir) < staleMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      pruned.push(entry);
    } catch {
      /* permission/race — skip this dir, keep scanning */
    }
  }
  return pruned;
}

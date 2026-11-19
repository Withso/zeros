import path from "node:path";
import { REGENERABLE_SESSION_ENTRIES } from "./session-entries";
import { osCacheRoot, zerosDataDir, zerosEffectiveSessionDataDir } from "./paths";

/** What Zeros can rebuild on demand, for the storage report and its Clear
 * actions. Update staging is judged separately by
 * electron/updater-staging.ts (staleUpdaterStaging in updater.ts). */
export interface RegenerableLocation {
  id: "session-caches" | "engine-runtime" | "design-thumbnails";
  path: string;
  /** Only these top-level entries of `path` are regenerable. */
  entries?: readonly string[];
  /** How a clear must be done; the whole path is not always removable. */
  rule: "listed-entries" | "stale-entries-only" | "store-sweep";
}

export function regenerableLocations(cacheRoot: string = osCacheRoot()): RegenerableLocation[] {
  return [
    // Wherever the profile is this launch (moved or not); never while it runs.
    { id: "session-caches", path: zerosEffectiveSessionDataDir(cacheRoot), entries: REGENERABLE_SESSION_ENTRIES, rule: "listed-entries" },
    // pruneEngineRuntimeDirs: a live engine's manifest is how its host finds it.
    { id: "engine-runtime", path: path.join(zerosDataDir(), "engines"), rule: "stale-entries-only" },
    // sweepDesignThumbnails keeps pictures inside their byte budgets.
    { id: "design-thumbnails", path: path.join(zerosDataDir(), "design-storage"), rule: "store-sweep" },
  ];
}

/** Stores that are never pruned automatically, and why (docs/storage-layout.md). */
export const KEPT_LOCATIONS = [
  { id: "design-storage", reason: "Holds Design recovery journals, review receipts and retired drafts; its owner is recorded only as a hash of the workspace path." },
  { id: "git-promotion-journal", reason: "Written by a retired build; no current code reads it, and its records may describe unfinished work. Counted as other app data; never cleared." },
] as const;

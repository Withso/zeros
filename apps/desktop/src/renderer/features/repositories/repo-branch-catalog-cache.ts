// Last-confirmed repository Git dropdown snapshots.
//
// A branch catalog is exact-key server state. Persisting its small, validated
// metadata lets repository settings paint the real last-known branch/remote on
// a cold app open while the engine silently revalidates local refs + network.

import type { RepoBranchCatalog } from "@/renderer/platform/git";
import { getSetting, removeSetting, setSetting } from "@/renderer/platform/settings";

const STORAGE_KEY = "repo-branch-catalogs:v1";
const MAX_CATALOGS = 32;
const MAX_REMOTES = 64;
const MAX_BRANCHES = 2_000;
const MAX_STRING_CHARS = 8_192;
const MAX_SERIALIZED_CHARS = 750_000;

interface StoredCatalog {
  repoRoot: string;
  savedAt: number;
  catalog: RepoBranchCatalog;
}

interface StoredPayload {
  version: 1;
  entries: StoredCatalog[];
}

function validString(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_STRING_CHARS &&
    (allowEmpty || value.length > 0)
  );
}

function sanitizeCatalog(value: unknown): RepoBranchCatalog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.remotes) ||
    raw.remotes.length > MAX_REMOTES ||
    !Array.isArray(raw.branches) ||
    raw.branches.length > MAX_BRANCHES ||
    !validString(raw.effectiveRemote) ||
    typeof raw.remoteExists !== "boolean" ||
    typeof raw.baseExplicit !== "boolean" ||
    !validString(raw.effectiveBase) ||
    (raw.detectedDefault !== null && !validString(raw.detectedDefault)) ||
    (raw.listedRemote !== null && !validString(raw.listedRemote)) ||
    (raw.branchSource !== "remote" && raw.branchSource !== "local")
  ) {
    return null;
  }

  const remotes = raw.remotes.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const remote = value as Record<string, unknown>;
    if (
      !validString(remote.name) ||
      !validString(remote.url, true) ||
      typeof remote.isGitHub !== "boolean"
    ) {
      return null;
    }
    return {
      name: remote.name,
      url: remote.url,
      isGitHub: remote.isGitHub,
    };
  });
  if (remotes.some((remote) => remote === null)) return null;

  const branches = raw.branches.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const branch = value as Record<string, unknown>;
    if (
      !validString(branch.name) ||
      typeof branch.lastCommitDate !== "number" ||
      !Number.isFinite(branch.lastCommitDate)
    ) {
      return null;
    }
    return { name: branch.name, lastCommitDate: branch.lastCommitDate };
  });
  if (branches.some((branch) => branch === null)) return null;

  return {
    remotes: remotes as RepoBranchCatalog["remotes"],
    effectiveRemote: raw.effectiveRemote,
    remoteExists: raw.remoteExists,
    baseExplicit: raw.baseExplicit,
    effectiveBase: raw.effectiveBase,
    detectedDefault: raw.detectedDefault as string | null,
    listedRemote: raw.listedRemote as string | null,
    branchSource: raw.branchSource,
    branches: branches as RepoBranchCatalog["branches"],
  };
}

function loadCache(): Map<string, RepoBranchCatalog> {
  const raw = getSetting<unknown>(STORAGE_KEY, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
  const payload = raw as Record<string, unknown>;
  if (payload.version !== 1 || !Array.isArray(payload.entries))
    return new Map();

  const entries: StoredCatalog[] = [];
  for (const value of payload.entries.slice(-MAX_CATALOGS)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const catalog = sanitizeCatalog(entry.catalog);
    if (
      !validString(entry.repoRoot) ||
      typeof entry.savedAt !== "number" ||
      !Number.isFinite(entry.savedAt) ||
      !catalog
    ) {
      continue;
    }
    entries.push({ repoRoot: entry.repoRoot, savedAt: entry.savedAt, catalog });
  }
  entries.sort((left, right) => left.savedAt - right.savedAt);
  return new Map(entries.map(({ repoRoot, catalog }) => [repoRoot, catalog]));
}

let cache = loadCache();
let lastSavedAt = 0;

function persist(): void {
  if (cache.size === 0) {
    removeSetting(STORAGE_KEY);
    return;
  }
  let entries = Array.from(cache, ([repoRoot, catalog], index) => ({
    repoRoot,
    catalog,
    savedAt: lastSavedAt + index + 1,
  })).filter(
    (entry) => JSON.stringify(entry).length <= MAX_SERIALIZED_CHARS / 2,
  );
  let payload: StoredPayload = { version: 1, entries };
  while (
    entries.length > 0 &&
    JSON.stringify(payload).length > MAX_SERIALIZED_CHARS
  ) {
    entries = entries.slice(1);
    payload = { version: 1, entries };
  }
  if (entries.length === 0) {
    removeSetting(STORAGE_KEY);
    return;
  }
  lastSavedAt += entries.length;
  setSetting(STORAGE_KEY, payload);
}

export function readRepoBranchCatalog(
  repoRoot: string,
): RepoBranchCatalog | null {
  return cache.get(repoRoot) ?? null;
}

export function hasRepoBranchCatalog(repoRoot: string): boolean {
  return cache.has(repoRoot);
}

export function writeRepoBranchCatalog(
  repoRoot: string,
  catalog: RepoBranchCatalog,
): void {
  cache.delete(repoRoot);
  cache.set(repoRoot, catalog);
  while (cache.size > MAX_CATALOGS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  persist();
}

export function forgetRepoBranchCatalog(repoRoot: string): void {
  if (!cache.delete(repoRoot)) return;
  persist();
}

/** Test-only reset after replacing the localStorage-backed settings stub. */
export function resetRepoBranchCatalogCacheForTests(): void {
  cache = loadCache();
  lastSavedAt = 0;
}

export const repoBranchCatalogCacheLimit = MAX_CATALOGS;

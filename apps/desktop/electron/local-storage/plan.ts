import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_STORAGE_CATEGORY_IDS,
  type LocalStorageCategoryId,
} from "../../shared/local-storage";
import type { LocalStorageLocations } from "./locations";

/** Top-level Chromium profile entries that regenerate on their own. Anything
 * else, including an entry a future Chromium adds, counts as state. */
export const PROFILE_CACHE_ENTRIES: ReadonlySet<string> = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnWebGPUCache",
  "DawnGraphiteCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "Shared Dictionary",
  "Dictionaries",
  "VideoDecodeStats",
  "blob_storage",
]);

/** zeros.db, its SQLite sidecars and its pre-migration backups. */
const DATABASE_ENTRY = /^zeros\.db(?:-wal|-shm|-journal|\.pre-migration-v[0-9]+-[0-9TZ]+\.bak)?$/;

export interface CategoryPlan {
  /** Absolute, resolved, mutually disjoint paths du measures for this row. */
  paths: string[];
  /** A root feeding this row could not be resolved or listed: not measured. */
  unresolved: boolean;
  location: string | null;
  reveal: string | null;
}

export type LocalStoragePlan = Record<LocalStorageCategoryId, CategoryPlan>;

/** Count a root whole into one row, or classify each top-level entry; then
 * `feeds` lists every row it can reach, all unknown if the root is. */
type Source =
  | { root: string; classify: LocalStorageCategoryId }
  | { root: string; classify: (name: string) => LocalStorageCategoryId; feeds: LocalStorageCategoryId[] };

/** Only these mean "not there". Anything else (EACCES, EIO, …) is unknown,
 * and an unknown folder must never be measured as empty. */
function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function resolved(target: string): Promise<string | null | "unknown"> {
  try {
    return await realpath(target);
  } catch (error) {
    return isAbsent(error) ? null : "unknown";
  }
}

/** False only when the target is known to be absent. */
async function exists(target: string | null): Promise<boolean> {
  if (!target) return false;
  try {
    await lstat(target);
    return true;
  } catch (error) {
    return !isAbsent(error);
  }
}

function display(target: string, home: string): string {
  return target.startsWith(`${home}${path.sep}`) ? `~${target.slice(home.length)}` : target;
}

/**
 * Assign every byte this app keeps to exactly one category. Each location is
 * measured where it really is: when one root sits inside another (a new Local
 * profile's `electron/` session inside its data folder, provider accounts in
 * the data folder, Linux logs), the outer root steps around it, so nothing is
 * counted twice. Only the top level of a root and the folders leading to a
 * nested root are read; du does the walking.
 */
export async function planLocalStorage(locations: LocalStorageLocations): Promise<LocalStoragePlan> {
  const sources: Source[] = [
    {
      root: locations.sessionData,
      classify: (name) => (PROFILE_CACHE_ENTRIES.has(name) ? "cache" : "window-state"),
      feeds: ["cache", "window-state"],
    },
    ...(locations.logDir ? [{ root: locations.logDir, classify: "logs" as const }] : []),
    { root: locations.providerAccounts, classify: "provider-accounts" },
    ...locations.updates.map((root) => ({ root, classify: "updates" as const })),
    {
      root: locations.dataDir,
      classify: (name) =>
        DATABASE_ENTRY.test(name)
          ? "chats"
          : name === "provider-accounts"
            ? "provider-accounts"
            : "other-app-data",
      feeds: ["chats", "provider-accounts", "other-app-data"],
    },
    {
      root: locations.stateRoot,
      // The pre-relocation hidden worktree root holds checkouts, not settings.
      classify: (name) => (name === "worktrees" ? "workspaces" : "other-app-data"),
      feeds: ["workspaces", "other-app-data"],
    },
    { root: locations.workspaces, classify: () => "workspaces", feeds: ["workspaces"] },
    { root: locations.designWorkspaces, classify: () => "workspaces", feeds: ["workspaces"] },
    { root: locations.cloudSync, classify: () => "cloud-sync", feeds: ["cloud-sync"] },
  ];

  const unresolved = new Set<LocalStorageCategoryId>();
  const feeds = (source: Source) => (typeof source.classify === "string" ? [source.classify] : source.feeds);
  const roots: { source: Source; real: string }[] = [];
  for (const source of sources) {
    const real = await resolved(source.root);
    if (real === "unknown") for (const id of feeds(source)) unresolved.add(id);
    // The first claim on a physical folder wins; later aliases add nothing.
    else if (real && !roots.some((root) => root.real === real)) roots.push({ source, real });
  }
  const realRoots = roots.map((root) => root.real);
  const paths = Object.fromEntries(
    LOCAL_STORAGE_CATEGORY_IDS.map((id) => [id, [] as string[]]),
  ) as Record<LocalStorageCategoryId, string[]>;

  const collect = async (target: string, category: LocalStorageCategoryId, owner: string): Promise<void> => {
    if (realRoots.some((root) => root !== owner && root === target)) return;
    if (!realRoots.some((root) => root !== owner && root.startsWith(`${target}${path.sep}`))) {
      paths[category].push(target);
      return;
    }
    let names: string[];
    try {
      if (!(await lstat(target)).isDirectory()) throw new Error("not a directory");
      names = await readdir(target);
    } catch {
      paths[category].push(target);
      return;
    }
    for (const name of names) await collect(path.join(target, name), category, owner);
  };

  for (const { source, real } of roots) {
    const { classify } = source;
    if (typeof classify === "string") {
      await collect(real, classify, real);
      continue;
    }
    let names: string[];
    try {
      names = await readdir(real);
    } catch (error) {
      // Unlistable, its entries cannot be split between rows.
      if (!isAbsent(error)) for (const id of feeds(source)) unresolved.add(id);
      continue;
    }
    for (const name of names) await collect(path.join(real, name), classify(name), real);
  }

  const plan = {} as LocalStoragePlan;
  for (const id of LOCAL_STORAGE_CATEGORY_IDS) {
    plan[id] = {
      paths: unresolved.has(id) ? [] : [...new Set(paths[id])],
      unresolved: unresolved.has(id),
      location: id === "workspaces" || id === "cloud-sync" ? display(revealPaths(locations)[id]!, locations.home) : null,
      reveal: await revealTarget(locations, id),
    };
  }
  return plan;
}

function revealPaths(locations: LocalStorageLocations): Record<LocalStorageCategoryId, string | null> {
  return {
    workspaces: locations.workspaces,
    "cloud-sync": locations.cloudSync,
    chats: path.join(locations.dataDir, "zeros.db"),
    "provider-accounts": locations.providerAccounts,
    "window-state": locations.sessionData,
    "other-app-data": locations.dataDir,
    cache: null,
    logs: locations.logDir,
    updates: null,
  };
}

/** The one existing location Reveal may show for a row, or null. */
export async function revealTarget(
  locations: LocalStorageLocations,
  id: LocalStorageCategoryId,
): Promise<string | null> {
  const target = revealPaths(locations)[id];
  return (await exists(target)) ? target : null;
}

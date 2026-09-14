import * as fs from "node:fs/promises";
import path from "node:path";
import {
  compareWorkspaceEntries,
  normalizeWorkspacePathQuery,
  workspacePathScore,
  WorkspacePathIndex,
  type ScoredWorkspaceEntry,
  type WorkspaceEntry,
} from "@zeros/protocol/workspace-paths";

interface IndexSlot {
  revisions: Set<string>;
  generation: number;
  indexedGeneration: number;
  users: number;
  oversizedGeneration?: number;
  index?: WorkspacePathIndex;
  pending?: Promise<{ index: WorkspacePathIndex; generation: number }>;
  preview?: Promise<{ index: WorkspacePathIndex; generation: number }>;
}

const indexes = new Map<string, IndexSlot>();
const MAX_INDEXES = 4;
const MAX_INDEX_WEIGHT = 96 * 1024 * 1024;
class MentionIndexTooLarge extends Error {}

function pruneIndexes(): void {
  let weight = Array.from(indexes.values()).reduce(
    (total, slot) => total + (slot.index?.weight ?? 0),
    0,
  );
  for (const [cwd, slot] of indexes) {
    if (indexes.size <= MAX_INDEXES && weight <= MAX_INDEX_WEIGHT) break;
    if (slot.pending || slot.users > 0) continue;
    indexes.delete(cwd);
    weight -= slot.index?.weight ?? 0;
  }
}

async function loadIndex(
  cwd: string,
  slot: IndexSlot,
): Promise<WorkspacePathIndex> {
  if (slot.index && slot.indexedGeneration === slot.generation)
    return slot.index;
  if (slot.oversizedGeneration === slot.generation)
    throw new MentionIndexTooLarge();
  if (!slot.pending) {
    const generation = slot.generation;
    let previewReady = false;
    let resolvePreview!: (value: {
      index: WorkspacePathIndex;
      generation: number;
    }) => void;
    let rejectPreview!: (error: unknown) => void;
    slot.preview = new Promise((resolve, reject) => {
      resolvePreview = resolve;
      rejectPreview = reject;
    });
    void slot.preview.catch(() => {});
    slot.pending = (async () => {
      const entries: WorkspaceEntry[] = [];
      let fileCount = 0;
      let weight = 0;
      await walkMentionPaths(
        cwd,
        (entry) => {
          const full = entry.path.toLowerCase();
          const baseLength = full.length - full.lastIndexOf("/") - 1;
          // Bound construction as well as retention. An exceptionally large
          // tree falls back to bounded streaming ranking instead of allocating
          // an index that would immediately exceed the cache's memory budget.
          weight += 200 + full.length * 6 + baseLength * 4;
          if (weight > MAX_INDEX_WEIGHT) throw new MentionIndexTooLarge();
          entries.push(entry);
          if (entry.kind === "file") fileCount += 1;
        },
        () => {
          // A complete depth with 64 files already determines bare @'s entire
          // window. Publish it now while this SAME walk indexes deeper paths.
          if (!previewReady && fileCount >= 64) {
            const shallow = new WorkspacePathIndex(
              entries.filter((entry) => entry.kind === "file"),
            );
            resolvePreview({
              index: new WorkspacePathIndex(shallow.search("", 64)),
              generation,
            });
            previewReady = true;
          }
          return false;
        },
      );
      const index = new WorkspacePathIndex(entries);
      if (generation === slot.generation) {
        slot.index = index;
        slot.indexedGeneration = generation;
      }
      if (!previewReady) resolvePreview({ index, generation });
      return { index, generation };
    })()
      .catch((error: unknown) => {
        if (
          error instanceof MentionIndexTooLarge &&
          slot.generation === generation
        ) {
          slot.oversizedGeneration = generation;
          slot.index = undefined;
        }
        rejectPreview(error);
        throw error;
      })
      .finally(() => {
        slot.pending = undefined;
        slot.preview = undefined;
        pruneIndexes();
      });
  }
  const result = await slot.pending;
  // Changes during enumeration require one replacement walk. Concurrent
  // callers share both walks; intermediate generations never become current.
  return result.generation === slot.generation
    ? result.index
    : loadIndex(cwd, slot);
}

function getIndex(
  cwd: string,
  revision: string,
  preview: boolean,
): Promise<WorkspacePathIndex> {
  const key = path.resolve(cwd);
  const slot: IndexSlot = indexes.get(key) ?? {
    revisions: new Set<string>(),
    generation: 0,
    indexedGeneration: -1,
    users: 0,
  };
  indexes.delete(key);
  indexes.set(key, slot);
  if (!slot.revisions.has(revision)) {
    slot.revisions.add(revision);
    if (slot.revisions.size > 16)
      slot.revisions.delete(slot.revisions.values().next().value!);
    slot.generation += 1;
  }
  // Remember several renderer revisions so two windows don't invalidate each
  // other's index merely by sending another query with their unchanged token.
  slot.users += 1;
  const result = loadIndex(key, slot).finally(() => {
    slot.users -= 1;
    pruneIndexes();
  });
  pruneIndexes();
  if (preview && slot.preview) {
    void result.catch(() => {});
    return slot.preview.then((value) =>
      value.generation === slot.generation ? value.index : loadIndex(key, slot),
    );
  }
  return result;
}

/** Search the actual filesystem, including ignored paths, dotfiles and empty
 * directories. Filter/rank BEFORE capping: an attachment must remain findable
 * even when dependencies alone exceed the ordinary file tree's 20k limit.
 * A renderer revision shares the complete name index across typed queries;
 * callers without one retain fresh, uncached listing semantics. */
export async function listMentionPaths(
  cwd: string,
  query: string,
  limit: number,
  revision?: string,
): Promise<string[]> {
  const cap = Math.min(20_000, Math.max(0, Math.floor(limit)));
  if (!cwd || !Number.isFinite(cap) || cap === 0) return [];
  if (revision && revision.length <= 128) {
    try {
      const index = await getIndex(
        cwd,
        revision,
        !normalizeWorkspacePathQuery(query) && cap <= 64,
      );
      return index.search(query, cap).map(toWirePath);
    } catch (error) {
      if (!(error instanceof MentionIndexTooLarge)) throw error;
      // Never truncate the searchable set to fit an index budget.
    }
  }
  const q = normalizeWorkspacePathQuery(query);
  let best: ScoredWorkspaceEntry[] = [];
  const compact = () => {
    best.sort(compareWorkspaceEntries);
    best = best.slice(0, cap);
  };
  await walkMentionPaths(
    cwd,
    (entry) => {
      const score = workspacePathScore(q, entry);
      if (score === null) return;
      best.push({ entry, score });
      if (best.length >= cap * 2) compact();
    },
    () => {
      compact();
      return !q && best.length === cap && best[cap - 1].entry.kind === "file";
    },
  );
  compact();
  return best.map(({ entry }) => toWirePath(entry));
}

function toWirePath(entry: WorkspaceEntry): string {
  return `${entry.path}${entry.kind === "folder" ? "/" : ""}`;
}

async function walkMentionPaths(
  cwd: string,
  visit: (entry: WorkspaceEntry) => void,
  finishedDepth?: () => boolean,
): Promise<void> {
  const root = await fs.realpath(cwd);
  let dirs = [""];
  const visited = new Set<string>();
  const read = async (relative: string) => {
    // Re-check queued directories too: an agent can replace one with a symlink
    // between discovery and enumeration. Never walk outside the workspace.
    let real: string;
    let entries: import("node:fs").Dirent[];
    try {
      real = await fs.realpath(path.join(root, relative));
      const inside = path.relative(root, real);
      if (
        inside === ".." ||
        inside.startsWith(`..${path.sep}`) ||
        path.isAbsolute(inside)
      )
        return;
      if (visited.has(real)) return;
      visited.add(real);
      entries = await fs.readdir(real, { withFileTypes: true });
    } catch (error) {
      if (!relative) throw error; // a failed root read is not an empty workspace
      return; // unreadable or vanished descendant; continue with its siblings
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      let folder = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          folder = (await fs.stat(path.join(real, entry.name))).isDirectory();
        } catch {
          // Broken links remain selectable, as in the ordinary file tree.
        }
      }
      if (entry.isDirectory()) dirs.push(rel);
      // Symlinks are listed, never traversed (cycles and outside-root aliases).
      if (!folder && !entry.isFile() && !entry.isSymbolicLink()) continue;
      visit({
        path: rel,
        kind: folder ? "folder" : "file",
      });
    }
  };
  // Bounded parallel directory reads; no recursive promise fan-out on a large
  // dependency tree, and no per-file stat except to classify symlinks.
  while (dirs.length) {
    const level = dirs;
    dirs = [];
    for (let i = 0; i < level.length; i += 16)
      await Promise.all(level.slice(i, i + 16).map(read));
    if (finishedDepth?.()) break;
  }
}

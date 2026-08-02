// ──────────────────────────────────────────────────────────
// context-graph — the workspace's shareable context folder
// ──────────────────────────────────────────────────────────
//
// Every workspace gets a `.context-graph/` directory (scaffolded at worktree
// creation and lazily on first use). Unlike `.context/` — which is wholly
// gitignored agent scratch — the graph is SPLIT by intent:
//
//   .context-graph/
//     .gitignore          ignores `local/` AND itself (zero `git status` noise
//                         until the user deliberately shares something)
//     local/attachments/  private: composer attachments land here by default
//       <attachmentId>/<file>       one folder per attachment, one file inside
//     shared/attachments/ committed: items the user opted into sharing from
//       <attachmentId>/<file>       the Context tab (checkbox = "not ignored")
//
// Docs (any non-attachment file a user or agent drops under local/ or shared/)
// ride the same split. The Context tab canvas renders both scopes merged —
// the local/shared distinction is surfaced ONLY as the per-attachment share
// checkbox, not as a visual grouping.
//
// This module is the ONE implementation, shared by the engine bridge ops
// (context.graph.*) and the electron attachment-write IPC — mirroring how
// read-file.ts serves both transports. List never throws; mutations return
// structured results. All paths are lexically confined + realpath-checked so
// a hostile id or a symlinked graph directory cannot escape the workspace.
// ──────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";

export const CONTEXT_GRAPH_DIR = ".context-graph";
export const CONTEXT_GRAPH_LOCAL = "local";
export const CONTEXT_GRAPH_SHARED = "shared";
const ATTACHMENTS_DIR = "attachments";

/** `local/` never leaves this machine; `/.gitignore` keeps the scaffold itself
 *  out of `git status` (each teammate's Zeros re-creates it locally), so the
 *  ONLY graph paths git ever reports are files deliberately shared. */
const GITIGNORE_BODY = [
  "# Zeros context graph — `local/` stays on this machine; `shared/` is",
  "# committed so teammates can see it. Toggle items from the Context tab.",
  "/.gitignore",
  `/${CONTEXT_GRAPH_LOCAL}/`,
  "",
].join("\n");

/** Same id alphabet the composer generates and the attachment IPC enforces. */
const ID_OK = /^[a-zA-Z0-9_-]{1,128}$/;

// Listing bounds. The canvas is a bounded surface, not a file manager: cap the
// walk so a graph someone filled with a node_modules-scale tree cannot wedge
// the engine or flood the wire.
const MAX_ITEMS = 400;
const MAX_DIR_ENTRIES = 2_000;
const MAX_DEPTH = 6;
const PREVIEW_READ_BYTES = 16 * 1024;
const PREVIEW_CHARS = 480;

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".avif",
  ".svg",
]);
const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);

export type ContextGraphScope = "local" | "shared";
export type ContextGraphCategory = "attachment" | "doc";
export type ContextGraphKind = "image" | "markdown" | "text" | "other";

export interface ContextGraphItem {
  /** Workspace-relative POSIX path (starts with `.context-graph/`). */
  relPath: string;
  /** File basename, shown as the card title. */
  name: string;
  scope: ContextGraphScope;
  category: ContextGraphCategory;
  kind: ContextGraphKind;
  bytes: number;
  mtimeMs: number;
  /** The `<attachmentId>` folder for attachment items — the share toggle's key. */
  attachmentId?: string;
  /** First ~480 chars for text/markdown cards, so the canvas renders previews
   *  without one read round-trip per card. */
  previewText?: string;
}

export interface ContextGraphListResult {
  /** False when `.context-graph/` does not exist yet (canvas empty state). */
  exists: boolean;
  items: ContextGraphItem[];
  /** True when the walk hit a bound and the canvas is showing a subset. */
  truncated: boolean;
}

export interface ContextGraphScaffoldResult {
  ok: boolean;
  /** True when this call created anything (drives DB_CHANGED suppression for
   *  the common already-scaffolded case). */
  created: boolean;
  error?: string;
}

export interface ContextGraphSetSharedResult {
  ok: boolean;
  /** False when the attachment was already in the requested scope. */
  moved: boolean;
  error?: string;
}

function graphRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, CONTEXT_GRAPH_DIR);
}

/** A symlinked `.context-graph` (or scope dir) must not let graph operations
 *  read or move files outside the workspace. Best-effort realpath containment:
 *  a not-yet-existing path passes (its parent is checked by creation calls). */
async function isConfined(target: string, root: string): Promise<boolean> {
  const rootReal = await fs.realpath(root).catch(() => null);
  if (!rootReal) return false;
  let probe = target;
  // Walk up to the nearest existing ancestor so mkdir targets are checkable.
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      return real === rootReal || real.startsWith(rootReal + path.sep);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

/** Create the graph skeleton (both scopes + their attachments dirs + the
 *  self-ignoring .gitignore). Idempotent and quiet: repeated calls report
 *  `created: false` so callers can skip change broadcasts. */
export async function ensureContextGraph(
  workspaceRoot: string,
): Promise<ContextGraphScaffoldResult> {
  const root = graphRoot(workspaceRoot);
  try {
    if (!(await isConfined(root, workspaceRoot))) {
      return { ok: false, created: false, error: "graph escapes workspace" };
    }
    const existing = await fs.lstat(root).catch(() => null);
    if (existing && !existing.isDirectory()) {
      return {
        ok: false,
        created: false,
        error: `${CONTEXT_GRAPH_DIR} exists but is not a directory`,
      };
    }
    let created = false;
    for (const scope of [CONTEXT_GRAPH_LOCAL, CONTEXT_GRAPH_SHARED]) {
      const dir = path.join(root, scope, ATTACHMENTS_DIR);
      const before = await fs.access(dir).then(
        () => true,
        () => false,
      );
      if (!before) {
        await fs.mkdir(dir, { recursive: true });
        created = true;
      }
    }
    const ignorePath = path.join(root, ".gitignore");
    const haveIgnore = await fs.access(ignorePath).then(
      () => true,
      () => false,
    );
    if (!haveIgnore) {
      await fs.writeFile(ignorePath, GITIGNORE_BODY);
      created = true;
    }
    return { ok: true, created };
  } catch (err) {
    return {
      ok: false,
      created: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function kindForName(name: string): ContextGraphKind {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (ext === ".txt" || ext === ".log") return "text";
  return "other";
}

/** First PREVIEW_CHARS of a text-like file, reading at most one small chunk.
 *  Control characters (a mis-labelled binary) degrade to no preview. */
async function readPreview(absPath: string): Promise<string | undefined> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(absPath, "r");
    const buf = Buffer.alloc(PREVIEW_READ_BYTES);
    const { bytesRead } = await handle.read(buf, 0, PREVIEW_READ_BYTES, 0);
    if (bytesRead === 0) return undefined;
    const text = buf.subarray(0, bytesRead).toString("utf8");
    if (text.includes("\u0000")) return undefined;
    const trimmed = text.slice(0, PREVIEW_CHARS).trimEnd();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface WalkState {
  items: ContextGraphItem[];
  truncated: boolean;
}

async function collectFile(
  state: WalkState,
  absPath: string,
  relPath: string,
  scope: ContextGraphScope,
  category: ContextGraphCategory,
  attachmentId?: string,
): Promise<void> {
  if (state.items.length >= MAX_ITEMS) {
    state.truncated = true;
    return;
  }
  const stat = await fs.lstat(absPath).catch(() => null);
  if (!stat || !stat.isFile()) return;
  const name = path.basename(relPath);
  if (name === ".gitignore" || name === ".DS_Store") return;
  const kind = kindForName(name);
  const item: ContextGraphItem = {
    relPath,
    name,
    scope,
    category,
    kind,
    bytes: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    ...(attachmentId ? { attachmentId } : {}),
  };
  if (kind === "markdown" || kind === "text") {
    const preview = await readPreview(absPath);
    if (preview) item.previewText = preview;
  }
  state.items.push(item);
}

async function readDirBounded(absDir: string) {
  const entries = await fs
    .readdir(absDir, { withFileTypes: true })
    .catch(() => []);
  return entries.slice(0, MAX_DIR_ENTRIES);
}

/** Walk one scope subtree. Attachments (one folder per attachment under
 *  `attachments/`) are collected with their folder id; everything else in the
 *  scope is a "doc". Deterministic order: readdir order per level, bounded. */
async function walkScope(
  state: WalkState,
  workspaceRoot: string,
  scope: ContextGraphScope,
): Promise<void> {
  const scopeAbs = path.join(graphRoot(workspaceRoot), scope);
  const scopeRel = `${CONTEXT_GRAPH_DIR}/${scope}`;

  // Attachments: exactly one level of id folders, files directly inside.
  const attachmentsAbs = path.join(scopeAbs, ATTACHMENTS_DIR);
  for (const idEntry of await readDirBounded(attachmentsAbs)) {
    if (!idEntry.isDirectory() || !ID_OK.test(idEntry.name)) continue;
    const idAbs = path.join(attachmentsAbs, idEntry.name);
    for (const fileEntry of await readDirBounded(idAbs)) {
      if (!fileEntry.isFile()) continue;
      await collectFile(
        state,
        path.join(idAbs, fileEntry.name),
        `${scopeRel}/${ATTACHMENTS_DIR}/${idEntry.name}/${fileEntry.name}`,
        scope,
        "attachment",
        idEntry.name,
      );
    }
  }

  // Docs: everything else under the scope, attachments subtree excluded.
  const walkDocs = async (
    absDir: string,
    relDir: string,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_DEPTH) {
      state.truncated = true;
      return;
    }
    for (const entry of await readDirBounded(absDir)) {
      if (state.items.length >= MAX_ITEMS) {
        state.truncated = true;
        return;
      }
      if (entry.name === ATTACHMENTS_DIR && depth === 0) continue;
      const abs = path.join(absDir, entry.name);
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walkDocs(abs, rel, depth + 1);
      } else if (entry.isFile()) {
        await collectFile(state, abs, rel, scope, "doc");
      }
    }
  };
  await walkDocs(scopeAbs, scopeRel, 0);
}

/** Everything in the workspace's context graph, both scopes merged. Sorted
 *  oldest-first by mtime (ties by path) so the canvas layout is stable: new
 *  items take the next free slot instead of reshuffling every card. */
export async function listContextGraph(
  workspaceRoot: string,
): Promise<ContextGraphListResult> {
  const root = graphRoot(workspaceRoot);
  try {
    if (!(await isConfined(root, workspaceRoot))) {
      return { exists: false, items: [], truncated: false };
    }
    const stat = await fs.lstat(root).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      return { exists: false, items: [], truncated: false };
    }
    const state: WalkState = { items: [], truncated: false };
    await walkScope(state, workspaceRoot, CONTEXT_GRAPH_LOCAL);
    await walkScope(state, workspaceRoot, CONTEXT_GRAPH_SHARED);
    state.items.sort(
      (a, b) => a.mtimeMs - b.mtimeMs || (a.relPath < b.relPath ? -1 : 1),
    );
    return { exists: true, items: state.items, truncated: state.truncated };
  } catch {
    return { exists: false, items: [], truncated: false };
  }
}

/** Move one attachment folder between `local/` and `shared/` — the Context
 *  tab's share checkbox. Idempotent: already-there reports `moved: false`. */
export async function setContextGraphAttachmentShared(
  workspaceRoot: string,
  attachmentId: string,
  shared: boolean,
): Promise<ContextGraphSetSharedResult> {
  if (!ID_OK.test(attachmentId)) {
    return { ok: false, moved: false, error: "invalid attachment id" };
  }
  const root = graphRoot(workspaceRoot);
  const fromScope = shared ? CONTEXT_GRAPH_LOCAL : CONTEXT_GRAPH_SHARED;
  const toScope = shared ? CONTEXT_GRAPH_SHARED : CONTEXT_GRAPH_LOCAL;
  const source = path.join(root, fromScope, ATTACHMENTS_DIR, attachmentId);
  const target = path.join(root, toScope, ATTACHMENTS_DIR, attachmentId);
  try {
    if (
      !(await isConfined(source, workspaceRoot)) ||
      !(await isConfined(target, workspaceRoot))
    ) {
      return { ok: false, moved: false, error: "path escapes workspace" };
    }
    const sourceStat = await fs.lstat(source).catch(() => null);
    const targetStat = await fs.lstat(target).catch(() => null);
    if (targetStat) {
      // Already in the requested scope. A source ALSO existing means two
      // divergent copies — refuse rather than clobber either.
      if (sourceStat) {
        return {
          ok: false,
          moved: false,
          error: "attachment exists in both scopes — resolve on disk",
        };
      }
      return { ok: true, moved: false };
    }
    if (!sourceStat || !sourceStat.isDirectory()) {
      return { ok: false, moved: false, error: "attachment not found" };
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
    return { ok: true, moved: true };
  } catch (err) {
    return {
      ok: false,
      moved: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** True when the graph holds anything worth preserving (any file beyond its
 *  own scaffolding). Gates the archive force-add so an empty skeleton doesn't
 *  make a clean-tree archive stricter than it is today. */
export async function contextGraphHasContent(
  workspaceRoot: string,
): Promise<boolean> {
  const { items } = await listContextGraph(workspaceRoot);
  return items.length > 0;
}

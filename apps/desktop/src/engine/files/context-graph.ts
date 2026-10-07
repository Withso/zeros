// ──────────────────────────────────────────────────────────
// context-graph — the workspace's `.context/` folder
// ──────────────────────────────────────────────────────────
//
// Context writes create `.context/` when needed. Workspace creation and reads
// leave the repository untouched, and Zeros writes no ignore rules: whether
// `.context/` is committed is the repository's own choice.
// `.context-graph/` migrates without overwriting files.
//
//   .context/
//     attachments/<attachmentId>/<file>   composer attachments, one folder each
//     <task>/…                            agents' working files ("docs")
//     local/, shared/                     scopes written by earlier builds:
//                                         listed, archived, never created
//
// Owner-only and dot-prefixed top-level entries are private tool state. They
// are neither listed nor swept into archive snapshots.
//
// This module is the ONE implementation, shared by the engine bridge ops
// (context.graph.*) and the electron attachment-write IPC — mirroring how
// read-file.ts serves both transports. List never throws; mutations return
// structured results. All paths are lexically confined + realpath-checked so
// a hostile id or a symlinked graph directory cannot escape the workspace.
// ──────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import { constants as fsConstants, type Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { currentCloudFilePolicy } from "./cloud-file-policy";
import { publishCloudWorkspacePath } from "./cloud-workspace-ownership";
import { createAttachmentTemporaryDirectory } from "./attachment-temporary-directory";
import { cloudWorkspacePublicationPath } from "../agents/containment/cloud-workspace-paths";
import { cleanupLegacyAttachmentStaging } from "./attachment-legacy-staging";
import {
  assertContextDirectory,
  CONTEXT_DIR,
  LEGACY_CONTEXT_DIR,
  migrateLegacyContextDirectory,
} from "./context-directory";
import {
  CONTEXT_MIGRATION_STATE,
  contextMigrationArchivePaths,
} from "./context-migration-state";

export const CONTEXT_GRAPH_DIR = CONTEXT_DIR;
/** Scopes written by earlier builds. Existing records stay where they are. */
export const CONTEXT_GRAPH_LOCAL = "local";
export const CONTEXT_GRAPH_SHARED = "shared";
const ATTACHMENTS_DIR = "attachments";
const RESERVED_ROOT_ENTRIES = new Set([
  ATTACHMENTS_DIR,
  CONTEXT_GRAPH_LOCAL,
  CONTEXT_GRAPH_SHARED,
]);

/** Same id alphabet the composer generates and the attachment IPC enforces. */
const ID_OK = /^[a-zA-Z0-9_-]{1,128}$/;
/** Legacy single-call base64 ceiling. New 500 MB imports use the chunked
 * transfer path; never raise this limit to fit a whole file in one frame.
 * Check the encoded ceiling before allocating a Buffer. */
export const MAX_CONTEXT_GRAPH_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT_GRAPH_ATTACHMENT_BASE64_CHARS =
  Math.ceil(MAX_CONTEXT_GRAPH_ATTACHMENT_BYTES / 3) * 4;

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

/** Wire compatibility: everything Zeros writes now reports `local`; `shared`
 *  marks only records an earlier build's share action moved. */
export type ContextGraphScope = "local" | "shared";
export type ContextGraphCategory = "attachment" | "doc";
export type ContextGraphKind = "image" | "markdown" | "text" | "other";

export interface ContextGraphItem {
  /** Workspace-relative POSIX path (starts with `.context/` or legacy `.context-graph/`). */
  relPath: string;
  /** File basename, shown as the card title. */
  name: string;
  scope: ContextGraphScope;
  category: ContextGraphCategory;
  kind: ContextGraphKind;
  bytes: number;
  mtimeMs: number;
  /** Metadata-change time makes thumbnail revisions exact across rapid,
   *  same-size atomic replacements. Additive for older renderer clients. */
  ctimeMs: number;
  /** The `<attachmentId>` folder for attachment items. */
  attachmentId?: string;
  /** First ~480 chars for text/markdown cards, so the canvas renders previews
   *  without one read round-trip per card. */
  previewText?: string;
}

export interface ContextGraphListResult {
  /** False when neither context directory exists yet (canvas empty state). */
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

function graphRoot(
  workspaceRoot: string,
  directory = CONTEXT_GRAPH_DIR,
): string {
  return path.join(workspaceRoot, directory);
}

/** A symlinked context directory (or scope dir) must not let graph operations
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

/** Create `.context/attachments/`. Idempotent and quiet: repeated calls report
 *  `created: false` so callers can skip change broadcasts. */
const scaffolds = new Map<string, Promise<ContextGraphScaffoldResult>>();

export function ensureContextGraph(
  workspaceRoot: string,
): Promise<ContextGraphScaffoldResult> {
  // Do not borrow another actor's in-flight scaffold: its authority can expire
  // independently. Exclusive filesystem creation still makes this idempotent.
  if (currentCloudFilePolicy()) return scaffoldContextGraph(path.resolve(workspaceRoot));
  const key = path.resolve(workspaceRoot);
  const pending = scaffolds.get(key);
  if (pending) return pending;
  const request = scaffoldContextGraph(key).finally(() => {
    if (scaffolds.get(key) === request) scaffolds.delete(key);
  });
  scaffolds.set(key, request);
  return request;
}

async function scaffoldContextGraph(
  workspaceRoot: string,
): Promise<ContextGraphScaffoldResult> {
  const root = graphRoot(workspaceRoot);
  const policy = currentCloudFilePolicy();
  try {
    currentCloudFilePolicy()?.assertAuthorized(true);
    await assertContextDirectory(root, workspaceRoot);
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
    const dir = path.join(root, ATTACHMENTS_DIR);
    await assertContextDirectory(dir, workspaceRoot);
    if (!(await isConfined(dir, workspaceRoot))) {
      return { ok: false, created, error: "graph escapes workspace" };
    }
    if (policy) created = policy.createDirectory(path.relative(workspaceRoot, dir));
    else created = (await fs.mkdir(dir, { recursive: true })) !== undefined;
    publishCloudWorkspacePath(dir);
    if (!(await isConfined(dir, workspaceRoot))) {
      return { ok: false, created, error: "graph escapes workspace" };
    }
    const migration = await migrateLegacyContextDirectory(workspaceRoot);
    created ||= migration;
    await cleanupLegacyAttachmentStaging(root);
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
    const policy = currentCloudFilePolicy();
    if (policy) policy.assertPath(path.relative(policy.root, absPath));
    handle = await fs.open(absPath, policy ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK : "r");
    policy?.assertDescriptor(handle.fd, absPath);
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
  if (currentCloudFilePolicy() && !currentCloudFilePolicy()!.allows(relPath)) return;
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
    ctimeMs: Math.round(stat.ctimeMs),
    ...(attachmentId ? { attachmentId } : {}),
  };
  if (kind === "markdown" || kind === "text") {
    const preview = await readPreview(absPath);
    if (preview) item.previewText = preview;
  }
  state.items.push(item);
}

async function readDirBounded(absDir: string, limit = MAX_DIR_ENTRIES) {
  const policy = currentCloudFilePolicy();
  if (policy && !policy.allows(path.relative(policy.root, absDir))) return [];
  const entries = await fs
    .readdir(absDir, { withFileTypes: true })
    .catch(() => []);
  return entries.slice(0, limit).filter(entry => !policy || policy.allows(path.relative(policy.root, path.join(absDir, entry.name))));
}

/** Collect one level of id folders under `attachmentsAbs`, files directly inside. */
async function walkAttachments(
  state: WalkState,
  workspaceRoot: string,
  attachmentsAbs: string,
  attachmentsRel: string,
  scope: ContextGraphScope,
): Promise<void> {
  try {
    await assertContextDirectory(attachmentsAbs, workspaceRoot);
  } catch {
    return;
  }
  for (const idEntry of await readDirBounded(attachmentsAbs)) {
    if (!idEntry.isDirectory() || !ID_OK.test(idEntry.name)) continue;
    const idAbs = path.join(attachmentsAbs, idEntry.name);
    for (const fileEntry of await readDirBounded(idAbs)) {
      if (!fileEntry.isFile()) continue;
      await collectFile(
        state,
        path.join(idAbs, fileEntry.name),
        `${attachmentsRel}/${idEntry.name}/${fileEntry.name}`,
        scope,
        "attachment",
        idEntry.name,
      );
    }
  }
}

/** Collect every file below `absDir` as a doc. `skip` applies to the first
 *  level only. Deterministic order: readdir order per level, bounded. */
async function walkDocs(
  state: WalkState,
  absDir: string,
  relDir: string,
  scope: ContextGraphScope,
  depth: number,
  skip: (name: string) => boolean = () => false,
): Promise<void> {
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    return;
  }
  for (const entry of await readDirBounded(absDir)) {
    if (skip(entry.name)) continue;
    if (state.items.length >= MAX_ITEMS) {
      state.truncated = true;
      return;
    }
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkDocs(state, abs, rel, scope, depth + 1);
    } else if (entry.isFile()) {
      await collectFile(state, abs, rel, scope, "doc");
    }
  }
}

/** First-level names an earlier build's scope reserves for its own records. */
function scopeReservedEntry(
  directory: string,
  scope: ContextGraphScope,
): (name: string) => boolean {
  return (name) =>
    name === ATTACHMENTS_DIR ||
    (directory === CONTEXT_GRAPH_DIR &&
      scope === CONTEXT_GRAPH_LOCAL &&
      name === CONTEXT_MIGRATION_STATE);
}

/** Walk one scope written by an earlier build. Attachments are collected with
 *  their folder id; everything else in the scope is a "doc". */
async function walkScope(
  state: WalkState,
  workspaceRoot: string,
  scope: ContextGraphScope,
  directory = CONTEXT_GRAPH_DIR,
): Promise<void> {
  const scopeAbs = path.join(graphRoot(workspaceRoot, directory), scope);
  const scopeRel = `${directory}/${scope}`;
  try {
    await assertContextDirectory(scopeAbs, workspaceRoot);
  } catch {
    return;
  }
  await walkAttachments(
    state,
    workspaceRoot,
    path.join(scopeAbs, ATTACHMENTS_DIR),
    `${scopeRel}/${ATTACHMENTS_DIR}`,
    scope,
  );
  await walkDocs(
    state,
    scopeAbs,
    scopeRel,
    scope,
    0,
    scopeReservedEntry(directory, scope),
  );
}

interface ContextEntry {
  name: string;
  directory: boolean;
}

/** Top-level `.context/` entries holding agents' working files. Dot-prefixed
 *  and owner-only entries are private tool state (device bindings,
 *  credentials); symlinks are never followed. */
async function workspaceContextEntries(
  workspaceRoot: string,
  limit = MAX_DIR_ENTRIES,
): Promise<ContextEntry[]> {
  const root = graphRoot(workspaceRoot);
  const entries: ContextEntry[] = [];
  for (const entry of await readDirBounded(root, limit)) {
    if (entry.name.startsWith(".") || RESERVED_ROOT_ENTRIES.has(entry.name))
      continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const stat = await fs.lstat(path.join(root, entry.name)).catch(() => null);
    if (!stat || (stat.mode & 0o077) === 0) continue;
    entries.push({ name: entry.name, directory: entry.isDirectory() });
  }
  return entries;
}

/** Everything in the workspace's `.context/`. Sorted oldest-first by mtime
 *  (ties by path) so the listing is stable: new items take the next free slot
 *  instead of reshuffling. */
export async function listContextGraph(
  workspaceRoot: string,
): Promise<ContextGraphListResult> {
  try {
    const state: WalkState = { items: [], truncated: false };
    let exists = false;
    // Read-only compatibility also keeps unmigrated/conflicting legacy files
    // visible. Scaffold and mutations own migration, never this read path.
    for (const directory of [CONTEXT_GRAPH_DIR, LEGACY_CONTEXT_DIR]) {
      const root = graphRoot(workspaceRoot, directory);
      const stat = await fs.lstat(root).catch(() => null);
      if (!stat?.isDirectory() || !(await isConfined(root, workspaceRoot)))
        continue;
      exists = true;
      if (directory === CONTEXT_GRAPH_DIR) {
        await walkAttachments(
          state,
          workspaceRoot,
          path.join(root, ATTACHMENTS_DIR),
          `${directory}/${ATTACHMENTS_DIR}`,
          CONTEXT_GRAPH_LOCAL,
        );
        for (const entry of await workspaceContextEntries(workspaceRoot)) {
          const abs = path.join(root, entry.name);
          const rel = `${directory}/${entry.name}`;
          if (entry.directory)
            await walkDocs(state, abs, rel, CONTEXT_GRAPH_LOCAL, 1);
          else await collectFile(state, abs, rel, CONTEXT_GRAPH_LOCAL, "doc");
        }
      }
      await walkScope(state, workspaceRoot, CONTEXT_GRAPH_LOCAL, directory);
      await walkScope(state, workspaceRoot, CONTEXT_GRAPH_SHARED, directory);
    }
    state.items.sort(
      (a, b) => a.mtimeMs - b.mtimeMs || (a.relPath < b.relPath ? -1 : 1),
    );
    return { exists, items: state.items, truncated: state.truncated };
  } catch {
    return { exists: false, items: [], truncated: false };
  }
}

export interface ContextGraphStageResult {
  ok: boolean;
  absolutePath?: string;
  relativePath?: string;
  bytes?: number;
  /** True when the target already held these bytes and nothing was written —
   *  keeps the card's mtime (and so its canvas slot) stable across the
   *  attach-time write and the send-time safety-net re-write. */
  skipped?: boolean;
  error?: string;
}

/** Read and compare through one no-follow handle. A stable inode check keeps a
 * concurrent replacement from being mistaken for the bytes we inspected. */
type AttachmentContents = Buffer | { file: fs.FileHandle; length: number; verify?: () => Promise<void> };

async function readAttachmentChunk(contents: AttachmentContents, offset: number): Promise<Buffer> {
  const length = Math.min(1024 * 1024, contents.length - offset);
  if (Buffer.isBuffer(contents)) return contents.subarray(offset, offset + length);
  const bytes = Buffer.allocUnsafe(length);
  let received = 0;
  while (received < length) {
    const read = await contents.file.read(bytes, received, length - received, offset + received);
    if (read.bytesRead === 0) throw new Error("incomplete attachment upload");
    received += read.bytesRead;
  }
  return bytes;
}

async function existingFileMatches(
  filePath: string,
  expected: AttachmentContents,
): Promise<boolean> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size !== expected.length)
      return false;
    for (let offset = 0; offset < expected.length;) {
      const chunk = await readAttachmentChunk(expected, offset);
      const actual = Buffer.allocUnsafe(chunk.length);
      const read = await handle.read(actual, 0, actual.length, offset);
      if (read.bytesRead !== actual.length || !actual.equals(chunk)) return false;
      offset += chunk.length;
    }
    const currentStat = await fs.lstat(filePath).catch(() => null);
    return (
      currentStat?.isFile() === true &&
      currentStat.dev === openedStat.dev &&
      currentStat.ino === openedStat.ino
    );
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Stage outside the public graph scopes and rename into place. Rename replaces a
 * symlink entry itself instead of following it, eliminating the lstat/write
 * race at the predictable attachment filename. */
async function atomicWriteAttachment(
  filePath: string,
  contents: AttachmentContents,
  workspaceRoot: string,
): Promise<void> {
  // The template's logical workspace is a separate bind mount. Keep the
  // already-authorized destination on the same shared mount as staging.
  const publicationPath = cloudWorkspacePublicationPath(filePath);
  const temporary = await createAttachmentTemporaryDirectory(workspaceRoot);
  const temporaryPath = path.join(
    temporary.path,
    `.${path.basename(filePath)}.${randomUUID()}.staging`,
  );
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    for (let offset = 0; offset < contents.length;) {
      const chunk = await readAttachmentChunk(contents, offset);
      await handle.writeFile(chunk);
      offset += chunk.length;
    }
    if (!Buffer.isBuffer(contents)) await contents.verify?.();
    try {
      await fs.rename(temporaryPath, publicationPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        code !== "EISDIR" &&
        code !== "ENOTDIR" &&
        code !== "ENOTEMPTY" &&
        code !== "EPERM"
      ) {
        throw err;
      }
      // The destination is a directory-shaped squatter. Remove the entry and
      // retry the rename; rename itself still replaces any file/symlink planted
      // in the gap rather than following it.
      await fs.rm(publicationPath, { recursive: true, force: true });
      await fs.rename(temporaryPath, publicationPath);
    }
    publishCloudWorkspacePath(publicationPath, handle.fd);
  } finally {
    await handle?.close().catch(() => {});
    await temporary.dispose().catch(() => {});
  }
}

/** Strip directory parts, replace shell-hostile characters, cap the length.
 *  The one filename sanitiser for attachment writes — the IPC used to own a
 *  copy; it lives here so every writer and every test agree on the layout. */
import { safeAttachmentFilename } from "@zeros/protocol/attachment-policy";
export { safeAttachmentFilename } from "@zeros/protocol/attachment-policy";

/** Write one attachment's bytes into the graph — the composer's attach-time
 *  staging AND the send path's safety net, so it must be idempotent:
 *
 *    • The folder is `attachments/<attachmentId>/`. A record an earlier build
 *      wrote under `shared/` or `local/` keeps its folder, so a re-write
 *      never leaves a second copy next to the paths saved chats point at.
 *    • An existing file is left alone only after its bytes compare equal, so
 *      re-writes don't bump mtime while an external same-size edit is repaired.
 *
 *  Never throws; callers get a structured result like the other mutations. */
export async function stageContextGraphAttachment(
  workspaceRoot: string,
  args: { attachmentId: string; base64: string; filename: string },
): Promise<ContextGraphStageResult> {
  if (!ID_OK.test(args.attachmentId)) {
    return { ok: false, error: "invalid attachment id" };
  }
  if (args.base64.length > MAX_CONTEXT_GRAPH_ATTACHMENT_BASE64_CHARS) {
    return {
      ok: false,
      error: "attachment exceeds the 5 MiB size limit",
    };
  }
  const buf = Buffer.from(args.base64, "base64");
  if (buf.length > MAX_CONTEXT_GRAPH_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: "attachment exceeds the 5 MiB size limit",
    };
  }
  return stageAttachmentContents(workspaceRoot, args, buf);
}

/** Internal, engine-owned upload handle. Never accepts a renderer-supplied
 * source path. Chunks and completed copies stay bounded in memory. */
export async function stageContextGraphAttachmentFile(
  workspaceRoot: string,
  args: { attachmentId: string; filename: string; file: fs.FileHandle; size: number; verify?: () => Promise<void> },
): Promise<ContextGraphStageResult> {
  const { MAX_ATTACHMENT_BYTES } = await import("@zeros/protocol/attachment-policy");
  if (!ID_OK.test(args.attachmentId) || !Number.isSafeInteger(args.size) || args.size < 0 || args.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: "invalid attachment id or size" };
  }
  const stat = await args.file.stat();
  if (!stat.isFile() || stat.size !== args.size) return { ok: false, error: "incomplete attachment upload" };
  return stageAttachmentContents(workspaceRoot, args, { file: args.file, length: args.size, verify: args.verify });
}

async function stageAttachmentContents(
  workspaceRoot: string,
  args: { attachmentId: string; filename: string },
  buf: AttachmentContents,
): Promise<ContextGraphStageResult> {
  try {
    const scaffold = await ensureContextGraph(workspaceRoot);
    if (!scaffold.ok) {
      return {
        ok: false,
        error: scaffold.error ?? "couldn't scaffold the context graph",
      };
    }
    const root = graphRoot(workspaceRoot);
    const isDir = async (p: string) =>
      (await fs.lstat(p).catch(() => null))?.isDirectory() === true;
    const current = path.join(root, ATTACHMENTS_DIR, args.attachmentId);
    let dir = current;
    if (!(await isDir(current))) {
      for (const scope of [CONTEXT_GRAPH_SHARED, CONTEXT_GRAPH_LOCAL]) {
        const earlier = path.join(root, scope, ATTACHMENTS_DIR, args.attachmentId);
        if (await isDir(earlier)) {
          dir = earlier;
          break;
        }
      }
    }
    await assertContextDirectory(dir, workspaceRoot);
    if (!(await isConfined(dir, workspaceRoot))) {
      return { ok: false, error: "path escapes workspace" };
    }
    await fs.mkdir(dir, { recursive: true });
    publishCloudWorkspacePath(dir);
    if (!(await isConfined(dir, workspaceRoot))) {
      return { ok: false, error: "path escapes workspace" };
    }
    const safeName = safeAttachmentFilename(args.filename);
    const finalPath = path.join(dir, safeName);
    // Belt: ID_OK + safeAttachmentFilename already make this true; the check
    // protects against future regressions letting `..` through.
    if (!finalPath.startsWith(dir + path.sep)) {
      return {
        ok: false,
        error: "refusing to write outside the attachment folder",
      };
    }
    const result = {
      ok: true as const,
      absolutePath: finalPath,
      relativePath: path.relative(workspaceRoot, finalPath),
      bytes: buf.length,
    };
    if (await existingFileMatches(finalPath, buf)) {
      if (!Buffer.isBuffer(buf)) await buf.verify?.();
      return { ...result, skipped: true };
    }
    await atomicWriteAttachment(finalPath, buf, workspaceRoot);
    return result;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// There is deliberately no per-attachment delete: the graph is append-only
// from the app (2026-08-03(3)) — staged records outlive the composer chip,
// the queued message, and the send that carried them. Files leave the graph
// only when the user deletes them on disk.

/** True when the graph holds anything worth preserving (any file beyond its
 *  own scaffolding). Gates the archive force-add so an empty skeleton doesn't
 *  make a clean-tree archive stricter than it is today. */
export async function contextGraphHasContent(
  workspaceRoot: string,
): Promise<boolean> {
  return (
    (await contextMigrationArchivePaths(workspaceRoot).catch(() => [])).length >
      0 ||
    (await contextRootHasContent(workspaceRoot, CONTEXT_GRAPH_DIR)) ||
    (await contextRootHasContent(workspaceRoot, LEGACY_CONTEXT_DIR))
  );
}

/** Archive attachments, agents' working files and earlier builds' scopes.
 * Private tool state at the top of `.context/` is excluded: a snapshot cannot
 * restore its permissions. Old archives and workspaces can still contain the
 * complete legacy graph root. */
export async function contextGraphArchivePaths(
  workspaceRoot: string,
): Promise<string[]> {
  const candidates = await contextMigrationArchivePaths(workspaceRoot);
  if (
    candidates.length > 0 ||
    (await contextRootHasContent(workspaceRoot, CONTEXT_GRAPH_DIR))
  ) {
    candidates.push(
      `${CONTEXT_GRAPH_DIR}/.gitignore`,
      `${CONTEXT_GRAPH_DIR}/${ATTACHMENTS_DIR}`,
      `${CONTEXT_GRAPH_DIR}/${CONTEXT_GRAPH_LOCAL}`,
      `${CONTEXT_GRAPH_DIR}/${CONTEXT_GRAPH_SHARED}`,
      ...(await workspaceContextEntries(workspaceRoot, Infinity)).map(
        (entry) => `${CONTEXT_GRAPH_DIR}/${entry.name}`,
      ),
    );
  }
  if (await contextRootHasContent(workspaceRoot, LEGACY_CONTEXT_DIR))
    candidates.push(LEGACY_CONTEXT_DIR);
  const present = await Promise.all(
    candidates.map(
      async (relative) =>
        await fs.lstat(path.join(workspaceRoot, relative)).then(
          () => relative,
          () => null,
        ),
    ),
  );
  return present.filter((relative): relative is string => relative !== null);
}

function isContentFile(entry: Dirent): boolean {
  return (
    entry.isFile() && entry.name !== ".gitignore" && entry.name !== ".DS_Store"
  );
}

async function attachmentsHaveContent(
  workspaceRoot: string,
  attachmentsAbs: string,
): Promise<boolean> {
  try {
    await assertContextDirectory(attachmentsAbs, workspaceRoot);
  } catch {
    return false;
  }
  for (const idEntry of await readDirBounded(attachmentsAbs, Infinity)) {
    if (!idEntry.isDirectory() || !ID_OK.test(idEntry.name)) continue;
    for (const fileEntry of await readDirBounded(
      path.join(attachmentsAbs, idEntry.name),
      Infinity,
    )) {
      if (isContentFile(fileEntry)) return true;
    }
  }
  return false;
}

async function docsHaveContent(
  absDir: string,
  skip: (name: string) => boolean = () => false,
): Promise<boolean> {
  // Archive eligibility must inspect beyond the UI's depth/entry limits:
  // an omitted ignored file would disappear when the worktree is removed.
  for (const entry of await readDirBounded(absDir, Infinity)) {
    if (skip(entry.name)) continue;
    if (entry.isDirectory()) {
      if (await docsHaveContent(path.join(absDir, entry.name)))
        return true;
    } else if (isContentFile(entry)) {
      return true;
    }
  }
  return false;
}

async function contextRootHasContent(
  workspaceRoot: string,
  directory: string,
): Promise<boolean> {
  const root = graphRoot(workspaceRoot, directory);
  try {
    if (!(await isConfined(root, workspaceRoot))) return false;
    const rootStat = await fs.lstat(root).catch(() => null);
    if (!rootStat?.isDirectory()) return false;

    if (directory === CONTEXT_GRAPH_DIR) {
      if (
        await attachmentsHaveContent(
          workspaceRoot,
          path.join(root, ATTACHMENTS_DIR),
        )
      )
        return true;
      for (const entry of await workspaceContextEntries(workspaceRoot, Infinity)) {
        if (!entry.directory) return true;
        if (await docsHaveContent(path.join(root, entry.name))) return true;
      }
    }

    const scopeHasContent = async (
      scope: ContextGraphScope,
    ): Promise<boolean> => {
      const scopeAbs = path.join(root, scope);
      try {
        await assertContextDirectory(scopeAbs, workspaceRoot);
      } catch {
        return false;
      }
      return (
        (await attachmentsHaveContent(
          workspaceRoot,
          path.join(scopeAbs, ATTACHMENTS_DIR),
        )) ||
        (await docsHaveContent(
          scopeAbs,
          scopeReservedEntry(directory, scope),
        ))
      );
    };

    return (
      (await scopeHasContent(CONTEXT_GRAPH_LOCAL)) ||
      (await scopeHasContent(CONTEXT_GRAPH_SHARED))
    );
  } catch {
    return false;
  }
}

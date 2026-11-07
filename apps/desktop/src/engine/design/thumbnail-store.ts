import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { DESIGN_CAPTURE_PNG_BYTES } from "@zeros/protocol/design-capture";
import { zerosDataDir } from "../db/paths";
import { resolveDesignCaptureConfig } from "./capture-client";
import { DESIGN_DIRECTORY_ID_PATTERN } from "./directory-path";
import { designPrivateStorageDirectory } from "./metadata-storage";

// Pictures of saved frames kept across launches in private engine storage:
//   design-storage/<workspace>/thumbnails/<directory id>/<frame id>/
//     <size>-<color scheme>-<theme or _>~<sourceVersion>~<pipeline key>.png
// One picture per frame and variant; a newer generation replaces the older.
// Frame ids, not files, so moving a frame between pages keeps its pictures.
// The pixels are disposable: anything unreadable is simply missing.

/** Bump whenever composing a thumbnail changes its pixels for the same frame. */
export const DESIGN_THUMBNAIL_COMPOSER = "thumbnails-1";
export const designThumbnailPipeline = (renderer: string) => `${DESIGN_THUMBNAIL_COMPOSER}:${renderer}`;

const WORKSPACE_BYTES = 256 * 1024 * 1024;
const TOTAL_BYTES = 1024 * 1024 * 1024;
/** Reading a picture marks it recently used at most this often. */
const TOUCH_MS = 60 * 60 * 1000;
const SWEEP_DELAY_MS = 60_000;
const SWEEP_AFTER_BYTES = 32 * 1024 * 1024;
const MAX_PIPELINES = 16;
const FRAME_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const SOURCE_VERSION = /^[a-f0-9]{24}$/;
const PICTURE = /^(\d{2,4}-(?:light|dark)-(?:_|[a-z][a-z0-9_-]{0,63}))~([a-f0-9]{24})~([a-f0-9]{16})\.png$/;
const TEMPORARY = /^\.[a-f0-9-]{36}\.tmp$/;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

export interface DesignThumbnailVariant {
  readonly theme: string | null;
  readonly colorScheme: "light" | "dark";
  readonly maxDimension: number;
}

export interface StoredDesignThumbnail {
  readonly sourceVersion: string;
  /** Null when the store no longer knows which pipeline drew it. */
  readonly pipeline: string | null;
  readonly width: number;
  readonly height: number;
  readonly bytes: Buffer;
}

interface PipelineRegistry {
  current: string | null;
  pipelines: Record<string, string>;
}

const state: {
  /** Loaded once per storage root (one per launch; tests vary it). */
  registry: { root: string; value: Promise<PipelineRegistry> } | null;
  registryWrite: Promise<void>;
  sweepTimer: NodeJS.Timeout | null;
  sweeping: Promise<unknown> | null;
  written: number;
  started: boolean;
  /** A capture contradicted the renderer named at launch. */
  namedRendererWrong: boolean;
} = { registry: null, registryWrite: Promise.resolve(), sweepTimer: null, sweeping: null, written: 0, started: false, namedRendererWrong: false };

const variantName = (variant: DesignThumbnailVariant) =>
  `${variant.maxDimension}-${variant.colorScheme}-${variant.theme ?? "_"}`;
const pipelineKey = (pipeline: string) => createHash("sha256").update(pipeline).digest("hex").slice(0, 16);
const storageRoot = () => path.join(zerosDataDir(), "design-storage");
const registryFile = () => path.join(storageRoot(), "thumbnail-pipelines.json");

function frameFolder(workspace: string, directoryId: string, frameId: string): string | null {
  if (!DESIGN_DIRECTORY_ID_PATTERN.test(directoryId) || !FRAME_ID.test(frameId)) return null;
  return path.join(designPrivateStorageDirectory(workspace), "thumbnails", directoryId, frameId);
}

const realRoots = new Map<string, string>();
/** Pictures are read and written only inside private storage, so a link
 * planted along the way cannot point them elsewhere. */
async function contained(folder: string): Promise<boolean> {
  const base = storageRoot();
  const root = realRoots.get(base) ?? await realpath(base).catch(() => null);
  if (!root) return false;
  realRoots.set(base, root);
  const resolved = await realpath(folder).catch(() => null);
  return resolved !== null && resolved.startsWith(`${root}${path.sep}`);
}

/** Entries of a real directory; a link or anything else has none. */
async function entries(directory: string): Promise<string[]> {
  try {
    if (!(await lstat(directory)).isDirectory()) return [];
    return await readdir(directory);
  } catch {
    return [];
  }
}

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function loadRegistry(): Promise<PipelineRegistry> {
  if (state.registry?.root === storageRoot()) return state.registry.value;
  const value = readFile(registryFile(), "utf8").then((text) => {
    const value = JSON.parse(text) as Partial<PipelineRegistry>;
    const pipelines = Object.fromEntries(Object.entries(value.pipelines ?? {})
      .filter(([key, pipeline]) => /^[a-f0-9]{16}$/.test(key) && typeof pipeline === "string" && pipeline.length <= 256 && pipelineKey(pipeline) === key));
    const current = typeof value.current === "string" && pipelineKey(value.current) in pipelines ? value.current : null;
    return { current, pipelines };
  }).catch(() => ({ current: null, pipelines: {} }));
  state.registry = { root: storageRoot(), value };
  return value;
}

async function saveRegistry(registry: PipelineRegistry): Promise<void> {
  const write = state.registryWrite.then(async () => {
    await mkdir(storageRoot(), { recursive: true, mode: 0o700 });
    const temporary = path.join(storageRoot(), `.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(registry), { mode: 0o600, flag: "wx" });
    await rename(temporary, registryFile());
  });
  state.registryWrite = write.catch(() => {});
  await write;
}

async function rememberPipeline(pipeline: string, current: boolean): Promise<string> {
  const key = pipelineKey(pipeline);
  const registry = await loadRegistry();
  if (registry.pipelines[key] === pipeline && (!current || registry.current === pipeline)) return key;
  const pipelines = Object.entries({ ...registry.pipelines, [key]: pipeline });
  // Insertion order is age; the current pipeline is never dropped.
  while (pipelines.length > MAX_PIPELINES) pipelines.splice(pipelines.findIndex(([entry]) => entry !== key && entry !== pipelineKey(registry.current ?? "")), 1);
  registry.pipelines = Object.fromEntries(pipelines);
  if (current) registry.current = pipeline;
  await saveRegistry(registry).catch(() => {});
  return key;
}

/** The pipeline pictures drawn now carry: the host's renderer when the app
 * names it at launch, else the last one a capture reported. */
export async function currentDesignThumbnailPipeline(): Promise<{ pipeline: string | null; exact: boolean }> {
  const renderer = state.namedRendererWrong ? undefined : resolveDesignCaptureConfig()?.renderer;
  if (renderer) return { pipeline: designThumbnailPipeline(renderer), exact: true };
  return { pipeline: (await loadRegistry()).current, exact: false };
}

/** A capture drew with this pipeline: later reads treat it as current. */
export async function noteDesignThumbnailPipeline(pipeline: string): Promise<void> {
  const renderer = resolveDesignCaptureConfig()?.renderer;
  if (renderer && designThumbnailPipeline(renderer) !== pipeline) state.namedRendererWrong = true;
  await rememberPipeline(pipeline, true);
}

function scheduleSweep(delay: number): void {
  if (state.sweepTimer) return;
  state.sweepTimer = setTimeout(() => {
    state.sweepTimer = null;
    if (state.sweeping) return;
    state.written = 0;
    state.sweeping = sweepDesignThumbnails().catch(() => {}).finally(() => { state.sweeping = null; });
  }, delay);
  state.sweepTimer.unref?.();
}

/** A launch trims what an earlier one left over budget, once, soon after first use. */
function noteUse(): void {
  if (state.started) return;
  state.started = true;
  scheduleSweep(SWEEP_DELAY_MS);
}

export async function readStoredDesignThumbnail(
  workspace: string,
  directoryId: string,
  frameId: string,
  variant: DesignThumbnailVariant,
): Promise<StoredDesignThumbnail | null> {
  noteUse();
  const folder = frameFolder(workspace, directoryId, frameId);
  if (!folder || !(await contained(folder))) return null;
  const prefix = `${variantName(variant)}~`;
  let best: { name: string; modified: number; match: RegExpExecArray } | null = null;
  // Normally one; a replace interrupted by a crash can leave two, and the newest wins.
  for (const name of await entries(folder)) {
    const match = name.startsWith(prefix) ? PICTURE.exec(name) : null;
    if (!match) continue;
    const info = await lstat(path.join(folder, name)).catch(() => null);
    if (info?.isFile() && (!best || info.mtimeMs > best.modified)) best = { name, modified: info.mtimeMs, match };
  }
  if (!best) return null;
  const file = path.join(folder, best.name);
  let bytes: Buffer;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > DESIGN_CAPTURE_PNG_BYTES) return null;
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const size = pngSize(bytes);
  if (!size || bytes.length > DESIGN_CAPTURE_PNG_BYTES) return null;
  if (Date.now() - best.modified > TOUCH_MS) {
    const now = new Date();
    await utimes(file, now, now).catch(() => {});
  }
  const registry = await loadRegistry();
  return { sourceVersion: best.match[2]!, pipeline: registry.pipelines[best.match[3]!] ?? null, ...size, bytes };
}

export async function storeDesignThumbnail(
  workspace: string,
  directoryId: string,
  frameId: string,
  variant: DesignThumbnailVariant,
  picture: { sourceVersion: string; pipeline: string; bytes: Buffer },
): Promise<boolean> {
  noteUse();
  const folder = frameFolder(workspace, directoryId, frameId);
  if (!folder || !SOURCE_VERSION.test(picture.sourceVersion) || picture.bytes.length > DESIGN_CAPTURE_PNG_BYTES || !pngSize(picture.bytes))
    return false;
  const key = await rememberPipeline(picture.pipeline, false);
  const prefix = `${variantName(variant)}~`;
  const name = `${prefix}${picture.sourceVersion}~${key}.png`;
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (!(await lstat(folder)).isDirectory() || !(await contained(folder))) return false;
    const temporary = path.join(folder, `.${randomUUID()}.tmp`);
    await writeFile(temporary, picture.bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path.join(folder, name));
  } catch {
    return false;
  }
  for (const other of await entries(folder))
    if (other !== name && other.startsWith(prefix)) await unlink(path.join(folder, other)).catch(() => {});
  state.written += picture.bytes.length;
  if (state.written >= SWEEP_AFTER_BYTES) scheduleSweep(0);
  return true;
}

/** Keeps every workspace's pictures within its share and all of them within
 * the total, removing the least recently used first. A deleted workspace's
 * pictures are never read again, so they go first. */
export async function sweepDesignThumbnails(
  limits: { workspace: number; total: number } = { workspace: WORKSPACE_BYTES, total: TOTAL_BYTES },
): Promise<{ removed: number; bytes: number }> {
  const pictures: Array<{ file: string; workspace: string; size: number; used: number }> = [];
  let visited = 0;
  for (const name of await entries(storageRoot())) {
    const file = path.join(storageRoot(), name);
    const info = TEMPORARY.test(name) ? await lstat(file).catch(() => null) : null;
    if (info?.isFile() && Date.now() - info.mtimeMs > TOUCH_MS) await unlink(file).catch(() => {});
  }
  for (const workspace of await entries(storageRoot())) {
    const root = path.join(storageRoot(), workspace, "thumbnails");
    for (const directory of await entries(root)) {
      for (const frame of await entries(path.join(root, directory))) {
        const folder = path.join(root, directory, frame);
        const names = await entries(folder);
        if (names.length === 0) await rmdir(folder).catch(() => {});
        for (const name of names) {
          const file = path.join(folder, name);
          const info = await lstat(file).catch(() => null);
          if (!info?.isFile()) continue;
          if (PICTURE.test(name)) pictures.push({ file, workspace, size: info.size, used: info.mtimeMs });
          else if (TEMPORARY.test(name) && Date.now() - info.mtimeMs > TOUCH_MS) await unlink(file).catch(() => {});
        }
        if (++visited % 256 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
  pictures.sort((left, right) => left.used - right.used);
  const usage = new Map<string, number>();
  let total = 0;
  for (const picture of pictures) {
    usage.set(picture.workspace, (usage.get(picture.workspace) ?? 0) + picture.size);
    total += picture.size;
  }
  let removed = 0, bytes = 0;
  for (const picture of pictures) {
    if (usage.get(picture.workspace)! <= limits.workspace && total <= limits.total) continue;
    if (await unlink(picture.file).then(() => true, () => false)) {
      removed++;
      bytes += picture.size;
    }
    usage.set(picture.workspace, usage.get(picture.workspace)! - picture.size);
    total -= picture.size;
  }
  return { removed, bytes };
}

export async function settleDesignThumbnailStoreForTests(): Promise<void> {
  if (state.sweepTimer) clearTimeout(state.sweepTimer);
  state.sweepTimer = null;
  await state.sweeping;
  await state.registryWrite;
}

export function resetDesignThumbnailStoreForTests(): void {
  if (state.sweepTimer) clearTimeout(state.sweepTimer);
  Object.assign(state, { registry: null, registryWrite: Promise.resolve(), sweepTimer: null, sweeping: null, written: 0, started: false, namedRendererWrong: false });
  realRoots.clear();
}

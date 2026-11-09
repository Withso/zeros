import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { DESIGN_RECORDING_CHUNK_ID_PATTERN, DESIGN_RECORDING_MAX_BYTES, DESIGN_RECORDING_MAX_LAYERS, DESIGN_RECORDING_MAX_TYPEFACES, DESIGN_RECORDING_TYPEFACE_MAX_BYTES } from "@zeros/protocol/design-capture";
import { zerosDataDir } from "../db/paths";
import { DESIGN_DIRECTORY_ID_PATTERN } from "./directory-path";
import { designPrivateStorageDirectory } from "./metadata-storage";
import { chunkDesignRecording, designRecordingChunkId, DESIGN_RECORDING_CHUNKER, RECORDING_CHUNK_MAX } from "./recording-chunks";

// Recordings of saved frames kept across launches in private engine storage:
//   design-storage/<workspace>/recordings/<directory id>/<frame id>/
//     <theme or _>~<sourceVersion>~<pipeline key>.json   (a manifest)
//   design-storage/recording-chunks/<id[0,2]>/<id>          (shared chunks)
//   design-storage/recording-typefaces/<id[0,2]>/<id>.json  (shared fonts)
// One manifest per frame and theme; a newer generation replaces the older.
// Chunks are content-addressed and shared by every workspace, so the font
// data recordings embed is stored once. Everything here is disposable:
// anything unreadable is simply missing, and the frame is recorded again.

const FRAME_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const SOURCE_VERSION = /^[a-f0-9]{24}$/;
const THEME = /^(?:_|[a-z][a-z0-9_-]{0,63})$/;
const MANIFEST = /^(_|[a-z][a-z0-9_-]{0,63})~([a-f0-9]{24})~([a-f0-9]{16})\.json$/;
const MANIFEST_BYTES = 4 * 1024 * 1024;
/** Reading a recording marks it recently used at most this often. */
const TOUCH_MS = 60 * 60 * 1000;

export interface DesignRecordingLayerInput {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  /** Externalized typefaces the picture references, already stored. */
  readonly typefaces?: readonly string[];
}

export interface StoredDesignRecordingLayer {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly chunks: readonly string[];
  readonly typefaces: readonly string[];
}

/** Font data a recording references by content id, stored as chunks. */
export interface StoredDesignRecordingTypeface {
  readonly id: string;
  readonly bytes: number;
  readonly chunks: readonly string[];
}

export interface StoredDesignRecording {
  readonly sourceVersion: string;
  readonly pipeline: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly layers: readonly StoredDesignRecordingLayer[];
}

function storageRoot(): string {
  return path.join(zerosDataDir(), "design-storage");
}

function chunkFile(id: string): string {
  return path.join(storageRoot(), "recording-chunks", id.slice(0, 2), id);
}

function typefaceFile(id: string): string {
  return path.join(storageRoot(), "recording-typefaces", id.slice(0, 2), `${id}.json`);
}

function frameFolder(workspace: string, directoryId: string, frameId: string): string | null {
  if (!DESIGN_DIRECTORY_ID_PATTERN.test(directoryId) || !FRAME_ID.test(frameId)) return null;
  return path.join(designPrivateStorageDirectory(workspace), "recordings", directoryId, frameId);
}

const themeName = (theme: string | null) => theme ?? "_";
const pipelineKey = (pipeline: string) => createHash("sha256").update(`${DESIGN_RECORDING_CHUNKER}\0${pipeline}`).digest("hex").slice(0, 16);

const realRoots = new Map<string, string>();
/** Recordings are read and written only inside private storage, so a link
 * planted along the way cannot point them elsewhere. */
async function contained(target: string): Promise<boolean> {
  const base = storageRoot();
  const root = realRoots.get(base) ?? await realpath(base).catch(() => null);
  if (!root) return false;
  realRoots.set(base, root);
  const resolved = await realpath(target).catch(() => null);
  return resolved !== null && resolved.startsWith(`${root}${path.sep}`);
}

async function entries(directory: string): Promise<string[]> {
  try {
    if (!(await lstat(directory)).isDirectory()) return [];
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function readBounded(file: string, limit: number): Promise<Buffer | null> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit) return null;
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function writeAtomically(folder: string, name: string, bytes: Uint8Array): Promise<boolean> {
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (!(await lstat(folder)).isDirectory() || !(await contained(folder))) return false;
    const temporary = path.join(folder, `.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path.join(folder, name));
    return true;
  } catch {
    return false;
  }
}

/** Chunk bytes, verified against their content address. */
export async function readDesignRecordingChunk(id: string): Promise<Buffer | null> {
  if (!DESIGN_RECORDING_CHUNK_ID_PATTERN.test(id)) return null;
  const file = chunkFile(id);
  if (!(await contained(path.dirname(file)))) return null;
  const bytes = await readBounded(file, RECORDING_CHUNK_MAX);
  return bytes && designRecordingChunkId(bytes) === id ? bytes : null;
}

async function storeChunk(id: string, bytes: Uint8Array): Promise<boolean> {
  // A stored chunk counts only if it still hashes to its id; a damaged one
  // is replaced (content-addressed, so rewriting it is idempotent).
  if (await readDesignRecordingChunk(id)) return true;
  const file = chunkFile(id);
  return writeAtomically(path.dirname(file), id, bytes);
}

function validManifest(value: unknown, sourceVersion: string): StoredDesignRecording | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Record<string, unknown>;
  const finite = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  if (manifest.sourceVersion !== sourceVersion || typeof manifest.pipeline !== "string" || manifest.pipeline.length === 0 || manifest.pipeline.length > 256) return null;
  if (!finite(manifest.width, 1, 16_384) || !finite(manifest.height, 1, 16_384) || !finite(manifest.scale, 0.25, 8)) return null;
  if (!Array.isArray(manifest.layers) || manifest.layers.length < 1 || manifest.layers.length > DESIGN_RECORDING_MAX_LAYERS) return null;
  for (const layer of manifest.layers as Array<Record<string, unknown>>) {
    if (!layer || !finite(layer.x, -1e9, 1e9) || !finite(layer.y, -1e9, 1e9) || !finite(layer.width, 1, 65_536) || !finite(layer.height, 1, 65_536)) return null;
    if (!finite(layer.bytes, 1, DESIGN_RECORDING_MAX_BYTES) || !Array.isArray(layer.chunks) || layer.chunks.length < 1) return null;
    if (!layer.chunks.every((id) => typeof id === "string" && DESIGN_RECORDING_CHUNK_ID_PATTERN.test(id))) return null;
    if (!Array.isArray(layer.typefaces) || layer.typefaces.length > DESIGN_RECORDING_MAX_TYPEFACES ||
      !layer.typefaces.every((id) => typeof id === "string" && DESIGN_RECORDING_CHUNK_ID_PATTERN.test(id))) return null;
  }
  return manifest as unknown as StoredDesignRecording;
}

/** Chunks a recording's layers, stores chunks the store lacks, then its
 * manifest, replacing the frame's older generations in this theme. */
export async function storeDesignRecording(
  workspace: string,
  directoryId: string,
  frameId: string,
  theme: string | null,
  recording: { sourceVersion: string; pipeline: string; width: number; height: number; scale: number; layers: readonly DesignRecordingLayerInput[] },
): Promise<StoredDesignRecording | null> {
  const folder = frameFolder(workspace, directoryId, frameId);
  const name = themeName(theme);
  if (!folder || !THEME.test(name) || !SOURCE_VERSION.test(recording.sourceVersion)) return null;
  if (recording.layers.length < 1 || recording.layers.length > DESIGN_RECORDING_MAX_LAYERS) return null;
  const layers: StoredDesignRecordingLayer[] = [];
  for (const layer of recording.layers) {
    if (layer.bytes.length < 1 || layer.bytes.length > DESIGN_RECORDING_MAX_BYTES) return null;
    const chunks = chunkDesignRecording(layer.bytes);
    for (const chunk of chunks) if (!(await storeChunk(chunk.id, chunk.bytes))) return null;
    const typefaces = [...new Set(layer.typefaces ?? [])];
    if (typefaces.length > DESIGN_RECORDING_MAX_TYPEFACES || !typefaces.every((id) => DESIGN_RECORDING_CHUNK_ID_PATTERN.test(id))) return null;
    layers.push({ x: layer.x, y: layer.y, width: layer.width, height: layer.height, bytes: layer.bytes.length, chunks: chunks.map((chunk) => chunk.id), typefaces });
  }
  const stored: StoredDesignRecording = { sourceVersion: recording.sourceVersion, pipeline: recording.pipeline,
    width: recording.width, height: recording.height, scale: recording.scale, layers };
  const file = `${name}~${recording.sourceVersion}~${pipelineKey(recording.pipeline)}.json`;
  if (!(await writeAtomically(folder, file, Buffer.from(JSON.stringify(stored))))) return null;
  for (const other of await entries(folder))
    if (other !== file && other.startsWith(`${name}~`)) await unlink(path.join(folder, other)).catch(() => {});
  return stored;
}

const FAILURE_BYTES = 4 * 1024;

function failureFile(name: string, sourceVersion: string, pipeline: string): string {
  return `${name}~${sourceVersion}~${pipelineKey(pipeline)}.failed`;
}

/** Remembers that this recorder can't record this generation of the frame in
 * this theme, so later requests answer at once instead of recording again.
 * The frame's stored recordings stay; a recording stored later replaces it. */
export async function storeDesignRecordingFailure(
  workspace: string,
  directoryId: string,
  frameId: string,
  theme: string | null,
  failure: { sourceVersion: string; pipeline: string; error: string },
): Promise<boolean> {
  const folder = frameFolder(workspace, directoryId, frameId);
  const name = themeName(theme);
  if (!folder || !THEME.test(name) || !SOURCE_VERSION.test(failure.sourceVersion) || !failure.error) return false;
  const file = failureFile(name, failure.sourceVersion, failure.pipeline);
  if (!(await writeAtomically(folder, file, Buffer.from(JSON.stringify({ error: failure.error.slice(0, 500) }))))) return false;
  for (const other of await entries(folder))
    if (other !== file && other.startsWith(`${name}~`) && other.endsWith(".failed")) await unlink(path.join(folder, other)).catch(() => {});
  return true;
}

/** Why this recorder can't record this generation of the frame, if it is known. */
export async function readDesignRecordingFailure(
  workspace: string,
  directoryId: string,
  frameId: string,
  theme: string | null,
  wanted: { sourceVersion: string; pipeline: string },
): Promise<string | null> {
  const folder = frameFolder(workspace, directoryId, frameId);
  const name = themeName(theme);
  if (!folder || !THEME.test(name) || !SOURCE_VERSION.test(wanted.sourceVersion) || !(await contained(folder))) return null;
  const bytes = await readBounded(path.join(folder, failureFile(name, wanted.sourceVersion, wanted.pipeline)), FAILURE_BYTES);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error ? parsed.error : null;
  } catch { return null; }
}

/** The frame's newest stored recording in this theme, of any generation
 * unless `sourceVersion` names one, and of any pipeline unless one is named. */
export async function readStoredDesignRecording(
  workspace: string,
  directoryId: string,
  frameId: string,
  theme: string | null,
  wanted: { sourceVersion?: string; pipeline?: string } = {},
): Promise<StoredDesignRecording | null> {
  const folder = frameFolder(workspace, directoryId, frameId);
  const name = themeName(theme);
  if (!folder || !THEME.test(name) || !(await contained(folder))) return null;
  let best: { file: string; modified: number; version: string } | null = null;
  for (const entry of await entries(folder)) {
    const match = MANIFEST.exec(entry);
    if (!match || match[1] !== name) continue;
    if (wanted.sourceVersion !== undefined && match[2] !== wanted.sourceVersion) continue;
    if (wanted.pipeline !== undefined && match[3] !== pipelineKey(wanted.pipeline)) continue;
    const info = await lstat(path.join(folder, entry)).catch(() => null);
    if (info?.isFile() && (!best || info.mtimeMs > best.modified)) best = { file: entry, modified: info.mtimeMs, version: match[2]! };
  }
  if (!best) return null;
  const file = path.join(folder, best.file);
  const bytes = await readBounded(file, MANIFEST_BYTES);
  if (!bytes) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  const manifest = validManifest(parsed, best.version);
  if (!manifest || (wanted.pipeline !== undefined && manifest.pipeline !== wanted.pipeline)) return null;
  if (Date.now() - best.modified > TOUCH_MS) {
    const now = new Date();
    await utimes(file, now, now).catch(() => {});
  }
  return manifest;
}

/** Stores an externalized typeface's font data as chunks, under its content
 * id (the chunk-id rule over the whole font data), once for every workspace. */
export async function storeDesignRecordingTypeface(id: string, bytes: Uint8Array): Promise<StoredDesignRecordingTypeface | null> {
  if (!DESIGN_RECORDING_CHUNK_ID_PATTERN.test(id) || bytes.length < 1 || bytes.length > DESIGN_RECORDING_TYPEFACE_MAX_BYTES) return null;
  if (designRecordingChunkId(bytes) !== id) return null;
  const existing = await readDesignRecordingTypeface(id);
  if (existing) return existing;
  const chunks = chunkDesignRecording(bytes);
  for (const chunk of chunks) if (!(await storeChunk(chunk.id, chunk.bytes))) return null;
  const stored: StoredDesignRecordingTypeface = { id, bytes: bytes.length, chunks: chunks.map((chunk) => chunk.id) };
  const file = typefaceFile(id);
  return (await writeAtomically(path.dirname(file), path.basename(file), Buffer.from(JSON.stringify(stored)))) ? stored : null;
}

export async function readDesignRecordingTypeface(id: string): Promise<StoredDesignRecordingTypeface | null> {
  if (!DESIGN_RECORDING_CHUNK_ID_PATTERN.test(id)) return null;
  const file = typefaceFile(id);
  if (!(await contained(path.dirname(file)))) return null;
  const bytes = await readBounded(file, MANIFEST_BYTES);
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  const typeface = value as Partial<StoredDesignRecordingTypeface>;
  if (typeface?.id !== id || typeof typeface.bytes !== "number" || !Number.isInteger(typeface.bytes) || typeface.bytes < 1 ||
    typeface.bytes > DESIGN_RECORDING_TYPEFACE_MAX_BYTES || !Array.isArray(typeface.chunks) || typeface.chunks.length < 1 ||
    !typeface.chunks.every((chunk) => typeof chunk === "string" && DESIGN_RECORDING_CHUNK_ID_PATTERN.test(chunk))) return null;
  return { id, bytes: typeface.bytes, chunks: [...typeface.chunks] };
}

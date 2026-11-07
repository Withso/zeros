import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesignSurfaceCost } from "@zeros/protocol/design-surface";
import { DESIGN_MAX_FRAMES_PER_PAGE } from "@zeros/protocol/design-pages";
import { isDevRuntime } from "../runtime";
import { durableDesignDependenciesCurrent, type DurableDesignDependency } from "./dependency-read-set";
import type { CanvasDocument } from "./document-model";
import { designPrivateStorageDirectory } from "./metadata-storage";

/** What preparing a frame computes from its sources, beside canvas metadata. */
export interface DesignFrameIdentity {
  sourceVersion: string;
  surfaceCost: DesignSurfaceCost | null;
  nodeCount: number;
  layerCount: number;
}

// A frame's identity is reused while every file its preparation read keeps
// its bytes (sha256, re-read with the same open rules) and every canvas input
// it could read is unchanged. Identities persist per page folder in private
// engine storage, keyed to this exact engine build, so a restart skips the
// parse-heavy preparation for unchanged frames.

/** Bump whenever preparation computes a different identity from the same inputs. */
const DESIGN_IDENTITY_PIPELINE = 1;
const MAX_PAGE_ENTRIES = DESIGN_MAX_FRAMES_PER_PAGE * 2;
const MAX_PAGES = 256;
const WRITE_DELAY_MS = 1_000;

interface Entry {
  context: string;
  identity: DesignFrameIdentity;
  /** Null for a read set that cannot be stored; `current` then verifies it. */
  dependencies: DurableDesignDependency[] | null;
  current?: () => boolean;
  /** The files an unstored read set looked up, to say which changes reach it. */
  targets?: string[];
}

interface Page {
  file: string | null;
  entries: Map<string, Entry>;
  loaded: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  writing: Promise<void>;
}

const pages = new Map<string, Page>();
const testing = { durable: null as boolean | null, build: null as string | null, hits: 0, misses: 0 };

let build: string | null = null;
/** This engine's code: its executable and entry module, by size and mtime. */
function engineBuild(): string {
  if (testing.build !== null) return testing.build;
  if (build !== null) return build;
  const stamp = (file: string | undefined) => {
    if (!file) return "";
    try {
      const info = statSync(file);
      return `${info.size}:${info.mtimeMs}`;
    } catch {
      return "";
    }
  };
  build = `${DESIGN_IDENTITY_PIPELINE}\0${stamp(process.execPath)}\0${stamp(process.argv[1])}`;
  return build;
}

/** Development engines and test runs keep identities in memory: their code
 * changes without a new build stamp, and tests must not touch real storage.
 * ZEROS_DESIGN_IDENTITY_CACHE=durable persists them in a development engine,
 * to measure restarts as a packaged build sees them. It trusts the stamp, so
 * clear private storage after editing preparation code. */
export function designIdentityCacheDurable(env: NodeJS.ProcessEnv = process.env, development = isDevRuntime()): boolean {
  return !env.VITEST && (!development || env.ZEROS_DESIGN_IDENTITY_CACHE === "durable");
}
const durable = () => testing.durable ?? designIdentityCacheDurable();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Canvas inputs a frame's preparation may read: everything but other
 * frames, page membership and the camera, plus this frame's size, record and
 * page. Positions are not inputs, so moving a frame keeps its identity. */
const canvasLevel = new WeakMap<object, string>();
export function designFrameIdentityContext(canvas: CanvasDocument, file: string, pageId: string | undefined): string | null {
  const geometry = canvas.frames[file];
  const info = canvas.frame_info[file];
  if (!geometry || !info) return null;
  let shared = canvasLevel.get(canvas);
  if (shared === undefined) {
    const { frames: _frames, frame_info: _info, pages: _pages, view: _view, ...rest } = canvas as CanvasDocument & { view?: unknown };
    shared = JSON.stringify(rest);
    if (Object.isFrozen(canvas)) canvasLevel.set(canvas, shared);
  }
  const page = pageId === undefined ? undefined : canvas.pages?.find((candidate) => candidate.id === pageId);
  const { frames: _members, ...pageInputs } = page ?? { frames: [] };
  return digest(JSON.stringify([shared, file, geometry.w, geometry.h, info, pageInputs]));
}

function pageKey(workspacePath: string, directory: string, file: string): { key: string; name: string } {
  const folder = file.includes("/") ? file.slice(0, file.indexOf("/")) : "";
  const key = `${path.resolve(workspacePath)}\0${directory}\0${folder}`;
  return { key, name: `identities-${digest(`${directory}\0${folder}`).slice(0, 32)}.json` };
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function load(workspacePath: string, page: Page): Promise<void> {
  if (!page.file) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(page.file, "utf8"));
  } catch {
    return;
  }
  const stored = parsed as { version?: unknown; build?: unknown; dependencies?: unknown; entries?: unknown };
  if (stored.version !== 1 || stored.build !== engineBuild() || !Array.isArray(stored.dependencies) ||
    !stored.entries || typeof stored.entries !== "object") return;
  const workspace = path.resolve(workspacePath);
  const table = stored.dependencies as DurableDesignDependency[];
  const usable = table.map((dependency) =>
    !!dependency && typeof dependency.root === "string" && typeof dependency.target === "string" &&
    Number.isSafeInteger(dependency.limit) && (dependency.fingerprint === null || typeof dependency.fingerprint === "string") &&
    Array.isArray(dependency.policies) && dependency.policies.every((name) => typeof name === "string") &&
    (dependency.root === workspace || within(workspace, dependency.root)) && within(workspace, dependency.target));
  for (const [file, value] of Object.entries(stored.entries as Record<string, unknown>)) {
    const entry = value as { context?: unknown; identity?: DesignFrameIdentity; dependencies?: unknown };
    const identity = entry?.identity;
    if (typeof entry?.context !== "string" || !Array.isArray(entry.dependencies) || !identity ||
      typeof identity.sourceVersion !== "string" || !Number.isSafeInteger(identity.nodeCount) ||
      !Number.isSafeInteger(identity.layerCount)) continue;
    const indexes = entry.dependencies as unknown[];
    if (!indexes.every((index) => Number.isSafeInteger(index) && usable[index as number])) continue;
    if (page.entries.has(file)) continue;
    page.entries.set(file, { context: entry.context, identity: {
      sourceVersion: identity.sourceVersion, surfaceCost: identity.surfaceCost ?? null,
      nodeCount: identity.nodeCount, layerCount: identity.layerCount,
    }, dependencies: indexes.map((index) => table[index as number]!) });
  }
}

function pageFor(workspacePath: string, directory: string, file: string): Page {
  const { key, name } = pageKey(workspacePath, directory, file);
  let page = pages.get(key);
  if (!page) {
    page = {
      file: durable() ? path.join(designPrivateStorageDirectory(workspacePath), name) : null,
      entries: new Map(),
      loaded: null,
      timer: null,
      writing: Promise.resolve(),
    };
    pages.set(key, page);
    while (pages.size > MAX_PAGES) {
      const [oldest, evicted] = pages.entries().next().value!;
      if (evicted.timer) clearTimeout(evicted.timer);
      pages.delete(oldest);
    }
  } else {
    pages.delete(key);
    pages.set(key, page);
  }
  page.loaded ??= load(workspacePath, page);
  return page;
}

function scheduleWrite(page: Page): void {
  if (!page.file || page.timer) return;
  page.timer = setTimeout(() => {
    page.timer = null;
    page.writing = page.writing.then(() => write(page)).catch(() => undefined);
  }, WRITE_DELAY_MS);
  page.timer.unref?.();
}

async function write(page: Page): Promise<void> {
  if (!page.file) return;
  const table: DurableDesignDependency[] = [];
  const indexes = new Map<string, number>();
  const entries: Record<string, { context: string; identity: DesignFrameIdentity; dependencies: number[] }> = {};
  for (const [file, entry] of page.entries) {
    if (!entry.dependencies) continue;
    entries[file] = { context: entry.context, identity: entry.identity, dependencies: entry.dependencies.map((dependency) => {
      const key = JSON.stringify([dependency.root, dependency.target, dependency.limit, dependency.fingerprint, dependency.policies]);
      let index = indexes.get(key);
      if (index === undefined) {
        index = table.push(dependency) - 1;
        indexes.set(key, index);
      }
      return index;
    }) };
  }
  await mkdir(path.dirname(page.file), { recursive: true, mode: 0o700 });
  // A lost or torn write is only a cache miss; the rename keeps readers whole.
  const temporary = `${page.file}.zeros-tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, build: engineBuild(), dependencies: table, entries }), { mode: 0o600 });
  await rename(temporary, page.file);
}

/** Identities one preparation pass reads: it shares fingerprints of files
 * that several frames read, such as stylesheets and style sources. */
export function designFrameIdentities(workspacePath: string, directory: string) {
  const memo = new Map<string, string | null>();
  return {
    async read(file: string, context: string): Promise<DesignFrameIdentity | null> {
      const page = pageFor(workspacePath, directory, file);
      await page.loaded;
      const entry = page.entries.get(file);
      const current = entry?.context === context &&
        (entry.dependencies ? durableDesignDependenciesCurrent(entry.dependencies, memo) : entry.current?.() === true);
      if (!current) {
        if (entry) page.entries.delete(file);
        testing.misses++;
        return null;
      }
      testing.hits++;
      return entry.identity;
    },
    remember(file: string, context: string, identity: DesignFrameIdentity,
      read: { complete: boolean; durable: DurableDesignDependency[] | null; current: () => boolean; targets?: string[] }): void {
      if (!read.complete) return;
      const page = pageFor(workspacePath, directory, file);
      page.entries.delete(file);
      page.entries.set(file, { context, identity, dependencies: read.durable,
        ...(read.durable ? {} : { current: read.current, ...(read.targets ? { targets: read.targets } : {}) }) });
      while (page.entries.size > MAX_PAGE_ENTRIES) page.entries.delete(page.entries.keys().next().value!);
      if (read.durable) scheduleWrite(page);
    },
  };
}

function* directoryEntries(workspacePath: string, directory: string): Generator<[string, Entry]> {
  const prefix = `${path.resolve(workspacePath)}\0${directory}\0`;
  for (const [key, page] of pages) if (key.startsWith(prefix)) yield* page.entries;
}

/** Frames of a directory whose remembered identity read one of `targets`
 * (absolute paths), including lookups that found nothing. `unknown` names
 * frames whose read set could not be stored, so no path can be ruled out.
 * This covers every frame the engine prepared since it started, which is
 * every frame a connected renderer holds: a renderer revalidates on connect. */
export function designFramesReading(workspacePath: string, directory: string,
  targets: ReadonlySet<string>): { frames: string[]; unknown: string[] } {
  const frames: string[] = [];
  const unknown: string[] = [];
  for (const [file, entry] of directoryEntries(workspacePath, directory)) {
    const read = entry.dependencies?.map((dependency) => dependency.target) ?? entry.targets;
    if (!read) unknown.push(file);
    else if (read.some((target) => targets.has(target))) frames.push(file);
  }
  return { frames, unknown };
}

/** Checkouts with remembered frame identities, by active directory. */
export function designIdentityDirectories(): Array<{ workspacePath: string; directory: string }> {
  const seen = new Map<string, { workspacePath: string; directory: string }>();
  for (const key of pages.keys()) {
    const [workspacePath, directory] = key.split("\0");
    if (workspacePath && directory !== undefined) seen.set(`${workspacePath}\0${directory}`, { workspacePath, directory });
  }
  return [...seen.values()];
}

/** Frames whose remembered identity no longer holds, by the same checks a
 * read makes, for changes no watcher reported (installed packages, ignored
 * folders, font downloads). Null past `limit` remembered frames. */
export async function designFramesWithStaleIdentities(workspacePath: string, directory: string,
  limit: number): Promise<string[] | null> {
  const entries = [...directoryEntries(workspacePath, directory)];
  if (entries.length > limit) return null;
  const memo = new Map<string, string | null>();
  const stale: string[] = [];
  for (const [index, [file, entry]] of entries.entries()) {
    // Fingerprints hash file bytes; give other engine work a turn now and then.
    if (index > 0 && index % 64 === 0) await new Promise((resolve) => setImmediate(resolve));
    const current = entry.dependencies ? durableDesignDependenciesCurrent(entry.dependencies, memo) : entry.current?.() === true;
    if (!current) stale.push(file);
  }
  return stale;
}

/** Test hooks: persistence, the build stamp, hit counts, and settling writes. */
export function configureDesignIdentityCacheForTests(options: { durable?: boolean | null; build?: string | null }): void {
  testing.durable = options.durable ?? null;
  testing.build = options.build ?? null;
}

export function designIdentityCacheStatsForTests(): { hits: number; misses: number } {
  return { hits: testing.hits, misses: testing.misses };
}

export async function flushDesignIdentityCacheForTests(): Promise<void> {
  for (const page of pages.values()) {
    if (page.timer) {
      clearTimeout(page.timer);
      page.timer = null;
      page.writing = page.writing.then(() => write(page)).catch(() => undefined);
    }
    await page.writing;
  }
}

/** Forget in-memory identities, as an engine restart does. */
export function resetDesignIdentityCacheForTests(): void {
  for (const page of pages.values()) if (page.timer) clearTimeout(page.timer);
  pages.clear();
}

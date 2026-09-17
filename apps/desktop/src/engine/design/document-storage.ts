import { DESIGN_MANIFEST_FILE, parseDesignManifest } from "./manifest";
import {
  DesignRenderBudgetError,
  MAX_DESIGN_TEXT_BYTES,
  utf8Bytes,
} from "./render-budget";
import { elementRecords } from "./source";
// ──────────────────────────────────────────────────────────
// Design document — portable HTML/CSS frames + app-owned canvas state
// ──────────────────────────────────────────────────────────
//
// A design workspace is still a Git worktree, but its authored surface is one
// deliberately small directory:
//
//   Zeros Design/*.html      one top-level file per frame
//   Zeros Design/*.css       shared authored styles
//   Zeros Design/tokens.css  typed design tokens + layout reset
//   Zeros Design/design.toml  stable identity, frame and Foundation metadata
//   Zeros Design/rules.md     short Design API ownership instructions
//
// This module is the single engine-side interpretation of that format. The
// renderer and first-party MCP server both consume these functions, so frame
// discovery, OID healing, constraints, and token parsing cannot drift.

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { migrateDesignFoundationManifest } from "@zeros/design-core";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { readDesignRegistrySource } from "./metadata";

import { designDirectoryNameFor } from "./directory-registry";
import {
  canvasReadSnapshot,
  type CanvasDocument,
  type DesignFrameGeometry,
  type FrameMeta,
} from "./document-model";
import {
  commitDesignMetadata,
  designDirectoryEntry,
  designDocumentMetadataPath,
  readDesignStorageFile,
  writePrivateDesignState,
  type DesignStorageChange,
} from "./metadata";
import { readSafeRegularFile } from "./safe-files";


const FRAME_MIN_WIDTH = 1;
const FRAME_MIN_HEIGHT = 1;
const FRAME_MAX_SIZE = 16_384;
export const MAX_FRAME_COUNT = 256;
export const DEFAULT_FRAME_WIDTH = 1_440;
export const DEFAULT_FRAME_HEIGHT = 900;
const FRAME_GRID_GAP = 120;
const FRAME_GRID_COLUMNS = 3;
const MAX_DESIGN_METADATA_BYTES = 16 * 1024 * 1024;

export function designDirectory(workspacePath: string): string {
  // The active folder comes from the per-workspace registry (primed from the
  // `[design] directory` pointer); split on "/" so a nested name like
  // "apps/web/designs" joins as real path segments on every platform.
  return path.join(
    path.resolve(workspacePath),
    ...designDirectoryNameFor(workspacePath).split("/"),
  );
}

function canvasPath(workspacePath: string): string {
  return designDocumentMetadataPath(
    workspacePath,
    designDirectoryNameFor(workspacePath),
  );
}

export function isFrameFile(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

export function assertFrameFile(value: string): string {
  if (!isFrameFile(value)) {
    throw new Error(`Invalid design frame file: ${value}`);
  }
  return value;
}

export function comparePortableNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function finiteBetween(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function normalizeGeometry(
  value: Partial<DesignFrameGeometry> | null | undefined,
  fallback: DesignFrameGeometry,
): DesignFrameGeometry {
  return {
    ...value,
    x: finiteBetween(value?.x, fallback.x, -1_000_000, 1_000_000),
    y: finiteBetween(value?.y, fallback.y, -1_000_000, 1_000_000),
    w: finiteBetween(value?.w, fallback.w, FRAME_MIN_WIDTH, FRAME_MAX_SIZE),
    h: finiteBetween(value?.h, fallback.h, FRAME_MIN_HEIGHT, FRAME_MAX_SIZE),
    z: Math.round(finiteBetween(value?.z, fallback.z, 0, MAX_FRAME_COUNT)),
  };
}

export async function readCanvas(workspacePath: string): Promise<CanvasDocument> {
  const registry = readDesignRegistrySource(workspacePath);
  const target = canvasPath(workspacePath);
  const file = path.relative(workspacePath, target).split(path.sep).join("/");
  const source = readDesignStorageFile(workspacePath, file);
  const retainSnapshot = (canvas: CanvasDocument): CanvasDocument =>
    Object.defineProperty(canvas, canvasReadSnapshot, {
      value: {
        registry: registry.source,
        registryFile: registry.file,
        file,
        source,
      },
    });
  const registered = designDirectoryEntry(
    workspacePath,
    designDirectoryNameFor(workspacePath),
  );
  if (
    registered &&
    readDesignStorageFile(
      workspacePath,
      `${registered.path}/.zeros-canvas.json`,
    ) !== null
  )
    throw new Error(
      "Both legacy and registered Design metadata exist. Resolve this conflict before editing.",
    );
  if (source === null) {
    if (registered || existsSync(target)) {
      throw new Error(
        "Design canvas metadata is unsafe or exceeds the 16 MiB limit.",
      );
    }
    return retainSnapshot({
      version: 3,
      frames: {},
      frame_info: {},
      foundation: migrateDesignFoundationManifest(undefined),
    });
  }
  let raw: {
    version?: unknown;
    frames?: unknown;
    view?: unknown;
    foundation?: unknown;
    frame_info?: unknown;
  };
  try {
    raw = (
      file.endsWith(`/${DESIGN_MANIFEST_FILE}`)
        ? parseDesignManifest(source)?.document
        : JSON.parse(source)
    ) as typeof raw;
  } catch {
    throw new Error("Design canvas metadata contains invalid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Design canvas metadata must be an object.");
  if (
    raw.version !== undefined &&
    raw.version !== 1 &&
    raw.version !== 2 &&
    raw.version !== 3
  ) {
    throw new Error(`Unsupported design canvas version: ${raw.version}`);
  }
  const sourceFrames =
    raw.frames && typeof raw.frames === "object"
      ? (raw.frames as Record<string, Partial<DesignFrameGeometry>>)
      : {};
  const frames: Record<string, DesignFrameGeometry> = {};
  if (
    (raw.frames !== undefined &&
      (!raw.frames ||
        typeof raw.frames !== "object" ||
        Array.isArray(raw.frames))) ||
    Object.keys(sourceFrames).length > MAX_FRAME_COUNT
  )
    throw new Error("Invalid Design frame metadata.");
  for (const [file, geometry] of Object.entries(sourceFrames).slice(
    0,
    MAX_FRAME_COUNT,
  )) {
    if (!isFrameFile(file)) {
      throw new Error("Invalid Design frame reference.");
    }
    const normalized = normalizeGeometry(geometry, {
      x: 0,
      y: 0,
      w: DEFAULT_FRAME_WIDTH,
      h: DEFAULT_FRAME_HEIGHT,
      z: 0,
    });
    if (
      raw.version === 3 &&
      (!geometry ||
        typeof geometry !== "object" ||
        Array.isArray(geometry) ||
        Object.entries(normalized).some(
          ([key, value]) =>
            ["x", "y", "w", "h", "z"].includes(key) &&
            geometry[key as keyof DesignFrameGeometry] !== value,
        ))
    )
      throw new Error("Invalid Design frame geometry.");
    frames[file] = normalized;
  }
  const view =
    raw.view && typeof raw.view === "object"
      ? (raw.view as Partial<NonNullable<CanvasDocument["view"]>>)
      : null;
  const frameInfo: CanvasDocument["frame_info"] = {};
  if (raw.frame_info !== undefined) {
    if (
      !raw.frame_info ||
      typeof raw.frame_info !== "object" ||
      Array.isArray(raw.frame_info)
    )
      throw new Error("Invalid Design frame information.");
    for (const [file, value] of Object.entries(raw.frame_info)) {
      const info = value as Partial<FrameMeta> | null;
      if (
        !isFrameFile(file) ||
        !Object.hasOwn(frames, file) ||
        !info ||
        typeof info.title !== "string" ||
        info.title.length > 120 ||
        !["frame", "text"].includes(String(info.kind))
      )
        throw new Error("Invalid Design frame information reference.");
      frameInfo[file] = {
        ...info,
        title: info.title,
        kind: info.kind as FrameMeta["kind"],
      };
    }
  }
  const { view: _legacyView, ...preserved } = raw;
  return retainSnapshot({
    ...preserved,
    version: 3,
    frames,
    frame_info: frameInfo,
    foundation: migrateDesignFoundationManifest(raw.foundation),
    ...(view
      ? {
          view: {
            x: finiteBetween(view.x, 0, -1_000_000, 1_000_000),
            y: finiteBetween(view.y, 0, -1_000_000, 1_000_000),
            zoom: finiteBetween(view.zoom, 1, 0.02, 64),
          },
        }
      : {}),
  });
}

export async function writeCanvas(
  workspacePath: string,
  canvas: CanvasDocument,
  sourceChanges: DesignStorageChange[] = [],
): Promise<string[]> {
  const directory = designDirectoryNameFor(workspacePath);
  if (!designDirectoryEntry(workspacePath, directory)) {
    for (const relative of ["assets/.gitkeep", "components/.gitkeep"]) {
      const file = `${directory}/${relative}`;
      if (readDesignStorageFile(workspacePath, file) === "")
        sourceChanges.push({ file, before: "", after: null });
    }
    const files = new Set([
      ...(await discoverFrameFiles(workspacePath)),
      ...sourceChanges
        .map((change) => change.file.slice(directory.length + 1))
        .filter(isFrameFile),
    ]);
    for (const file of files) {
      const changeIndex = sourceChanges.findIndex(
        (change) => change.file === `${directory}/${file}`,
      );
      const pending = sourceChanges[changeIndex];
      if (pending?.after === null) continue;
      const source =
        pending?.after ??
        (await readBoundedDesignFrameSource(workspacePath, file));
      const document = parse(source, { sourceCodeLocationInfo: true });
      const meta = readFrameMeta(document, file, canvas);
      canvas.frames[file] ??= nextFrameGeometry(
        Object.values(canvas.frames),
        meta,
      );
      canvas.frame_info[file] = {
        ...canvas.frame_info[file],
        title: meta.title,
        kind: meta.kind,
      };
      const after = stripLegacyFrameMeta(source, document);
      if (pending) sourceChanges[changeIndex] = { ...pending, after };
      else if (source !== after)
        sourceChanges.push({
          file: `${directory}/${file}`,
          before: source,
          after,
        });
    }
  }
  const { view, ...tracked } = canvas;
  if (view)
    writePrivateDesignState(
      workspacePath,
      `view-${createHash("sha256").update(designDirectoryNameFor(workspacePath)).digest("hex").slice(0, 24)}.json`,
      JSON.stringify(view),
    );
  const source = `${JSON.stringify(tracked, null, 2)}\n`;
  if (utf8Bytes(source) > MAX_DESIGN_METADATA_BYTES) {
    throw new Error("Design canvas metadata exceeds the 16 MiB limit.");
  }
  return commitDesignMetadata(
    workspacePath,
    designDirectoryNameFor(workspacePath),
    source,
    sourceChanges,
    canvas[canvasReadSnapshot],
  );
}

export function nextFrameGeometry(
  existing: DesignFrameGeometry[],
  meta: { width: number; height: number },
): DesignFrameGeometry {
  const index = existing.length;
  const column = index % FRAME_GRID_COLUMNS;
  const row = Math.floor(index / FRAME_GRID_COLUMNS);
  const widest = Math.max(
    meta.width,
    ...existing.map((geometry) => geometry.w),
  );
  const tallest = Math.max(
    meta.height,
    ...existing.map((geometry) => geometry.h),
  );
  return {
    x: column * (widest + FRAME_GRID_GAP),
    y: row * (tallest + FRAME_GRID_GAP),
    w: meta.width,
    h: meta.height,
    z: index,
  };
}

export function readFrameMeta(
  document: DefaultTreeAdapterTypes.Document,
  file: string,
  canvas?: CanvasDocument,
): FrameMeta {
  let content = "";
  for (const { element } of elementRecords(document)) {
    if (element.tagName !== "meta") continue;
    const name = element.attrs.find((attribute) => attribute.name === "name");
    if (name?.value !== "zeros-frame") continue;
    content =
      element.attrs.find((attribute) => attribute.name === "content")?.value ??
      "";
    break;
  }
  const numberValue = (key: string, fallback: number): number => {
    const match = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*([0-9.]+)`, "i").exec(
      content,
    );
    return finiteBetween(
      match ? Number(match[1]) : undefined,
      fallback,
      key === "width" ? FRAME_MIN_WIDTH : FRAME_MIN_HEIGHT,
      FRAME_MAX_SIZE,
    );
  };
  const titleMatch = /(?:^|,)\s*title\s*=\s*(.+)$/i.exec(content);
  const kindMatch = /(?:^|,)\s*kind\s*=\s*(frame|text)(?:\s*,|\s*$)/i.exec(
    content,
  );
  return {
    title:
      canvas?.frame_info[file]?.title ||
      titleMatch?.[1]?.trim().slice(0, 120) ||
      elementRecords(document)
        .find(({ element }) => element.tagName === "title")
        ?.element.childNodes.map((node) => ("value" in node ? node.value : ""))
        .join("")
        .trim()
        .slice(0, 120) ||
      file.replace(/\.html$/i, "").replace(/[-_]+/g, " "),
    width: canvas?.frames[file]?.w ?? numberValue("width", DEFAULT_FRAME_WIDTH),
    height:
      canvas?.frames[file]?.h ?? numberValue("height", DEFAULT_FRAME_HEIGHT),
    kind:
      canvas?.frame_info[file]?.kind ??
      (kindMatch?.[1]?.toLowerCase() === "text" ? "text" : "frame"),
  };
}

export function stripLegacyFrameMeta(
  source: string,
  document: DefaultTreeAdapterTypes.Document,
): string {
  const locations = elementRecords(document)
    .filter(
      ({ element }) =>
        element.tagName === "meta" &&
        element.attrs.some(
          (attr) => attr.name === "name" && attr.value === "zeros-frame",
        ),
    )
    .flatMap(({ element }) =>
      element.sourceCodeLocation ? [element.sourceCodeLocation] : [],
    );
  let result = source;
  for (const location of locations.sort(
    (a, b) => b.startOffset - a.startOffset,
  ))
    result =
      result.slice(0, location.startOffset) + result.slice(location.endOffset);
  return result;
}

export async function discoverFrameFiles(workspacePath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(designDirectory(workspacePath), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && isFrameFile(entry.name))
    .map((entry) => entry.name)
    .sort(comparePortableNames)
    .slice(0, MAX_FRAME_COUNT);
}

export async function readBoundedDesignFrameSource(
  workspacePath: string,
  frame: string,
): Promise<string> {
  const file = assertFrameFile(frame);
  const directory = designDirectory(workspacePath);
  const safe = await readSafeRegularFile(
    directory,
    path.join(directory, file),
    MAX_DESIGN_TEXT_BYTES,
  );
  if (!safe) {
    throw new DesignRenderBudgetError(
      `Design frame is missing, unsafe, or exceeds 2 MiB: ${file}`,
    );
  }
  return safe.body.toString("utf8");
}

export async function atomicWriteDesignSource(
  target: string,
  source: string,
): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.zeros-tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => {
      // Some filesystems do not permit fsync on directories. The file itself
      // was still synced before rename, so retain portability while taking the
      // stronger durability guarantee wherever the host supports it.
    });
  } finally {
    await handle.close().catch(() => {});
  }
}

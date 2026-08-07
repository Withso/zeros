// ──────────────────────────────────────────────────────────
// Design workspace cache — exact workspace snapshot server state
// ──────────────────────────────────────────────────────────
//
// Canvas, inspector, and the lower Layers panel consume one aggregate engine
// response. Keeping it in a bounded keyed cache prevents those siblings from
// issuing independent bridge requests and preserves the last confirmed canvas
// while a disk edit revalidates in the background.

import {
  designApplyTransaction,
  designCreateFrame,
  designDeleteFrame,
  designDuplicateFrame,
  designFrame,
  designInsertAsset,
  designFoundationOpen,
  designHistory,
  designRenameFrame,
  designSave,
  designSetText,
  designSnapshot,
  designUpdateToken,
  designUpdateCanvas,
  designUpdateStyles,
  type DesignFrameGeometryWire,
  type DesignFrameDocumentWire,
  type DesignFoundationOpenWire,
  type DesignApiMutationReplyWire,
  type DesignFrameSummaryWire,
  type DesignMutationResultWire,
  type DesignWorkspaceSnapshotWire,
} from "../../../platform/git";
import type { DesignTransaction } from "@zeros/design-core";
import { KeyedAsyncCache } from "../../../shared/lib/keyed-async-cache";

export const DESIGN_SNAPSHOT_MAX_AGE_MS = 10_000;
const DESIGN_SNAPSHOT_CACHE_BYTES = 64 * 1024 * 1024;
const DESIGN_FRAME_DOCUMENT_CACHE_BYTES = 64 * 1024 * 1024;
const DESIGN_FOUNDATION_CACHE_BYTES = 32 * 1024 * 1024;

const retainedMemoryByObject = new WeakMap<object, number>();

/** Approximate immutable wire payload memory without allocating a second full
 * JSON string. Structural sharing makes unchanged arrays and records O(1) to
 * remeasure across mutation publications. */
function retainedMemory(value: unknown): number {
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "boolean") return 4;
  if (!value || typeof value !== "object") return 0;
  const cached = retainedMemoryByObject.get(value);
  if (cached !== undefined) return cached;
  retainedMemoryByObject.set(value, 0);
  let total = Array.isArray(value) ? 24 : 32;
  if (Array.isArray(value)) {
    for (const item of value) total += retainedMemory(item);
  } else {
    for (const [key, item] of Object.entries(value)) {
      total += key.length * 2 + retainedMemory(item);
    }
  }
  retainedMemoryByObject.set(value, total);
  return total;
}

export const designWorkspaceSnapshotCache =
  new KeyedAsyncCache<DesignWorkspaceSnapshotWire>({
    maxEntries: 32,
    maxWeight: DESIGN_SNAPSHOT_CACHE_BYTES,
    weightOf: retainedMemory,
  });
/** Full authored/srcDoc payloads exist only for non-protocol fallbacks and are
 * bounded to roughly the same order as the live iframe window. */
export const designFrameDocumentCache =
  new KeyedAsyncCache<DesignFrameDocumentWire>({
    maxEntries: 16,
    maxWeight: DESIGN_FRAME_DOCUMENT_CACHE_BYTES,
    weightOf: (document) =>
      document.source.length * 2 +
      document.srcDoc.length * 2 +
      retainedMemory(document.tree),
  });
export const designFoundationCache =
  new KeyedAsyncCache<DesignFoundationOpenWire>({
    maxEntries: 64,
    maxWeight: DESIGN_FOUNDATION_CACHE_BYTES,
    weightOf: retainedMemory,
  });

const FOUNDATION_KEY_SEPARATOR = "\u0000";
const FRAME_DOCUMENT_KEY_SEPARATOR = "\u0000";
export const DESIGN_FRAME_DOCUMENT_MAX_AGE_MS = 60_000;

export function designFrameDocumentKey(
  workspaceId: string,
  frame: string,
  sourceVersion: string,
): string {
  return [workspaceId, frame, sourceVersion].join(FRAME_DOCUMENT_KEY_SEPARATOR);
}

export async function fetchDesignFrameDocument(
  key: string,
): Promise<DesignFrameDocumentWire> {
  const [workspaceId, frame, sourceVersion, ...extra] = key.split(
    FRAME_DOCUMENT_KEY_SEPARATOR,
  );
  if (
    !workspaceId ||
    !frame ||
    !/^[a-f0-9]{24}$/.test(sourceVersion ?? "") ||
    extra.length > 0
  ) {
    throw new Error("Invalid design frame document cache key.");
  }
  const document = await designFrame(workspaceId, frame);
  if (document.sourceVersion !== sourceVersion) {
    throw new Error("Design frame changed while its fallback was loading.");
  }
  return document;
}

export function designFoundationKey(
  workspaceId: string,
  frame: string,
  sourceVersion: string,
): string {
  return [workspaceId, frame, sourceVersion].join(FOUNDATION_KEY_SEPARATOR);
}

export async function fetchDesignFoundation(
  key: string,
): Promise<DesignFoundationOpenWire> {
  const [workspaceId, frame, sourceVersion, ...extra] = key.split(
    FOUNDATION_KEY_SEPARATOR,
  );
  if (
    !workspaceId ||
    !frame ||
    !/^[a-f0-9]{24}$/.test(sourceVersion ?? "") ||
    extra.length > 0
  ) {
    throw new Error("Invalid design foundation cache key.");
  }
  return designFoundationOpen(workspaceId, frame);
}

function invalidateDesignFoundation(workspaceId: string, frame: string): void {
  const prefix = `${workspaceId}${FOUNDATION_KEY_SEPARATOR}${frame}${FOUNDATION_KEY_SEPARATOR}`;
  for (const key of designFoundationCache.keys()) {
    if (key.startsWith(prefix)) designFoundationCache.invalidate(key);
  }
}

function invalidateWorkspaceDesignFoundations(workspaceId: string): void {
  const prefix = `${workspaceId}${FOUNDATION_KEY_SEPARATOR}`;
  for (const key of designFoundationCache.keys()) {
    if (key.startsWith(prefix)) designFoundationCache.invalidate(key);
  }
}

function sameFrame(
  left: DesignWorkspaceSnapshotWire["frames"][number],
  right: DesignWorkspaceSnapshotWire["frames"][number],
): boolean {
  return (
    left.file === right.file &&
    left.title === right.title &&
    left.width === right.width &&
    left.height === right.height &&
    left.x === right.x &&
    left.y === right.y &&
    left.z === right.z &&
    left.nodeCount === right.nodeCount &&
    left.modifiedAt === right.modifiedAt &&
    left.sourceVersion === right.sourceVersion
  );
}

function sameToken(
  left: DesignWorkspaceSnapshotWire["tokens"][number],
  right: DesignWorkspaceSnapshotWire["tokens"][number],
): boolean {
  return (
    left.name === right.name &&
    left.syntax === right.syntax &&
    left.inherits === right.inherits &&
    left.initialValue === right.initialValue &&
    left.value === right.value &&
    Object.keys(left.themeValues).length ===
      Object.keys(right.themeValues).length &&
    Object.entries(left.themeValues).every(
      ([theme, value]) => right.themeValues[theme] === value,
    ) &&
    left.usageCount === right.usageCount &&
    left.line === right.line
  );
}

function sameAsset(
  left: DesignWorkspaceSnapshotWire["assets"][number],
  right: DesignWorkspaceSnapshotWire["assets"][number],
): boolean {
  return (
    left.path === right.path &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.dataUrl === right.dataUrl
  );
}

function sameViolation(
  left: DesignWorkspaceSnapshotWire["lint"]["violations"][number],
  right: DesignWorkspaceSnapshotWire["lint"]["violations"][number],
): boolean {
  return (
    left.ruleId === right.ruleId &&
    left.severity === right.severity &&
    left.message === right.message &&
    left.file === right.file &&
    left.line === right.line &&
    left.column === right.column &&
    left.oid === right.oid &&
    left.fix === right.fix
  );
}

function stableArray<T>(
  previous: readonly T[],
  next: readonly T[],
  equal: (left: T, right: T) => boolean,
): T[] {
  if (previous.length !== next.length) return [...next];
  let changed = false;
  const stable = next.map((value, index) => {
    const prior = previous[index];
    if (prior !== undefined && equal(prior, value)) return prior;
    changed = true;
    return value;
  });
  return changed ? stable : (previous as T[]);
}

/** Structurally share unchanged frames/tokens/lint rows so a CSS edit in one
 * frame does not remount every other iframe or rerender the whole Layers list. */
export function stabilizeDesignWorkspaceSnapshot(
  previous: DesignWorkspaceSnapshotWire | undefined,
  next: DesignWorkspaceSnapshotWire,
): DesignWorkspaceSnapshotWire {
  if (!previous) return next;
  const frames = stableArray(previous.frames, next.frames, sameFrame);
  const tokens = stableArray(previous.tokens, next.tokens, sameToken);
  const assets = stableArray(previous.assets, next.assets, sameAsset);
  const violations = stableArray(
    previous.lint.violations,
    next.lint.violations,
    sameViolation,
  );
  const lint =
    violations === previous.lint.violations &&
    previous.lint.workspacePath === next.lint.workspacePath &&
    previous.lint.healedOids === next.lint.healedOids &&
    previous.lint.checkedFiles.length === next.lint.checkedFiles.length &&
    previous.lint.checkedFiles.every(
      (file, index) => file === next.lint.checkedFiles[index],
    )
      ? previous.lint
      : { ...next.lint, violations };
  return frames === previous.frames &&
    next.protocolCapability === previous.protocolCapability &&
    tokens === previous.tokens &&
    next.tokenSourceVersion === previous.tokenSourceVersion &&
    assets === previous.assets &&
    lint === previous.lint
    ? previous
    : {
        protocolCapability: next.protocolCapability,
        frames,
        tokens,
        tokenSourceVersion: next.tokenSourceVersion,
        assets,
        lint,
      };
}

function publishDesignWorkspaceSnapshot(
  workspaceId: string,
  next: DesignWorkspaceSnapshotWire,
): DesignWorkspaceSnapshotWire {
  const stable = stabilizeDesignWorkspaceSnapshot(
    designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data,
    next,
  );
  designWorkspaceSnapshotCache.setData(workspaceId, stable);
  return stable;
}

export async function fetchDesignWorkspaceSnapshot(
  workspaceId: string,
): Promise<DesignWorkspaceSnapshotWire> {
  const next = await designSnapshot(workspaceId);
  return stabilizeDesignWorkspaceSnapshot(
    designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data,
    next,
  );
}

export function warmDesignWorkspaceSnapshot(workspaceId: string): void {
  void designWorkspaceSnapshotCache
    .load(workspaceId, () => fetchDesignWorkspaceSnapshot(workspaceId), {
      maxAgeMs: DESIGN_SNAPSHOT_MAX_AGE_MS,
    })
    .catch(() => {});
}

export function invalidateDesignWorkspaceSnapshot(workspaceId: string): void {
  designWorkspaceSnapshotCache.invalidate(workspaceId);
  // External canvas/manifest edits can change the authored revision without
  // changing a frame's rendered sourceVersion, so those exact keys are stale.
  invalidateWorkspaceDesignFoundations(workspaceId);
}

export async function refreshDesignWorkspaceSnapshot(
  workspaceId: string,
): Promise<DesignWorkspaceSnapshotWire> {
  return designWorkspaceSnapshotCache.load(
    workspaceId,
    () => fetchDesignWorkspaceSnapshot(workspaceId),
    { force: true },
  );
}

/** Publish the mutation's exact aggregate response without a second bridge
 * round trip on the click path. */
export async function createDesignFrameAndRefresh(
  workspaceId: string,
  title?: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  const result = await designCreateFrame(workspaceId, title);
  return {
    frame: result.frame,
    snapshot: publishDesignWorkspaceSnapshot(workspaceId, result.snapshot),
  };
}

export async function renameDesignFrameAndRefresh(
  workspaceId: string,
  frame: string,
  title: string,
): Promise<DesignWorkspaceSnapshotWire> {
  const result = await designRenameFrame(workspaceId, frame, title);
  return publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
}

export async function duplicateDesignFrameCached(
  workspaceId: string,
  frame: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  const result = await designDuplicateFrame(workspaceId, frame);
  return {
    frame: result.frame,
    snapshot: publishDesignWorkspaceSnapshot(workspaceId, result.snapshot),
  };
}

export async function deleteDesignFrameCached(
  workspaceId: string,
  frame: string,
): Promise<DesignWorkspaceSnapshotWire> {
  const result = await designDeleteFrame(workspaceId, frame);
  return publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
}

export async function updateDesignNodeStylesCached(
  workspaceId: string,
  input: {
    frame: string;
    nodeId: string;
    sourceVersion: string;
    styles: Record<string, string | null>;
  },
): Promise<DesignMutationResultWire> {
  const result = await designUpdateStyles(workspaceId, input);
  publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
  return result.mutation;
}

export async function setDesignNodeTextCached(
  workspaceId: string,
  input: {
    frame: string;
    nodeId: string;
    sourceVersion: string;
    text: string;
  },
): Promise<DesignMutationResultWire> {
  const result = await designSetText(workspaceId, input);
  publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
  return result.mutation;
}

export async function insertDesignAssetCached(
  workspaceId: string,
  input: {
    frame: string;
    sourceVersion: string;
    assetPath: string;
    x: number;
    y: number;
  },
): Promise<DesignMutationResultWire> {
  const result = await designInsertAsset(workspaceId, input);
  publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
  return result.mutation;
}

export async function saveDesigns(
  workspaceId: string,
): Promise<{ sha: string; branch: string }> {
  const result = await designSave(workspaceId);
  invalidateDesignWorkspaceSnapshot(workspaceId);
  return result;
}

export async function updateDesignTokenCached(
  workspaceId: string,
  input: {
    frame: string;
    name: string;
    theme: string | null;
    value: string;
    sourceVersion: string;
  },
): Promise<DesignWorkspaceSnapshotWire> {
  const result = await designUpdateToken(workspaceId, input);
  const snapshot = publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
  invalidateDesignFoundation(workspaceId, input.frame);
  return snapshot;
}

/** Geometry is already complete in the mutation response. Publish it directly
 * so drag release cannot snap back while a bridge refresh is in flight. */
export async function updateDesignFrameGeometryCached(
  workspaceId: string,
  frameFile: string,
  geometry: DesignFrameGeometryWire,
): Promise<DesignFrameGeometryWire> {
  const result = await designUpdateCanvas(workspaceId, frameFile, geometry);
  publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
  invalidateDesignFoundation(workspaceId, frameFile);
  return result.geometry;
}

export async function applyDesignTransactionCached(
  workspaceId: string,
  frame: string,
  transaction: DesignTransaction,
): Promise<DesignApiMutationReplyWire> {
  const result = await designApplyTransaction(workspaceId, frame, transaction);
  if (result.snapshot) {
    publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
  }
  invalidateDesignFoundation(workspaceId, frame);
  return result;
}

export async function applyDesignHistoryCached(
  workspaceId: string,
  frame: string,
  direction: "undo" | "redo",
): Promise<DesignApiMutationReplyWire> {
  const result = await designHistory(workspaceId, frame, direction);
  if (result.snapshot) {
    publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
  }
  invalidateDesignFoundation(workspaceId, frame);
  return result;
}

/** Test-only reset for exact-key/reference-stability coverage. */
export function resetDesignWorkspaceCacheForTests(): void {
  designWorkspaceSnapshotCache.clear();
  designFrameDocumentCache.clear();
  designFoundationCache.clear();
  refreshVersionByWorkspace.clear();
}

const refreshVersionByWorkspace = new Map<string, number>();

/** Coalesce two sibling hook mounts observing the same Git generation into one
 * cache invalidation. The map is bounded with the same LRU key discipline as
 * the snapshot cache. */
export function applyDesignWorkspaceRefreshVersion(
  workspaceId: string,
  refreshVersion: number,
): void {
  const previous = refreshVersionByWorkspace.get(workspaceId);
  refreshVersionByWorkspace.delete(workspaceId);
  refreshVersionByWorkspace.set(workspaceId, refreshVersion);
  while (refreshVersionByWorkspace.size > 64) {
    const oldest = refreshVersionByWorkspace.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    refreshVersionByWorkspace.delete(oldest);
  }
  if (previous === undefined || previous === refreshVersion) return;
  invalidateDesignWorkspaceSnapshot(workspaceId);
}

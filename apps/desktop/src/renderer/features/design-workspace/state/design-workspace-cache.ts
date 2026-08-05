// ──────────────────────────────────────────────────────────
// Design workspace cache — exact workspace snapshot server state
// ──────────────────────────────────────────────────────────
//
// Canvas, inspector, and the lower Layers panel consume one aggregate engine
// response. Keeping it in a bounded keyed cache prevents those siblings from
// issuing independent bridge requests and preserves the last confirmed canvas
// while a disk edit revalidates in the background.

import {
  designCreateFrame,
  designDeleteFrame,
  designDuplicateFrame,
  designInsertAsset,
  designRenameFrame,
  designSave,
  designSetText,
  designSnapshot,
  designUpdateToken,
  designUpdateCanvas,
  designUpdateStyles,
  type DesignFrameGeometryWire,
  type DesignFrameSummaryWire,
  type DesignMutationResultWire,
  type DesignWorkspaceSnapshotWire,
} from "../../../platform/git";
import { KeyedAsyncCache } from "../../../shared/lib/keyed-async-cache";

export const DESIGN_SNAPSHOT_MAX_AGE_MS = 10_000;
export const designWorkspaceSnapshotCache =
  new KeyedAsyncCache<DesignWorkspaceSnapshotWire>(32);

function sameTree(
  left: DesignWorkspaceSnapshotWire["frames"][number]["tree"],
  right: DesignWorkspaceSnapshotWire["frames"][number]["tree"],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      !a ||
      !b ||
      a.tag !== b.tag ||
      a.oid !== b.oid ||
      a.text !== b.text ||
      !sameTree(a.children, b.children)
    ) {
      return false;
    }
  }
  return true;
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
    left.sourceVersion === right.sourceVersion &&
    left.source === right.source &&
    left.srcDoc === right.srcDoc &&
    sameTree(left.tree, right.tree)
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
    name: string;
    theme: string | null;
    value: string;
    sourceVersion: string;
  },
): Promise<DesignWorkspaceSnapshotWire> {
  const result = await designUpdateToken(workspaceId, input);
  return publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
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
  return result.geometry;
}

/** Test-only reset for exact-key/reference-stability coverage. */
export function resetDesignWorkspaceCacheForTests(): void {
  designWorkspaceSnapshotCache.clear();
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

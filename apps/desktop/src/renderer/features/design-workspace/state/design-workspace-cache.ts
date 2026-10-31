import { useDesignWorkspaceUiStore } from "./design-workspace-ui";
import type { DesignMovementGuard } from "@zeros/protocol/design-relocation";
import { normalizeDesignPagesSnapshot } from "@zeros/protocol/design-pages";
import { forgetDesignLayerDisclosure } from "./design-layer-disclosure";
import { rememberDesignDirectoryIdentity } from "../../../platform/bridge/design-bridge";
// Canvas, inspector and the Layers panel consume one aggregate engine response.
// A bounded keyed cache stops those siblings issuing independent bridge requests
// and keeps the last confirmed canvas while a disk edit revalidates.

import { designBackgroundWork } from "./design-background-work";
import {
  designApplyTransaction,
  designCommit,
  designCreateFrame,
  designDeleteFrame,
  designDuplicateFrame,
  designCreatePage,
  designRenamePage,
  designUpdateTheme,
  designRefreshStyles,
  designDeletePage,
  designFrame,
  designInsertAsset,
  designFoundationOpen,
  designHistory,
  designRenameFrame,
  designSave,
  designStage,
  designSetText,
  designSnapshot,
  designPrepareFrames,
  designUpdateToken,
  designUpdateCanvas,
  designMoveFrames,
  designUpdateStyles,
  designTransferNode,
  designWriteHtml,
  type DesignCanvasFrameWire,
  type DesignFrameGeometryWire,
  type DesignTextFrameSeedWire,
  type DesignFrameDocumentWire,
  type DesignFoundationRevisionWire,
  type DesignFoundationOpenWire,
  type DesignApiMutationReplyWire,
  type DesignFrameSummaryWire,
  type DesignLintViolationWire,
  type DesignMutationResultWire,
  type DesignWorkspaceSnapshotWire,
} from "../../../platform/git";
import type { DesignTransaction } from "@zeros/design-core";
import type { DesignRuntimeGenerationPatch, DesignRuntimeNodeInsert } from "@zeros/protocol/design-runtime";
import { KeyedAsyncCache } from "../../../shared/lib/keyed-async-cache";
import { DesignFramePreparation, readDesignNavigation, projectDesignMutationSnapshot } from "./design-workspace-preparation";
import { preparedDesignSnapshot } from "./design-frame-view";
import { onActiveBridgeConnected } from "../../../platform/bridge/active-bridge";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { classifyRpcError } from "../../../platform/bridge/failure";
import { designFrameRuntime } from "../../../platform/bridge/design-frame-runtime";
import { designStylePropertyAffectsLayout } from "../design-style-values";
import { DesignHistoryPreview, type DesignHistoryPrediction } from "./design-history-preview";
import {
  clearDesignHistoryPresentation,
  presentDesignHistory,
  presentDesignHistoryRuntime,
  setDesignHistoryPresentationOwnerReader,
} from "./design-history-presentation";
import { clearCommittedDesignLivePreviewStyles, designLivePreviewSequence } from "./design-live-preview";
import { designSourceVectorCache } from "../design-source-vector";
import {
  designRuntimeFrameState,
  useDesignRuntimeStore,
} from "./design-runtime-store";
import {
  captureDesignRuntimeScreenshot,
  notifyDesignSelectionSnapshot,
  persistDesignRuntimeAuditSnapshot,
  setDesignSelectionSnapshotReader,
} from "./design-selection";
import {
  queueDesignWorkspaceBootSnapshot,
  readDesignWorkspaceBootSnapshots,
  resetDesignWorkspaceBootCacheForTests,
} from "./design-workspace-boot-cache";

export const DESIGN_SNAPSHOT_MAX_AGE_MS = 10_000;
const DESIGN_SNAPSHOT_CACHE_BYTES = 64 * 1024 * 1024;
const DESIGN_FRAME_DOCUMENT_CACHE_BYTES = 64 * 1024 * 1024;
const DESIGN_FOUNDATION_CACHE_BYTES = 32 * 1024 * 1024;

const retainedMemoryByObject = new WeakMap<object, number>();
const pendingAdoptedSettlementByFrame = new Map<string, () => void>();
const pendingLocalMutationByWorkspace = new Map<
  string,
  { depth: number; deferredRefresh: boolean }
>();
const localMutationTailByWorkspace = new Map<string, Promise<void>>();
const editLifetimeListeners = new Map<string, Set<() => void>>();
export function hasPendingDesignEdits(workspaceId: string): boolean {
  return pendingLocalMutationByWorkspace.has(workspaceId) || localMutationTailByWorkspace.has(workspaceId);
}
export function subscribePendingDesignEdits(workspaceId: string, listener: () => void): () => void {
  let listeners = editLifetimeListeners.get(workspaceId);
  if (!listeners) editLifetimeListeners.set(workspaceId, (listeners = new Set()));
  listeners.add(listener);
  return () => {
    listeners!.delete(listener);
    if (!listeners!.size) editLifetimeListeners.delete(workspaceId);
  };
}
function publishEditLifetime(workspaceId: string): void {
  for (const listener of editLifetimeListeners.get(workspaceId) ?? []) listener();
  designFramePreparation.resume();
}
const localFrameGenerationByOwner = new Map<
  string,
  { current: string; ancestors: string[] }
>();
const localTokenGenerationByWorkspace = new Map<
  string,
  { current: string; ancestors: string[] }
>();
const localFoundationRevisionByFrame = new Map<
  string,
  { current: string; ancestors: string[] }
>();
/** Compatibility mutations return exact authored lineage on current engines.
 * Keep a bounded fallback set for older engines and for sibling documents
 * whose shared files changed but whose new document revision is not in the
 * mutation reply. Those frames are refreshed lazily before their next write. */
const staleFoundationRevisionByFrame = new Set<string>();
const retainedRuntimeAuditByFrame = new Map<
  string,
  {
    workspaceId: string;
    frame: string;
    sourceVersion: string;
    violations: readonly DesignLintViolationWire[];
  }
>();
const runtimeAuditSettlementByFrame = new Map<
  string,
  { fingerprint: string; result: Promise<void> }
>();
const RUNTIME_AUDIT_RULE_IDS = new Set([
  "contrast",
  "overflow",
  "spacing-scale",
  "audit-limit",
  "layer-tree-limit",
]);

/** Design reads are idempotent and exact-keyed, so a single transport bounce
 * can be retried safely. Keep this boundary away from mutations: their reply
 * may time out after the authored write landed, and replaying those would
 * double-apply history or structure changes. */
async function executeDesignReadWithTransientRetry<T>(
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const kind = classifyRpcError(error).kind;
    if (
      kind !== "timeout" &&
      kind !== "transport-closed" &&
      kind !== "lifecycle-superseded"
    ) {
      throw error;
    }
    return await read();
  }
}

/** A filesystem watcher can observe an authored write before its bridge reply
 * reaches the renderer. Hold that echo until the reply has promoted the live
 * runtime and published its aggregate snapshot, otherwise the eager refresh
 * exposes a new iframe URL for one paint and defeats in-place adoption. */
function beginLocalDesignMutation(workspaceId: string): () => void {
  const entry = pendingLocalMutationByWorkspace.get(workspaceId) ?? {
    depth: 0,
    deferredRefresh: false,
  };
  entry.depth += 1;
  pendingLocalMutationByWorkspace.set(workspaceId, entry);
  publishEditLifetime(workspaceId);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const current = pendingLocalMutationByWorkspace.get(workspaceId);
    if (!current) return;
    current.depth = Math.max(0, current.depth - 1);
    if (current.depth > 0) return;
    pendingLocalMutationByWorkspace.delete(workspaceId);
    if (current.deferredRefresh) {
      // The mutation response is authoritative for its own write. Revalidate
      // once afterward so a coalesced external edit is still observed, while
      // retaining the now-adopted exact generation during that read.
      designWorkspaceSnapshotCache.invalidate(workspaceId);
    }
  };
}

const historyPreview = new DesignHistoryPreview();
const historyOwnerKey = (snapshot: DesignWorkspaceSnapshotWire | null | undefined) => [
  snapshot?.directoryId, snapshot?.directory, snapshot?.lint.workspacePath, snapshot?.protocolCapability,
];
const historyStateKey = (
  snapshot: DesignWorkspaceSnapshotWire | null | undefined,
) => {
  // Navigation normalizes the legacy one-page wire shape. Mutation replies
  // from the same engine may still omit it; key their identical authored
  // state consistently without discarding real page/catalog differences.
  const normalized = snapshot ? normalizeDesignPagesSnapshot(snapshot) : undefined;
  return JSON.stringify(
    [historyOwnerKey(snapshot), normalized?.frames.map((frame) => [
      frame.file,
      frame.sourceVersion,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      frame.z,
      frame.title,
      frame.frameId,
      frame.pageId,
    ]) ?? [], normalized?.pages ?? [], snapshot?.tokenSourceVersion, snapshot?.themes ?? []],
  );
};

function historyGeometry(snapshot: DesignWorkspaceSnapshotWire, files?: ReadonlySet<string>) {
  return new Map(snapshot.frames.filter(frame => !files || files.has(frame.file)).map(frame => [frame.file, {
    x: frame.x, y: frame.y, w: frame.width, h: frame.height, z: frame.z,
  }]));
}
function changedHistoryGeometry(before: DesignWorkspaceSnapshotWire | null | undefined, after: DesignWorkspaceSnapshotWire) {
  if (!before) return undefined;
  const files = new Set(after.frames.filter(frame => {
    const previous = before.frames.find(candidate => candidate.file === frame.file);
    return previous && [frame.x, frame.y, frame.width, frame.height, frame.z].some((value, index) =>
      value !== [previous.x, previous.y, previous.width, previous.height, previous.z][index]);
  }).map(frame => frame.file));
  return files.size ? { before: historyGeometry(before, files), after: historyGeometry(after, files) } : undefined;
}
function recordGeometryHistory(workspaceId: string, before: DesignWorkspaceSnapshotWire | null | undefined, after: DesignWorkspaceSnapshotWire) {
  const geometry = changedHistoryGeometry(before, after);
  if (!geometry) return;
  historyPreview.recordTransition(workspaceId, { kind: "geometry", geometry: geometry.before },
    { kind: "geometry", geometry: geometry.after }, historyStateKey(before), historyStateKey(after));
}
function catalogHistorySelection(snapshot: DesignWorkspaceSnapshotWire, hint: { pageId?: string; frame?: string }, frameSelected: boolean) {
  const normalized = normalizeDesignPagesSnapshot(snapshot);
  const page = normalized.pages.find(page => page.id === hint.pageId || (hint.frame &&
    (page.frameFiles.includes(hint.frame) || (page.folder ? hint.frame.startsWith(page.folder + "/") : !hint.frame.includes("/"))))) ?? normalized.pages[0];
  const frame = hint.frame && page?.frameFiles.includes(hint.frame) ? hint.frame : page?.frameFiles[0] ?? null;
  return { pageId: page?.id, frame, frameSelected: frame !== null && frameSelected };
}
function recordCatalogHistory(workspaceId: string, before: DesignWorkspaceSnapshotWire | null | undefined, after: DesignWorkspaceSnapshotWire,
  hint?: { pageId?: string; frame?: string },
) {
  if (!before) return;
  historyPreview.recordTransition(workspaceId, { kind: "catalog", catalog: new WeakRef(before), ...(hint ? { selection: catalogHistorySelection(before, hint, true) } : {}) },
    { kind: "catalog", catalog: new WeakRef(after), ...(hint ? { selection: catalogHistorySelection(after, hint, false) } : {}) }, historyStateKey(before), historyStateKey(after));
}

/** A directory session, not the page selection revision: history spans pages.
 * The monotonic UI revision also rejects A→B→A with identical catalogs. */
function designMutationOwner(workspaceId: string): string {
  const view = useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId];
  return JSON.stringify([view?.directoryId, view?.directoryRevision ?? 0,
    historyOwnerKey(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data)]);
}
setDesignHistoryPresentationOwnerReader(designMutationOwner);

function assertDesignMutationOwner(workspaceId: string, owner: string): void {
  if (designMutationOwner(workspaceId) !== owner)
    throw new Error("The active Design directory changed. Refresh before editing.");
}

/** Review admission waits for already-submitted editor/gesture transactions.
 * No timer, network write, or autosave status is introduced. */
export async function waitForPendingDesignEdits(workspaceId: string): Promise<void> {
  while (localMutationTailByWorkspace.has(workspaceId)) {
    await localMutationTailByWorkspace.get(workspaceId);
  }
}

export async function prepareDesignMovementFrame(
  workspaceId: string,
  frame: DesignCanvasFrameWire,
): Promise<DesignCanvasFrameWire> {
  const owner = designMutationOwner(workspaceId);
  await waitForPendingDesignEdits(workspaceId);
  assertDesignMutationOwner(workspaceId, owner);
  const epoch = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.preparation?.epoch;
  const read = (): DesignCanvasFrameWire | null | undefined => {
    const snapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    if (designMutationOwner(workspaceId) !== owner || snapshot?.preparation?.epoch !== epoch) return null;
    const current = snapshot?.frames.find(candidate => candidate.file === frame.file);
    if (!current || snapshot?.preparation?.errors[frame.file]) return null;
    // A scoped acknowledgement may retain this frame only as a cover. Wait
    // for the active preparation lane; old pixels cannot authorize a move.
    if (snapshot?.preparation && !snapshot.preparation.current.includes(frame.file)) return undefined;
    return current;
  };
  const available = read();
  const current = available === undefined ? await new Promise<DesignCanvasFrameWire | null>(resolve => {
    const finish = (value: DesignCanvasFrameWire | null) => { clearTimeout(timer); unsubscribe(); resolve(value); };
    const unsubscribe = designWorkspaceSnapshotCache.subscribe(workspaceId, () => {
      const next = read();
      if (next !== undefined) finish(next);
    });
    const timer = setTimeout(() => finish(null), 2_000);
  }) : available;
  if (
    !current ||
    current.sourceVersion !==
      resolveLocalFrameSourceVersion(
        workspaceId,
        frame.file,
        frame.sourceVersion,
      ) ||
    current.x !== frame.x ||
    current.y !== frame.y ||
    current.width !== frame.width ||
    current.height !== frame.height ||
    current.z !== frame.z
  )
    throw new Error("The frame changed before movement could be measured.");
  return current;
}

/** Edits (not history steps) queued or running in each workspace's lane. An
 * edit still saving has not recorded its history prediction yet. */
const pendingEditCountByWorkspace = new Map<string, number>();
/** History steps whose prediction waits inside the lane. Later steps wait
 * behind them, so predictions advance the cursor in submission order. */
const deferredPredictionCountByWorkspace = new Map<string, number>();
interface LocalEditPresentation { frame?: string; geometry?: boolean; catalog?: boolean; ready?: boolean }
let nextHistoryIntent = 0;
const historyVisualIntentByWorkspace = new Map<string, { sequence: number; target: DesignHistoryPrediction | null }>();
type HistoryVisualRuntime = NonNullable<ReturnType<typeof designFrameRuntime>>;
const historyVisualRuntimeByWorkspace = new Map<string, Map<string, WeakRef<HistoryVisualRuntime>>>();
const pendingEditPresentationByWorkspace = new Map<string, Array<{
  sequence: number;
  input: LocalEditPresentation;
  before: DesignHistoryPrediction | null;
}>>();

function historyPredictionBytes(target: DesignHistoryPrediction | null): number {
  if (!target) return 0;
  let bytes = target.state.length * 2 + 128;
  if (target.kind === "generation") bytes += (target.frame.length + target.target.length) * 2;
  if ("geometry" in target) for (const file of target.geometry?.keys() ?? []) bytes += file.length * 2 + 192;
  if (target.selection) bytes += ((target.selection.frame?.length ?? 0) + (target.selection.pageId?.length ?? 0)) * 2 + 64;
  return bytes;
}
/** Retention diagnostics only; no source, selection values or runtime ports. */
export function designHistoryTransientStatsForTests() {
  return { intentOwners: historyVisualIntentByWorkspace.size,
    intentBytes: [...historyVisualIntentByWorkspace.entries()].reduce((sum, [workspace, intent]) => sum + workspace.length * 2 + 128 + historyPredictionBytes(intent.target), 0) };
}

function retainHistoryVisualIntent(workspaceId: string, intent: { sequence: number; target: DesignHistoryPrediction | null }): boolean {
  historyVisualIntentByWorkspace.delete(workspaceId);
  historyVisualIntentByWorkspace.set(workspaceId, intent);
  while (historyVisualIntentByWorkspace.size > 16 || designHistoryTransientStatsForTests().intentBytes > 1024 * 1024) {
    const [oldWorkspace, old] = historyVisualIntentByWorkspace.entries().next().value!;
    historyVisualIntentByWorkspace.delete(oldWorkspace);
    // Pending lane callbacks retain only this holder and a weak prediction.
    // Eviction must release the target through those callbacks as well.
    old.target = null;
    clearHistoryVisualRuntimes(oldWorkspace);
    clearDesignHistoryPresentation(oldWorkspace);
  }
  return historyVisualIntentByWorkspace.get(workspaceId) === intent;
}

function clearHistoryVisualRuntimes(workspaceId: string): void {
  const runtimes = historyVisualRuntimeByWorkspace.get(workspaceId);
  historyVisualRuntimeByWorkspace.delete(workspaceId);
  for (const [file, reference] of runtimes ?? []) {
    const runtime = reference.deref();
    // Clearing is teardown: it restores source without any layout readback,
    // including when this exact retained port just became hidden.
    if (runtime && designFrameRuntime(workspaceId, file) === runtime && runtime.previewHistory)
      void runtime.previewHistory(null).catch(() => {});
  }
}
function rememberHistoryVisualRuntime(workspaceId: string, file: string, runtime: HistoryVisualRuntime): void {
  const frames = historyVisualRuntimeByWorkspace.get(workspaceId) ?? new Map<string, WeakRef<HistoryVisualRuntime>>();
  frames.delete(file); frames.set(file, new WeakRef(runtime));
  while (frames.size > 8) {
    const [oldFile, reference] = frames.entries().next().value!;
    frames.delete(oldFile);
    const old = reference.deref();
    if (old && designFrameRuntime(workspaceId, oldFile) === old && old.previewHistory)
      void old.previewHistory(null).catch(() => {});
  }
  historyVisualRuntimeByWorkspace.delete(workspaceId);
  historyVisualRuntimeByWorkspace.set(workspaceId, frames);
  while (historyVisualRuntimeByWorkspace.size > 16)
    clearHistoryVisualRuntimes(historyVisualRuntimeByWorkspace.keys().next().value!);
}

function capturePendingEditPresentation(workspaceId: string, input: LocalEditPresentation) {
  const sequence = ++nextHistoryIntent;
  const previous = historyVisualIntentByWorkspace.get(workspaceId);
  const pending = pendingEditPresentationByWorkspace.get(workspaceId) ?? [];
  const known = (!pendingEditCountByWorkspace.has(workspaceId) ||
    (previous?.target && previous.sequence > (pending.at(-1)?.sequence ?? 0))) && (!previous || previous.target);
  const snapshot = previous?.target?.kind === "catalog" ? previous.target.catalog.deref()
    : designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
  const state = previous?.target?.state ?? historyStateKey(snapshot);
  let before: DesignHistoryPrediction | null = null;
  if (known && snapshot) {
    if (input.catalog) before = { kind: "catalog", catalog: new WeakRef(snapshot), state };
    else if (input.geometry) {
      const geometry = historyGeometry(snapshot);
      if (previous?.target && "geometry" in previous.target)
        for (const [file, value] of previous.target.geometry ?? []) geometry.set(file, value);
      before = { kind: "geometry", geometry, state };
    } else if (input.frame) {
      const target = previous?.target?.kind === "generation" && previous.target.frame === input.frame
        ? previous.target.target : snapshot.frames.find(frame => frame.file === input.frame)?.sourceVersion;
      if (target) {
        const geometry = historyGeometry(snapshot, new Set([input.frame]));
        if (previous?.target && "geometry" in previous.target)
          for (const [file, value] of previous.target.geometry ?? []) if (geometry.has(file)) geometry.set(file, value);
        before = { kind: "generation", frame: input.frame, target, geometry, state };
      }
    }
  }
  const entry = { sequence, input, before };
  pending.push(entry);
  if (pending.length > 128) pending.shift();
  pendingEditPresentationByWorkspace.set(workspaceId, pending);
  while (pendingEditPresentationByWorkspace.size > 16)
    pendingEditPresentationByWorkspace.delete(pendingEditPresentationByWorkspace.keys().next().value!);
  let bytes = [...pendingEditPresentationByWorkspace.values()].flat().reduce((sum, value) =>
    sum + (value.before?.state.length ?? 0) * 2 + (value.before && "geometry" in value.before ? (value.before.geometry?.size ?? 0) * 192 : 0), 0);
  for (const entries of pendingEditPresentationByWorkspace.values()) for (const value of entries) {
    if (bytes <= 1024 * 1024) break;
    bytes -= (value.before?.state.length ?? 0) * 2 + (value.before && "geometry" in value.before ? (value.before.geometry?.size ?? 0) * 192 : 0);
    value.before = null;
  }
  return () => {
    const entries = pendingEditPresentationByWorkspace.get(workspaceId)?.filter(value => value !== entry);
    if (entries?.length) pendingEditPresentationByWorkspace.set(workspaceId, entries);
    else pendingEditPresentationByWorkspace.delete(workspaceId);
  };
}

function adjustCount(counts: Map<string, number>, key: string, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}

async function runLocalDesignMutation<T>(
  workspaceId: string,
  mutation: (assertOwner: () => void) => Promise<T>,
  kind: "edit" | "history" = "edit",
  recover?: () => void,
  presentation?: LocalEditPresentation,
): Promise<T> {
  const owner = designMutationOwner(workspaceId);
  const finishPresentation = kind === "edit" && presentation ? capturePendingEditPresentation(workspaceId, presentation) : undefined;
  const finishMutation = beginLocalDesignMutation(workspaceId);
  if (kind === "edit") adjustCount(pendingEditCountByWorkspace, workspaceId, 1);
  const previous = localMutationTailByWorkspace.get(workspaceId);
  const attempt = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => {
      assertDesignMutationOwner(workspaceId, owner);
      return mutation(() => assertDesignMutationOwner(workspaceId, owner));
    });
  // Recovery is part of the failed operation, so the next queued step never
  // starts from what that operation painted or predicted.
  const result = recover
    ? attempt.catch((error: unknown) => {
        recover();
        throw error;
      })
    : attempt;
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  localMutationTailByWorkspace.set(workspaceId, tail);
  try {
    return await result;
  } finally {
    finishPresentation?.();
    if (kind === "edit") adjustCount(pendingEditCountByWorkspace, workspaceId, -1);
    finishMutation();
    if (localMutationTailByWorkspace.get(workspaceId) === tail) {
      localMutationTailByWorkspace.delete(workspaceId);
    }
    publishEditLifetime(workspaceId);
  }
}

function frameMutationKey(workspaceId: string, frame: string): string {
  return `${workspaceId}\u0000${frame}`;
}

function resolveLocalGeneration(
  lineage: { current: string; ancestors: string[] } | undefined,
  requested: string,
  confirmed: string | undefined,
): string {
  if (!confirmed || confirmed === requested) return requested;
  return lineage?.current === confirmed &&
    (lineage.current === requested || lineage.ancestors.includes(requested))
    ? confirmed
    : requested;
}

function recordLocalGeneration(
  map: Map<string, { current: string; ancestors: string[] }>,
  key: string,
  previous: string | undefined,
  next: string | undefined,
): void {
  if (!previous || !next || previous === next) return;
  const current = map.get(key);
  const ancestors =
    current?.current === previous
      ? [...current.ancestors, previous]
      : [previous];
  map.delete(key);
  map.set(key, { current: next, ancestors: ancestors.slice(-16) });
  while (map.size > 256) {
    const oldest = map.keys().next().value as string | undefined;
    if (!oldest) break;
    map.delete(oldest);
  }
}

function markFoundationRevisionStale(workspaceId: string, frame: string): void {
  const key = frameMutationKey(workspaceId, frame);
  staleFoundationRevisionByFrame.delete(key);
  staleFoundationRevisionByFrame.add(key);
  // The UI retains two design workspaces and the engine bounds each document
  // to 256 frames, so one full MRU pair remains race-safe without unbounded
  // revision bookkeeping.
  while (staleFoundationRevisionByFrame.size > 512) {
    const oldest = staleFoundationRevisionByFrame.values().next().value as
      | string
      | undefined;
    if (!oldest) break;
    staleFoundationRevisionByFrame.delete(oldest);
  }
}

function currentFrameSourceVersion(
  workspaceId: string,
  frame: string,
): string | undefined {
  return preparedDesignSnapshot(designWorkspaceSnapshotCache
    .peekSnapshot(workspaceId).data)?.frames.find((candidate) => candidate.file === frame)?.sourceVersion;
}

function resolveLocalFrameSourceVersion(
  workspaceId: string,
  frame: string,
  requested: string,
): string {
  const key = frameMutationKey(workspaceId, frame);
  return resolveLocalGeneration(
    localFrameGenerationByOwner.get(key),
    requested,
    currentFrameSourceVersion(workspaceId, frame),
  );
}

/** Match only optimistic-concurrency rejections — the engine's compat guards
 * ("… changed before the mutation …") and Foundation revision conflicts. The
 * write was rejected outright for these, so retrying cannot double-apply.
 * Transport failures never match: their write may have landed. */
function isStaleDesignGenerationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /changed before the mutation/i.test(message) ||
    /design (?:document \S+|repository) changed: expected/i.test(message)
  );
}

/** The stale-generation guard's remedy is mechanical — re-read the frame and
 * retry — so perform it once on the user's behalf before surfacing anything.
 * Engine restarts are the common trigger: they re-compose every generation
 * while the renderer still holds the previous lineage, which otherwise turns
 * every canvas edit into a dead-end "Re-read it and retry" toast. */
async function executeWithFreshGenerationRetry<T>(
  workspaceId: string,
  frame: string,
  requestedSourceVersion: string,
  execute: (sourceVersion: string) => Promise<T>,
): Promise<T> {
  try {
    return await execute(requestedSourceVersion);
  } catch (error) {
    if (!isStaleDesignGenerationError(error)) throw error;
    let fresh: string | undefined;
    try {
      const snapshot = await refreshDesignWorkspaceSnapshot(workspaceId);
      fresh = snapshot.frames.find(
        (candidate) => candidate.file === frame,
      )?.sourceVersion;
    } catch {
      throw error;
    }
    if (!fresh || fresh === requestedSourceVersion) throw error;
    return await execute(fresh);
  }
}

function recordLocalFrameGeneration(
  workspaceId: string,
  frame: string,
  previous: string | undefined,
  next: string | undefined,
): void {
  recordLocalGeneration(
    localFrameGenerationByOwner,
    frameMutationKey(workspaceId, frame),
    previous,
    next,
  );
}

function scheduleAdoptedFrameSettlement(
  workspaceId: string,
  folder: string,
  frame: string,
  sourceVersion: string,
): void {
  if (typeof window === "undefined") return;
  const key = `${workspaceId}\u0000${frame}`;
  pendingAdoptedSettlementByFrame.get(key)?.();
  const idleWindow = window as Window & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number },
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  let cancelled = false;
  const settleAudit = async () => {
    const runtime = designFrameRuntime(workspaceId, frame);
    if (
      !runtime ||
      runtime.isActive?.() === false ||
      runtime.sourceVersion !== sourceVersion
    )
      return;
    const snapshot = await runtime.getSnapshot();
    if (
      runtime.isActive?.() === false ||
      snapshot.sourceVersion !== sourceVersion ||
      designFrameRuntime(workspaceId, frame) !== runtime ||
      designRuntimeFrameState(workspaceId, frame)?.sourceVersion !==
        sourceVersion
    ) {
      return;
    }
    useDesignRuntimeStore
      .getState()
      .publishSnapshot(workspaceId, folder, frame, snapshot, sourceVersion);
    await reconcileDesignWorkspaceRuntimeAudit({
      workspaceId,
      frame,
      sourceVersion,
      warnings: snapshot.warnings,
    });
  };
  const run = () => {
    if (cancelled) return;
    pendingAdoptedSettlementByFrame.delete(key);
    void designBackgroundWork
      .schedule(`audit:${key}`, async () => {
        if (!cancelled) await settleAudit();
      })
      .catch(() => {
        // The retained exact-generation audit stays visible until a later full
        // runtime snapshot or workspace refresh can confirm its replacement.
      });
    void captureDesignRuntimeScreenshot(
      workspaceId,
      folder,
      frame,
      sourceVersion,
      null,
      0.5,
    ).catch(() => {});
  };
  const idle = typeof idleWindow.requestIdleCallback === "function";
  const handle = idle
    ? idleWindow.requestIdleCallback!(run, { timeout: 1_000 })
    : window.setTimeout(run, 250);
  const cancel = () => {
    cancelled = true;
    if (idle) idleWindow.cancelIdleCallback?.(handle);
    else window.clearTimeout(handle);
  };
  pendingAdoptedSettlementByFrame.set(key, cancel);
  while (pendingAdoptedSettlementByFrame.size > 16) {
    const oldest = pendingAdoptedSettlementByFrame.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    pendingAdoptedSettlementByFrame.get(oldest)?.();
    pendingAdoptedSettlementByFrame.delete(oldest);
  }
}

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
setDesignSelectionSnapshotReader(
  (workspaceId) => preparedDesignSnapshot(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data),
);
for (const [workspaceId, snapshot] of readDesignWorkspaceBootSnapshots()) {
  designWorkspaceSnapshotCache.setData(workspaceId, snapshot);
  // A boot preview paints synchronously but is never considered authoritative
  // for the new engine/filesystem generation.
  designWorkspaceSnapshotCache.invalidate(workspaceId);
}
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

export const designFramePreparation = new DesignFramePreparation({
  snapshot: (workspaceId) => designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data,
  publish: (workspaceId, snapshot) => designWorkspaceSnapshotCache.setData(workspaceId,
    stabilizeDesignWorkspaceSnapshot(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data, snapshot)),
  canPrepare: (workspaceId) => {
    const read = designWorkspaceSnapshotCache.peekSnapshot(workspaceId);
    return !isCloudWorkspace(workspaceId) && !hasPendingDesignEdits(workspaceId) && !read.loading && !read.refreshing;
  },
  prepare: designPrepareFrames,
});

/** Retirement drops reconstructible source/projections, not semantic state or
 * bounded full-frame cover pixels. Exact ownership and pending edits win. */
export function retireHiddenDesignFrames(workspaceId: string, directoryId: string | undefined, files: readonly string[]): void {
  if (hasPendingDesignEdits(workspaceId) ||
    designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.directoryId !== directoryId) return;
  for (const frame of files) {
    if (designFrameRuntime(workspaceId, frame)?.isActive?.()) continue;
    const prefix = `${workspaceId}\0${frame}\0`;
    for (const cache of [designFrameDocumentCache, designFoundationCache])
      for (const key of cache.keys()) if (key.startsWith(prefix)) cache.forget(key);
    useDesignRuntimeStore.getState().retireFrame(workspaceId, frame);
  }
}

/** A request queued while the first socket is connecting has not observed the
 * old engine: RuntimeClient sends it only after that socket becomes usable.
 * Invalidating that request at the same connection event supersedes its
 * generation and queues an identical second aggregate scan. Besides doubling
 * cold-start work, the discarded scan can consume the whole bridge timeout.
 *
 * Settled values and failures still need revalidation after a real connection
 * boundary. Active loads/refreshes already target the newly connected bridge,
 * so leave those generations intact. */
function invalidateSettledDesignCache<T>(cache: KeyedAsyncCache<T>): void {
  for (const key of cache.keys()) {
    const snapshot = cache.peekSnapshot(key);
    if (snapshot.loading || snapshot.refreshing) continue;
    cache.invalidate(key);
  }
}

/** A style build wrote new CSS for these workspaces (all, when unnamed).
 * Only their Design snapshots revalidate; a local mutation in flight defers
 * its workspace's refresh until it settles, as Git refreshes do. */
export function invalidateDesignWorkspacesForStyleBuild(
  workspaceIds: readonly string[] | undefined,
): void {
  if (!workspaceIds?.length) {
    invalidateSettledDesignCache(designWorkspaceSnapshotCache);
    return;
  }
  for (const workspaceId of workspaceIds) {
    const localMutation = pendingLocalMutationByWorkspace.get(workspaceId);
    if (localMutation) localMutation.deferredRefresh = true;
    else designWorkspaceSnapshotCache.invalidate(workspaceId);
  }
}

// A respawned engine re-composes every generation and authored revision, so
// settled identities held across a connection boundary are suspect. Mounted
// exact-key consumers revalidate them while retaining their confirmed data.
onActiveBridgeConnected((_client, info) => {
  if (info.initial) return;
  invalidateSettledDesignCache(designWorkspaceSnapshotCache);
  invalidateSettledDesignCache(designFrameDocumentCache);
  invalidateSettledDesignCache(designFoundationCache);
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
  const document = await executeDesignReadWithTransientRetry(() =>
    designFrame(workspaceId, frame),
  );
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
  return executeDesignReadWithTransientRetry(() =>
    designFoundationOpen(workspaceId, frame),
  );
}

function invalidateWorkspaceDesignFoundations(
  workspaceId: string,
  currentSnapshot?: DesignWorkspaceSnapshotWire,
): void {
  const prefix = `${workspaceId}${FOUNDATION_KEY_SEPARATOR}`;
  for (const key of designFoundationCache.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (currentSnapshot) {
      const [, frame, sourceVersion] = key.split(FOUNDATION_KEY_SEPARATOR);
      const currentFrame = currentSnapshot.frames.find(
        (candidate) => candidate.file === frame,
      );
      // A prior source generation is immutable server state. Leave it alone
      // while subscribers move to the new exact key; only the current key can
      // need revalidation when a shared authored file changed without changing
      // this frame's rendered source.
      if (!currentFrame || currentFrame.sourceVersion !== sourceVersion) {
        continue;
      }
    }
    designFoundationCache.invalidate(key);
  }
}

function settleFoundationMutation(
  workspaceId: string,
  frame: string | null,
  snapshot: DesignWorkspaceSnapshotWire,
  revision?: DesignFoundationRevisionWire,
): void {
  const confirmedKey = frame ? frameMutationKey(workspaceId, frame) : null;
  if (confirmedKey && revision) {
    if (
      localFoundationRevisionByFrame.get(confirmedKey)?.current !==
      revision.after
    ) {
      recordLocalGeneration(
        localFoundationRevisionByFrame,
        confirmedKey,
        revision.before,
        revision.after,
      );
    }
    staleFoundationRevisionByFrame.delete(confirmedKey);
  }
  for (const candidate of snapshot.frames) {
    const key = frameMutationKey(workspaceId, candidate.file);
    if (key !== confirmedKey || !revision) {
      markFoundationRevisionStale(workspaceId, candidate.file);
    }
  }
  invalidateWorkspaceDesignFoundations(workspaceId, snapshot);
}

async function resolveFoundationBaseRevision(
  workspaceId: string,
  frame: string,
  requested: string,
): Promise<string> {
  const revisionKey = frameMutationKey(workspaceId, frame);
  if (staleFoundationRevisionByFrame.has(revisionKey)) {
    const sourceVersion =
      currentFrameSourceVersion(workspaceId, frame) ??
      designFrameRuntime(workspaceId, frame)?.sourceVersion;
    const opened =
      sourceVersion && /^[a-f0-9]{24}$/.test(sourceVersion)
        ? await designFoundationCache.load(
            designFoundationKey(workspaceId, frame, sourceVersion),
            () =>
              fetchDesignFoundation(
                designFoundationKey(workspaceId, frame, sourceVersion),
              ),
            { maxAgeMs: Number.POSITIVE_INFINITY },
          )
        : await designFoundationOpen(workspaceId, frame);
    const confirmed = opened.summary.revision;
    const previous =
      localFoundationRevisionByFrame.get(revisionKey)?.current ?? requested;
    recordLocalGeneration(
      localFoundationRevisionByFrame,
      revisionKey,
      previous,
      confirmed,
    );
    staleFoundationRevisionByFrame.delete(revisionKey);
    return confirmed;
  }
  const lineage = localFoundationRevisionByFrame.get(revisionKey);
  return resolveLocalGeneration(lineage, requested, lineage?.current);
}

function sameFrame(
  left: DesignWorkspaceSnapshotWire["frames"][number],
  right: DesignWorkspaceSnapshotWire["frames"][number],
): boolean {
  return (
    left.file === right.file &&
    left.frameId === right.frameId &&
    left.pageId === right.pageId &&
    left.title === right.title &&
    left.kind === right.kind &&
    left.width === right.width &&
    left.height === right.height &&
    left.x === right.x &&
    left.y === right.y &&
    left.z === right.z &&
    left.nodeCount === right.nodeCount &&
    left.layerCount === right.layerCount &&
    left.modifiedAt === right.modifiedAt &&
    left.sourceVersion === right.sourceVersion &&
    // Boot/legacy frames can gain confirmed costs without a source change.
    // Cost changes and withdrawals must reach the shared admission budget.
    (left.surfaceCost === right.surfaceCost ||
      (left.surfaceCost != null && right.surfaceCost != null &&
        left.surfaceCost.sourceBytes === right.surfaceCost.sourceBytes &&
        left.surfaceCost.nodes === right.surfaceCost.nodes &&
        left.surfaceCost.imageBytes === right.surfaceCost.imageBytes))
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
    left.usageCountKnown === right.usageCountKnown &&
    left.line === right.line
  );
}

type DesignStyleSourceSnapshot = NonNullable<
  DesignWorkspaceSnapshotWire["styleSources"]
>[number];
const NO_STYLE_SOURCES: DesignStyleSourceSnapshot[] = [];
const NO_STYLE_SOURCE_ERRORS: string[] = [];
const NO_THEMES: NonNullable<DesignWorkspaceSnapshotWire["themes"]> = [];

/** The revision hashes the imported CSS, so equal revisions carry equal tokens. */
function sameStyleSource(
  left: DesignStyleSourceSnapshot,
  right: DesignStyleSourceSnapshot,
): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.kind === right.kind &&
    left.path === right.path &&
    left.status === right.status &&
    left.revision === right.revision &&
    left.bytes === right.bytes &&
    left.themes.join("\u0000") === right.themes.join("\u0000") &&
    left.messages.length === right.messages.length &&
    left.messages.every(
      (message, index) =>
        message.level === right.messages[index]!.level &&
        message.text === right.messages[index]!.text,
    )
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

/** Runtime layout audits are exact-generation data, but the engine cannot
 * carry them across an authored source hash until the mounted browser has
 * audited that new generation. A successful hot adoption keeps the same DOM,
 * so retain its last confirmed rows instead of flashing the review strip off
 * and back on while the idle audit catches up. */
function runtimeAuditFrameKey(workspaceId: string, frame: string): string {
  return `${workspaceId}\u0000${frame}`;
}

function rememberRuntimeAuditViolations(
  workspaceId: string,
  previous: DesignWorkspaceSnapshotWire | undefined,
  frame: string,
  sourceVersion: string,
): void {
  if (!previous) return;
  const retained = previous.lint.violations.filter(
    (violation) =>
      violation.file === frame && RUNTIME_AUDIT_RULE_IDS.has(violation.ruleId),
  );
  if (retained.length === 0) return;
  const key = runtimeAuditFrameKey(workspaceId, frame);
  retainedRuntimeAuditByFrame.delete(key);
  retainedRuntimeAuditByFrame.set(key, {
    workspaceId,
    frame,
    sourceVersion,
    violations: retained,
  });
  while (retainedRuntimeAuditByFrame.size > 256) {
    const oldest = retainedRuntimeAuditByFrame.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    retainedRuntimeAuditByFrame.delete(oldest);
  }
}

function rememberAdvancedFrameRuntimeAudits(
  workspaceId: string,
  previous: DesignWorkspaceSnapshotWire | undefined,
  next: DesignWorkspaceSnapshotWire,
): void {
  if (!previous) return;
  const previousFrames = new Map(
    previous.frames.map((frame) => [frame.file, frame.sourceVersion]),
  );
  for (const frame of next.frames) {
    const previousSourceVersion = previousFrames.get(frame.file);
    if (
      previousSourceVersion &&
      previousSourceVersion !== frame.sourceVersion
    ) {
      rememberRuntimeAuditViolations(
        workspaceId,
        previous,
        frame.file,
        frame.sourceVersion,
      );
    }
  }
}

function applyRetainedRuntimeAuditViolations(
  workspaceId: string,
  next: DesignWorkspaceSnapshotWire,
): DesignWorkspaceSnapshotWire {
  let violations: readonly DesignLintViolationWire[] = next.lint.violations;
  for (const [key, retained] of retainedRuntimeAuditByFrame) {
    if (retained.workspaceId !== workspaceId) continue;
    const frame = next.frames.find(
      (candidate) => candidate.file === retained.frame,
    );
    if (!frame || frame.sourceVersion !== retained.sourceVersion) {
      retainedRuntimeAuditByFrame.delete(key);
      continue;
    }
    const hasFreshRuntimeAudit = violations.some(
      (violation) =>
        violation.file === retained.frame &&
        RUNTIME_AUDIT_RULE_IDS.has(violation.ruleId),
    );
    if (hasFreshRuntimeAudit) {
      retainedRuntimeAuditByFrame.delete(key);
      continue;
    }
    const signatures = new Set(
      violations.map(
        (violation) =>
          `${violation.ruleId}\u0000${violation.file}\u0000${violation.oid ?? ""}`,
      ),
    );
    const missing = retained.violations.filter(
      (violation) =>
        !signatures.has(
          `${violation.ruleId}\u0000${violation.file}\u0000${violation.oid ?? ""}`,
        ),
    );
    if (missing.length > 0) violations = [...violations, ...missing];
  }
  if (violations === next.lint.violations) return next;
  return { ...next, lint: { ...next.lint, violations: [...violations] } };
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
  if (!previous || previous.directoryId !== next.directoryId) return next;
  const pages = previous.pages && next.pages ? stableArray(previous.pages, next.pages, (left, right) =>
    left.id === right.id && left.title === right.title && left.folder === right.folder &&
    left.frameFiles.length === right.frameFiles.length && left.frameFiles.every((file, index) => file === right.frameFiles[index]) &&
    left.frameIds?.length === right.frameIds?.length && (left.frameIds?.every((id, index) => id === right.frameIds?.[index]) ?? true)) : next.pages;
  const frames = stableArray(previous.frames, next.frames, sameFrame);
  const tokens = stableArray(previous.tokens, next.tokens, sameToken);
  const styleSources = stableArray(
    previous.styleSources ?? NO_STYLE_SOURCES,
    next.styleSources ?? NO_STYLE_SOURCES,
    sameStyleSource,
  );
  const styleSourceErrors = stableArray(
    previous.styleSourceErrors ?? NO_STYLE_SOURCE_ERRORS,
    next.styleSourceErrors ?? NO_STYLE_SOURCE_ERRORS,
    (left, right) => left === right,
  );
  const themes = stableArray(
    previous.themes ?? NO_THEMES,
    next.themes ?? NO_THEMES,
    (left, right) => left.id === right.id && left.label === right.label && left.base === right.base,
  );
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
    next.preparation === previous.preparation &&
    pages === previous.pages &&
    next.directory === previous.directory &&
    next.protocolCapability === previous.protocolCapability &&
    tokens === previous.tokens &&
    next.tokenSourceVersion === previous.tokenSourceVersion &&
    styleSources === (previous.styleSources ?? NO_STYLE_SOURCES) &&
    styleSourceErrors === (previous.styleSourceErrors ?? NO_STYLE_SOURCE_ERRORS) &&
    themes === (previous.themes ?? NO_THEMES) &&
    assets === previous.assets &&
    lint === previous.lint
    ? previous
    : {
        ...(next.preparation ? { preparation: next.preparation } : {}),
        directoryId: next.directoryId,
        directory: next.directory,
        ...(pages ? { pages } : {}),
        protocolCapability: next.protocolCapability,
        frames,
        tokens,
        tokenSourceVersion: next.tokenSourceVersion,
        styleSources,
        styleSourceErrors,
        themes,
        assets,
        lint,
      };
}

/** Called after a cache publication, never from an unadmitted fetch result. */
export function observeDesignDirectory(workspaceId: string, snapshot: DesignWorkspaceSnapshotWire): void {
  notifyDesignSelectionSnapshot(workspaceId);
  designSourceVectorCache.reconcile({ workspaceId, folder: snapshot.lint.workspacePath,
    directoryId: snapshot.directoryId ?? "", capability: snapshot.protocolCapability ?? "" },
    new Set((snapshot.preparation?.descriptions ?? snapshot.frames).map(frame => frame.file)));
  if (!snapshot.directoryId) return;
  const ui = useDesignWorkspaceUiStore.getState();
  const previous = ui.byWorkspace[workspaceId]?.directoryId;
  if (previous && previous !== snapshot.directoryId) {
    historyPreview.clear(workspaceId);
    clearDesignHistoryPresentation(workspaceId);
    historyVisualIntentByWorkspace.delete(workspaceId);
    clearHistoryVisualRuntimes(workspaceId);
    useDesignRuntimeStore.getState().forgetWorkspace(workspaceId);
    invalidateWorkspaceDesignFoundations(workspaceId);
    // Folds and pending reveals name frames and nodes of the old directory;
    // a replacement with colliding file names must start folded.
    forgetDesignLayerDisclosure(workspaceId);
  }
  rememberDesignDirectoryIdentity(workspaceId, snapshot.directoryId);
  ui.bindDirectory(workspaceId, snapshot.directoryId);
}

function publishDesignWorkspaceSnapshot(
  workspaceId: string,
  next: DesignWorkspaceSnapshotWire,
): DesignWorkspaceSnapshotWire {
  const previous = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
  next = projectDesignMutationSnapshot(previous, next);
  if ((pendingLocalMutationByWorkspace.get(workspaceId)?.depth ?? 0) > 0) {
    rememberAdvancedFrameRuntimeAudits(workspaceId, previous, next);
  }
  const retained = applyRetainedRuntimeAuditViolations(workspaceId, next);
  const stable = stabilizeDesignWorkspaceSnapshot(previous, retained);
  designWorkspaceSnapshotCache.setData(workspaceId, stable);
  notifyDesignSelectionSnapshot(workspaceId);
  if (!stable.preparation) queueDesignWorkspaceBootSnapshot(workspaceId, stable);
  return stable;
}

/** Seed the exact aggregate carried by a lifecycle/mutation receipt. Publishing
 * before its owning route becomes visible removes a redundant bridge read from
 * the navigation path. */
export function primeDesignWorkspaceSnapshot(
  workspaceId: string,
  snapshot: DesignWorkspaceSnapshotWire,
): DesignWorkspaceSnapshotWire {
  return publishDesignWorkspaceSnapshot(workspaceId, snapshot);
}

/** Replace a carried runtime audit only after the browser's exact new
 * generation has been accepted by the engine and read back in the aggregate
 * snapshot. Ready/mutation events share this promise, keeping repeated
 * observers from producing duplicate bridge reads. */
export function reconcileDesignWorkspaceRuntimeAudit(input: {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  warnings: Parameters<typeof persistDesignRuntimeAuditSnapshot>[0]["warnings"];
}): Promise<void> {
  const key = runtimeAuditFrameKey(input.workspaceId, input.frame);
  const fingerprint = `${input.sourceVersion}\u0000${JSON.stringify(input.warnings)}`;
  const existing = runtimeAuditSettlementByFrame.get(key);
  if (existing?.fingerprint === fingerprint) return existing.result;
  const result = (async () => {
    const started = designWorkspaceSnapshotCache.peekSnapshot(input.workspaceId);
    const current = started.data?.frames.find(
      (candidate) => candidate.file === input.frame,
    );
    if (current?.sourceVersion !== input.sourceVersion) return;
    const persisted = await persistDesignRuntimeAuditSnapshot(input);
    if (!persisted) return;
    if (started.data?.preparation) {
      const latest = designWorkspaceSnapshotCache.peekSnapshot(input.workspaceId);
      if (typeof persisted !== "object" || latest.invalidationVersion !== started.invalidationVersion ||
        latest.data?.preparation?.epoch !== started.data.preparation.epoch ||
        !preparedDesignSnapshot(latest.data)?.frames.some((frame) => frame.file === input.frame && frame.sourceVersion === input.sourceVersion)) return;
      const current = latest.data;
      retainedRuntimeAuditByFrame.delete(key);
      const next: DesignWorkspaceSnapshotWire = { ...current, lint: { ...current.lint,
        violations: [...current.lint.violations.filter((row) => row.file !== input.frame || !RUNTIME_AUDIT_RULE_IDS.has(row.ruleId)), ...persisted.violations],
      } };
      // An unchanged audit would still notify every subscriber of the cache.
      if (stabilizeDesignWorkspaceSnapshot(current, next) !== current) publishDesignWorkspaceSnapshot(input.workspaceId, next);
      return;
    }
    const authoritative = await designSnapshot(input.workspaceId);
    const latest = designWorkspaceSnapshotCache.peekSnapshot(input.workspaceId);
    if (
      authoritative.frames.find((candidate) => candidate.file === input.frame)
        ?.sourceVersion !== input.sourceVersion ||
      latest.data?.frames.find((candidate) => candidate.file === input.frame)
        ?.sourceVersion !== input.sourceVersion
    ) {
      return;
    }
    if (
      retainedRuntimeAuditByFrame.get(key)?.sourceVersion ===
      input.sourceVersion
    ) {
      retainedRuntimeAuditByFrame.delete(key);
    }
    // This direct read can predate a save that landed while it ran (an
    // agent's next step, a watcher event, a mutation reply). Never publish it
    // over that newer state: an invalidation already owns a replacement
    // read, and any other publication gets one fresh read instead.
    if (latest.invalidationVersion !== started.invalidationVersion) return;
    if (latest.data !== started.data) {
      const localMutation = pendingLocalMutationByWorkspace.get(
        input.workspaceId,
      );
      if (localMutation) localMutation.deferredRefresh = true;
      else designWorkspaceSnapshotCache.invalidate(input.workspaceId);
      return;
    }
    publishDesignWorkspaceSnapshot(input.workspaceId, authoritative);
  })().catch((error) => {
    if (runtimeAuditSettlementByFrame.get(key)?.fingerprint === fingerprint) {
      runtimeAuditSettlementByFrame.delete(key);
    }
    throw error;
  });
  runtimeAuditSettlementByFrame.delete(key);
  runtimeAuditSettlementByFrame.set(key, { fingerprint, result });
  while (runtimeAuditSettlementByFrame.size > 256) {
    const oldest = runtimeAuditSettlementByFrame.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    runtimeAuditSettlementByFrame.delete(oldest);
  }
  return result;
}

export async function fetchDesignWorkspaceSnapshot(
  workspaceId: string,
  authoritative = false,
): Promise<DesignWorkspaceSnapshotWire> {
  const started = designWorkspaceSnapshotCache.peekSnapshot(workspaceId);
  const previous = started.data;
  let next = await executeDesignReadWithTransientRetry(() =>
    authoritative ? designSnapshot(workspaceId) : readDesignNavigation(workspaceId, previous)
      .then((navigation) => navigation ?? designSnapshot(workspaceId)),
  );
  if (previous?.frames.length && next.preparation && next.directoryId === previous.directoryId &&
    next.lint.workspacePath === previous.lint.workspacePath) {
    next = await designFramePreparation.revalidate(workspaceId, next, () => {
      const latest = designWorkspaceSnapshotCache.peekSnapshot(workspaceId);
      return latest.data === previous && latest.invalidationVersion === started.invalidationVersion && !hasPendingDesignEdits(workspaceId);
    });
  }
  const mutation = pendingLocalMutationByWorkspace.get(workspaceId);
  if (!authoritative && mutation && previous) {
    // A read that straddled an edit cannot demote the prepared surface while
    // its mutation receipt is still pending. That receipt (or one deferred
    // revalidation after a failed edit) owns the replacement generation.
    mutation.deferredRefresh = true;
    return previous;
  }
  const stable = stabilizeDesignWorkspaceSnapshot(
    designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data,
    applyRetainedRuntimeAuditViolations(workspaceId, next),
  );
  if (!stable.preparation) queueDesignWorkspaceBootSnapshot(workspaceId, stable);
  return stable;
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
    // Explicit recovery and mutation retries need actual source generations.
    // Navigation/watchers use the lazy fetch through useCachedRead.
    () => fetchDesignWorkspaceSnapshot(workspaceId, true),
    { force: true },
  );
}

/** Publish the mutation's exact aggregate response without a second bridge
 * round trip on the click path. */
export async function createDesignFrameAndRefresh(
  workspaceId: string,
  title?: string,
  geometry?: DesignFrameGeometryWire,
  seed?: DesignTextFrameSeedWire,
  pageId?: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const beforeSnapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const result = await designCreateFrame(workspaceId, title, geometry, seed, pageId);
    assertOwner();
    const snapshot = publishDesignWorkspaceSnapshot(
      workspaceId,
      result.snapshot,
    );
    recordCatalogHistory(workspaceId, beforeSnapshot, snapshot, { frame: result.frame.file, pageId });
    settleFoundationMutation(workspaceId, null, snapshot);
    return {
      frame: result.frame,
      snapshot,
    };
  }, "edit", undefined, { catalog: true });
}

export async function renameDesignFrameAndRefresh(
  workspaceId: string,
  frame: string,
  title: string,
): Promise<DesignWorkspaceSnapshotWire> {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const beforeSnapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const result = await designRenameFrame(workspaceId, frame, title);
    assertOwner();
    const snapshot = publishDesignWorkspaceSnapshot(
      workspaceId,
      result.snapshot,
    );
    recordCatalogHistory(workspaceId, beforeSnapshot, snapshot, { frame });
    settleFoundationMutation(workspaceId, null, snapshot);
    return snapshot;
  });
}

export async function duplicateDesignFrameCached(
  workspaceId: string,
  frame: string,
  pageId?: string,
  placement?: Parameters<typeof designDuplicateFrame>[3],
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const beforeSnapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const result = placement
      ? await designDuplicateFrame(workspaceId, frame, pageId, placement)
      : await designDuplicateFrame(workspaceId, frame, pageId);
    assertOwner();
    const snapshot = publishDesignWorkspaceSnapshot(
      workspaceId,
      result.snapshot,
    );
    recordCatalogHistory(workspaceId, beforeSnapshot, snapshot, { frame: result.frame.file, pageId });
    settleFoundationMutation(workspaceId, null, snapshot);
    return {
      frame: result.frame,
      snapshot,
    };
  });
}

export async function deleteDesignFrameCached(
  workspaceId: string,
  frame: string,
): Promise<DesignWorkspaceSnapshotWire> {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const beforeSnapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const result = await designDeleteFrame(workspaceId, frame);
    assertOwner();
    const snapshot = publishDesignWorkspaceSnapshot(
      workspaceId,
      result.snapshot,
    );
    recordCatalogHistory(workspaceId, beforeSnapshot, snapshot, { frame });
    settleFoundationMutation(workspaceId, null, snapshot);
    return snapshot;
  });
}

export async function createDesignPageCached(workspaceId: string, title?: string) {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const before = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const result = await designCreatePage(workspaceId, title);
    assertOwner();
    const snapshot = publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
    recordCatalogHistory(workspaceId, before, snapshot, { pageId: result.page.id });
    return { ...result, snapshot };
  }, "edit", undefined, { catalog: true });
}

export async function renameDesignPageCached(workspaceId: string, pageId: string, title: string) {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const before = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const result = await designRenamePage(workspaceId, pageId, title);
    assertOwner();
    const snapshot = publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
    recordCatalogHistory(workspaceId, before, snapshot, { pageId });
    return { ...result, snapshot };
  }, "edit", undefined, { catalog: true });
}

/** The theme editor's Update: the engine re-reads every imported source and
 * runs its builds, then this workspace's snapshot is read again. */
export async function refreshDesignStylesCached(workspaceId: string): Promise<DesignWorkspaceSnapshotWire | undefined> {
  await designRefreshStyles(workspaceId);
  return refreshDesignWorkspaceSnapshot(workspaceId);
}

/** Name a theme, or make it the default, from the theme editor. */
export async function updateDesignThemeCached(
  workspaceId: string,
  theme: { id: string; label: string; base?: boolean },
) {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const before = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const result = await designUpdateTheme(workspaceId, theme);
    assertOwner();
    const snapshot = publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
    recordCatalogHistory(workspaceId, before, snapshot);
    return { ...result, snapshot };
  }, "edit", undefined, { catalog: true });
}

export async function deleteDesignPageCached(workspaceId: string, pageId: string, expectedFrameIds: readonly string[], onConfirmed?: (snapshot: DesignWorkspaceSnapshotWire) => void) {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const before = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const result = await designDeletePage(workspaceId, pageId, expectedFrameIds);
    assertOwner();
    // Resolve the UI owner before publication can prune the deleted page.
    onConfirmed?.(result.snapshot);
    const snapshot = publishDesignWorkspaceSnapshot(workspaceId, result.snapshot);
    recordCatalogHistory(workspaceId, before, snapshot, { pageId });
    return { ...result, snapshot };
  }, "edit", undefined, { catalog: true });
}

export async function transferDesignNodeCached(
  workspaceId: string,
  input: Parameters<typeof designTransferNode>[1],
  isCurrent?: () => boolean,
  /** Runs with the engine's result just before its snapshot publishes, so a
   * selection that follows the move lands in the same render as the frame
   * change and no page binding observes the source frame missing first. */
  beforePublish?: (result: Awaited<ReturnType<typeof designTransferNode>>) => void,
) {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    if (isCurrent?.() === false) throw new Error("The layer move no longer owns the active selection.");
    const result = await designTransferNode(workspaceId, {
      ...input,
      sourceVersion: input.relocation ? input.sourceVersion : resolveLocalFrameSourceVersion(
        workspaceId,
        input.frame,
        input.sourceVersion,
      ),
      ...(input.destinationFrame && input.destinationSourceVersion
        ? {
            destinationSourceVersion: input.relocation ? input.destinationSourceVersion : resolveLocalFrameSourceVersion(
              workspaceId,
              input.destinationFrame,
              input.destinationSourceVersion,
            ),
          }
        : {}),
    });
    assertOwner();
    historyPreview.clear(workspaceId);
    beforePublish?.(result);
    const snapshot = publishDesignWorkspaceSnapshot(
      workspaceId,
      result.snapshot,
    );
    settleFoundationMutation(workspaceId, null, snapshot);
    return result;
  });
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
  return runLocalDesignMutation(workspaceId, async (assertOwner) =>
    executeWithFreshGenerationRetry(
      workspaceId,
      input.frame,
      resolveLocalFrameSourceVersion(
        workspaceId,
        input.frame,
        input.sourceVersion,
      ),
      async (sourceVersion) => {
        assertOwner();
        const beforeState = historyStateKey(
          designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data,
        );
        const reply = await designUpdateStyles(workspaceId, {
          ...input,
          sourceVersion,
        });
        assertOwner();
        // A scoped acknowledgement carries only this frame. History keys the
        // state the cache will publish, so project it onto the catalog first.
        const result = { ...reply, snapshot: projectDesignMutationSnapshot(
          designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data, reply.snapshot) };
        const nextSourceVersion = result.snapshot.frames.find(
          (frame) => frame.file === input.frame,
        )?.sourceVersion;
        recordLocalFrameGeneration(
          workspaceId,
          input.frame,
          sourceVersion,
          nextSourceVersion,
        );
        const adopted = await adoptDesignStyleGeneration(
          workspaceId,
          input.frame,
          sourceVersion,
          nextSourceVersion,
          [{ nodeId: input.nodeId, styles: input.styles }],
        );
        assertOwner();
        if (adopted && nextSourceVersion)
          historyPreview.record(
            workspaceId,
            input.frame,
            sourceVersion,
            nextSourceVersion,
            beforeState,
            historyStateKey(result.snapshot),
          );
        const snapshot = publishDesignWorkspaceSnapshot(
          workspaceId,
          result.snapshot,
        );
        settleFoundationMutation(
          workspaceId,
          input.frame,
          snapshot,
          result.foundationRevision,
        );
        clearCommittedDesignLivePreviewStyles(
          workspaceId,
          input.frame,
          input.nodeId,
          input.styles,
        );
        return result.mutation;
      },
    ),
    "edit", undefined, { frame: input.frame },
  );
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
  return runLocalDesignMutation(workspaceId, async (assertOwner) =>
    executeWithFreshGenerationRetry(
      workspaceId,
      input.frame,
      resolveLocalFrameSourceVersion(
        workspaceId,
        input.frame,
        input.sourceVersion,
      ),
      async (sourceVersion) => {
        assertOwner();
        const result = await designSetText(workspaceId, {
          ...input,
          sourceVersion,
        });
        assertOwner();
        recordLocalFrameGeneration(
          workspaceId,
          input.frame,
          sourceVersion,
          result.snapshot.frames.find((frame) => frame.file === input.frame)
            ?.sourceVersion,
        );
        const snapshot = publishDesignWorkspaceSnapshot(
          workspaceId,
          result.snapshot,
        );
        settleFoundationMutation(
          workspaceId,
          input.frame,
          snapshot,
          result.foundationRevision,
        );
        return result.mutation;
      },
    ),
  );
}

/** Append one engine-validated HTML fragment and publish the exact mutation
 * snapshot. Text insertion uses this structural path once, after live typing
 * has finished in the canvas overlay. */
export async function appendDesignNodeHtmlCached(
  workspaceId: string,
  input: {
    frame: string;
    nodeId: string;
    sourceVersion: string;
    html: string;
  },
): Promise<{
  mutation: DesignMutationResultWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return runLocalDesignMutation(workspaceId, async (assertOwner) =>
    executeWithFreshGenerationRetry(
      workspaceId,
      input.frame,
      resolveLocalFrameSourceVersion(
        workspaceId,
        input.frame,
        input.sourceVersion,
      ),
      async (sourceVersion) => {
        assertOwner();
        const result = await designWriteHtml(workspaceId, {
          ...input,
          sourceVersion,
          mode: "append",
        });
        assertOwner();
        recordLocalFrameGeneration(
          workspaceId,
          input.frame,
          sourceVersion,
          result.snapshot.frames.find((frame) => frame.file === input.frame)
            ?.sourceVersion,
        );
        const snapshot = publishDesignWorkspaceSnapshot(
          workspaceId,
          result.snapshot,
        );
        settleFoundationMutation(
          workspaceId,
          input.frame,
          snapshot,
          result.foundationRevision,
        );
        return { mutation: result.mutation, snapshot };
      },
    ),
  );
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
  return runLocalDesignMutation(workspaceId, async (assertOwner) =>
    executeWithFreshGenerationRetry(
      workspaceId,
      input.frame,
      resolveLocalFrameSourceVersion(
        workspaceId,
        input.frame,
        input.sourceVersion,
      ),
      async (sourceVersion) => {
        assertOwner();
        const result = await designInsertAsset(workspaceId, {
          ...input,
          sourceVersion,
        });
        assertOwner();
        recordLocalFrameGeneration(
          workspaceId,
          input.frame,
          sourceVersion,
          result.snapshot.frames.find((frame) => frame.file === input.frame)
            ?.sourceVersion,
        );
        const snapshot = publishDesignWorkspaceSnapshot(
          workspaceId,
          result.snapshot,
        );
        settleFoundationMutation(
          workspaceId,
          input.frame,
          snapshot,
          result.foundationRevision,
        );
        return result.mutation;
      },
    ),
  );
}

export async function saveDesigns(workspaceId: string): Promise<{ ok: true }> {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const result = await designSave(workspaceId);
    assertOwner();
    invalidateDesignWorkspaceSnapshot(workspaceId);
    return result;
  });
}

export async function stageDesigns(workspaceId: string): Promise<{ ok: true }> {
  return runLocalDesignMutation(workspaceId, () => designStage(workspaceId));
}

export async function commitDesigns(
  workspaceId: string,
  message?: string,
): Promise<{ sha: string; branch: string }> {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const result = await designCommit(workspaceId, message);
    assertOwner();
    invalidateDesignWorkspaceSnapshot(workspaceId);
    return result;
  });
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
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const execute = async (sourceVersion: string) => {
      assertOwner();
      const previous =
        designWorkspaceSnapshotCache.getSnapshot(workspaceId).data ?? null;
      const result = await designUpdateToken(workspaceId, {
        ...input,
        sourceVersion,
      });
      assertOwner();
      recordLocalGeneration(
        localTokenGenerationByWorkspace,
        workspaceId,
        sourceVersion,
        result.snapshot.tokenSourceVersion,
      );
      await Promise.all(
        (previous?.frames ?? []).map((previousFrame) =>
          adoptDesignStyleGeneration(
            workspaceId,
            previousFrame.file,
            previousFrame.sourceVersion,
            result.snapshot.frames.find(
              (candidate) => candidate.file === previousFrame.file,
            )?.sourceVersion,
            [],
            {
              tokens: [
                {
                  name: input.name,
                  theme: input.theme,
                  value: input.value,
                },
              ],
            },
          ),
        ),
      );
      assertOwner();
      for (const previousFrame of previous?.frames ?? []) {
        recordLocalFrameGeneration(
          workspaceId,
          previousFrame.file,
          previousFrame.sourceVersion,
          result.snapshot.frames.find(
            (candidate) => candidate.file === previousFrame.file,
          )?.sourceVersion,
        );
      }
      const snapshot = publishDesignWorkspaceSnapshot(
        workspaceId,
        result.snapshot,
      );
      settleFoundationMutation(
        workspaceId,
        input.frame,
        snapshot,
        result.foundationRevision,
      );
      return snapshot;
    };
    const requested = resolveLocalGeneration(
      localTokenGenerationByWorkspace.get(workspaceId),
      input.sourceVersion,
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).data
        ?.tokenSourceVersion,
    );
    try {
      return await execute(requested);
    } catch (error) {
      if (!isStaleDesignGenerationError(error)) throw error;
      let fresh: string | undefined;
      try {
        fresh = (await refreshDesignWorkspaceSnapshot(workspaceId))
          .tokenSourceVersion;
      } catch {
        throw error;
      }
      if (!fresh || fresh === requested) throw error;
      return await execute(fresh);
    }
  });
}

/** Geometry is already complete in the mutation response. Publish it directly
 * so drag release cannot snap back while a bridge refresh is in flight. */
export async function updateDesignFrameGeometryCached(
  workspaceId: string,
  frameFile: string,
  geometry: DesignFrameGeometryWire,
  changedFields?: readonly (keyof DesignFrameGeometryWire)[],
): Promise<DesignFrameGeometryWire> {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const beforeSnapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const previousSourceVersion = currentFrameSourceVersion(
      workspaceId,
      frameFile,
    );
    const currentFrame = designWorkspaceSnapshotCache
      .peekSnapshot(workspaceId)
      .data?.frames.find((frame) => frame.file === frameFile);
    const currentGeometry = currentFrame
      ? {
          x: currentFrame.x,
          y: currentFrame.y,
          w: currentFrame.width,
          h: currentFrame.height,
          z: currentFrame.z,
        }
      : geometry;
    const nextGeometry = changedFields
      ? changedFields.reduce(
          (next, field) => ({ ...next, [field]: geometry[field] }),
          currentGeometry,
        )
      : geometry;
    const result = await designUpdateCanvas(
      workspaceId,
      frameFile,
      nextGeometry,
    );
    assertOwner();
    recordLocalFrameGeneration(
      workspaceId,
      frameFile,
      previousSourceVersion,
      result.snapshot.frames.find((frame) => frame.file === frameFile)
        ?.sourceVersion,
    );
    const snapshot = publishDesignWorkspaceSnapshot(
      workspaceId,
      result.snapshot,
    );
    recordGeometryHistory(workspaceId, beforeSnapshot, snapshot);
    settleFoundationMutation(
      workspaceId,
      frameFile,
      snapshot,
      result.foundationRevision,
    );
    return result.geometry;
  }, "edit", undefined, { geometry: true });
}

/** Several canvas frames moved together in one write and one undo step. The
 * confirmed snapshot is published directly, so release cannot snap back. */
export async function moveDesignFramesCached(
  workspaceId: string,
  moves: readonly {
    frame: string;
    from: DesignFrameGeometryWire;
    to: DesignFrameGeometryWire;
  }[],
): Promise<DesignWorkspaceSnapshotWire> {
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const beforeSnapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const result = await designMoveFrames(workspaceId, moves);
    assertOwner();
    const snapshot = publishDesignWorkspaceSnapshot(workspaceId, result);
    recordGeometryHistory(workspaceId, beforeSnapshot, snapshot);
    settleFoundationMutation(workspaceId, null, snapshot);
    return snapshot;
  }, "edit", undefined, { geometry: true });
}

type DesignEditIntent = Omit<DesignTransaction, "documentId" | "baseRevision">;
interface DesignMeasuredMovement {
  movementGuard: DesignMovementGuard;
  isCurrent: () => boolean;
}

/** Capture an edit's owner/operations immediately, then join its exact document
 * read inside the mutation lane. A ready runtime does not imply the inspector's
 * Foundation hook has rendered yet; loading metadata must neither reject the
 * edit nor let later writes or Undo overtake it. An intent built from current
 * state (frame geometry that an earlier queued edit may still change) passes a
 * function, evaluated in the lane once every earlier edit has confirmed. */
export function applyDesignEditCached(
  workspaceId: string,
  {
    file,
    sourceVersion,
  }: Pick<DesignFrameDocumentWire, "file" | "sourceVersion">,
  intent: DesignEditIntent | (() => DesignEditIntent),
  measured?: DesignMeasuredMovement,
  options?: { structurePreviewId?: string },
): Promise<DesignApiMutationReplyWire> {
  return applyPreparedDesignTransactionCached(workspaceId, file, async () => {
    const key = designFoundationKey(
      workspaceId,
      file,
      measured ? sourceVersion : resolveLocalFrameSourceVersion(workspaceId, file, sourceVersion),
    );
    const foundation = await designFoundationCache.load(
      key,
      () => fetchDesignFoundation(key),
      { maxAgeMs: Number.POSITIVE_INFINITY },
    );
    return {
      ...(typeof intent === "function" ? intent() : intent),
      documentId: foundation.summary.documentId,
      baseRevision: foundation.summary.revision,
    };
  }, measured, undefined, options?.structurePreviewId);
}

export function applyDesignTransactionCached(
  workspaceId: string,
  frame: string,
  transaction: DesignTransaction,
  options?: {
    /** Structured twins of this transaction's `node.set-html` appends. When
     * every append has one, the live runtime adopts the new generation in
     * place instead of reloading its document. */
    runtimeInserts?: readonly DesignRuntimeNodeInsert[];
  },
): Promise<DesignApiMutationReplyWire> {
  return applyPreparedDesignTransactionCached(
    workspaceId,
    frame,
    async () => transaction,
    undefined,
    options?.runtimeInserts,
  );
}

async function applyPreparedDesignTransactionCached(
  workspaceId: string,
  frame: string,
  prepare: () => Promise<DesignTransaction>,
  measured?: DesignMeasuredMovement,
  runtimeInserts?: readonly DesignRuntimeNodeInsert[],
  structurePreviewId?: string,
): Promise<DesignApiMutationReplyWire> {
  const presentation: LocalEditPresentation = { frame, ready: false };
  return runLocalDesignMutation(workspaceId, async (assertOwner) => {
    const assertCurrent = () => {
      assertOwner();
      if (measured && (!measured.isCurrent() || currentFrameSourceVersion(workspaceId, frame) !== measured.movementGuard.sourceVersion))
        throw new Error("The measured movement changed or retired. Select the layer again before moving it.");
    };
    assertCurrent();
    const transaction = await prepare();
    const visual = transactionRuntimeAdoption(transaction, runtimeInserts, structurePreviewId);
    presentation.ready = !!visual && !visual.patch?.tokens && !visual.patch?.keyframes;
    assertCurrent();
    const revisionKey = frameMutationKey(workspaceId, frame);
    const execute = async () => {
      const baseRevision = measured ? transaction.baseRevision : await resolveFoundationBaseRevision(
        workspaceId,
        frame,
        transaction.baseRevision,
      );
      const rebasedTransaction =
        baseRevision === transaction.baseRevision
          ? transaction
          : { ...transaction, baseRevision };
      const previousSourceVersion =
        currentFrameSourceVersion(workspaceId, frame) ??
        designFrameRuntime(workspaceId, frame)?.sourceVersion;
      const beforeSnapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
      const beforeState = historyStateKey(beforeSnapshot);
      assertCurrent();
      const result = measured
        ? await designApplyTransaction(workspaceId, frame, rebasedTransaction, false, measured.movementGuard)
        : await designApplyTransaction(workspaceId, frame, rebasedTransaction);
      assertOwner();
      recordLocalGeneration(
        localFoundationRevisionByFrame,
        revisionKey,
        baseRevision,
        result.result?.revision,
      );
      if (result.snapshot) {
        result.snapshot = projectDesignMutationSnapshot(beforeSnapshot, result.snapshot);
        const nextSourceVersion = result.snapshot.frames.find(
          (candidate) => candidate.file === frame,
        )?.sourceVersion;
        recordLocalFrameGeneration(
          workspaceId,
          frame,
          previousSourceVersion,
          nextSourceVersion,
        );
        const adoption = transactionRuntimeAdoption(rebasedTransaction, runtimeInserts, structurePreviewId);
        if (adoption && previousSourceVersion) {
          const adopted = await adoptDesignStyleGeneration(
            workspaceId,
            frame,
            previousSourceVersion,
            nextSourceVersion,
            adoption.styleUpdates,
            adoption.patch,
          );
          assertOwner();
          if (adopted && nextSourceVersion)
            historyPreview.record(
              workspaceId,
              frame,
              previousSourceVersion,
              nextSourceVersion,
              beforeState,
              historyStateKey(result.snapshot),
              rebasedTransaction.coalesceKey,
              rebasedTransaction.createdAt,
              changedHistoryGeometry(beforeSnapshot, result.snapshot),
            );
        }
        if (Array.isArray(rebasedTransaction.operations) && rebasedTransaction.operations.every(operation => operation.type === "frame.set-geometry"))
          recordGeometryHistory(workspaceId, beforeSnapshot, result.snapshot);
        const snapshot = publishDesignWorkspaceSnapshot(
          workspaceId,
          result.snapshot,
        );
        settleFoundationMutation(
          workspaceId,
          frame,
          snapshot,
          result.result
            ? {
                before: result.result.receipt.beforeRevision,
                after: result.result.receipt.afterRevision,
              }
            : { before: baseRevision, after: baseRevision },
        );
        for (const update of adoption?.styleUpdates ?? []) {
          clearCommittedDesignLivePreviewStyles(
            workspaceId,
            frame,
            update.nodeId,
            update.styles,
          );
        }
      }
      if (!result.snapshot) {
        staleFoundationRevisionByFrame.delete(revisionKey);
      }
      return result;
    };
    try {
      return await execute();
    } catch (error) {
      if (measured || !isStaleDesignGenerationError(error)) throw error;
      // Refresh first so the retry opens the foundation for the engine's
      // current generation, then let the stale flag re-resolve the base
      // revision. The rejected transaction never applied, so one replay
      // against the fresh document is exactly the user's intended edit.
      try {
        await refreshDesignWorkspaceSnapshot(workspaceId);
      } catch {
        throw error;
      }
      markFoundationRevisionStale(workspaceId, frame);
      return await execute();
    }
  }, "edit", undefined, presentation);
}

/** An append is adoptable only through the structured insert its author
 * supplied: the same parent, the end position the engine writes, and the
 * exact `data-oid` it carries. Markup is never re-parsed here. */
function adoptableInsert(
  operation: DesignTransaction["operations"][number],
  runtimeInserts: readonly DesignRuntimeNodeInsert[] | undefined,
): DesignRuntimeNodeInsert | null {
  if (operation.type !== "node.set-html" || operation.mode !== "append") return null;
  const insert = runtimeInserts?.find((candidate) => candidate.parentId === operation.nodeId &&
    candidate.beforeId === null &&
    operation.html === `<div data-oid="${candidate.nodeId}" style="${candidate.style}"></div>`);
  return insert ?? null;
}

function transactionRuntimeAdoption(
  transaction: DesignTransaction,
  runtimeInserts?: readonly DesignRuntimeNodeInsert[],
  structurePreviewId?: string,
): {
  styleUpdates: Array<{
    nodeId: string;
    styles: Record<string, string | null>;
  }>;
  patch?: DesignRuntimeGenerationPatch;
} | null {
  if (
    !Array.isArray(transaction.operations) ||
    transaction.operations.length > 256 ||
    transaction.operations.some(
      (operation) =>
        operation.type !== "node.set-styles" &&
        operation.type !== "node.move" &&
        operation.type !== "node.duplicate" &&
        operation.type !== "node.delete" &&
        operation.type !== "frame.set-geometry" &&
        operation.type !== "keyframes.set" &&
        !adoptableInsert(operation, runtimeInserts),
    )
  ) {
    return null;
  }
  const inserts: DesignRuntimeNodeInsert[] = [];
  const structure: NonNullable<DesignRuntimeGenerationPatch["structure"]> = [];
  const moves: NonNullable<DesignRuntimeGenerationPatch["moves"]> = [];
  const stylesByNode = new Map<string, Record<string, string | null>>();
  const keyframes: NonNullable<DesignRuntimeGenerationPatch["keyframes"]> = [];
  for (const operation of transaction.operations) {
    if (operation.type === "frame.set-geometry") continue;
    if (operation.type === "node.duplicate" || operation.type === "node.delete") {
      // The runtime applies structures before styles and placements. A copy
      // after a style edit must include that edit in its source; reloading is
      // the safe path for transaction orders this projection cannot preserve.
      if (stylesByNode.size || moves.length || inserts.length || keyframes.length) return null;
      structure.push(operation.type === "node.duplicate"
        ? { type: "duplicate", nodeId: operation.nodeId, duplicateNodeId: operation.duplicateNodeId }
        : { type: "delete", nodeId: operation.nodeId });
      continue;
    }
    const insert = adoptableInsert(operation, runtimeInserts);
    if (insert) {
      inserts.push(insert);
      continue;
    }
    if (operation.type === "node.move") {
      moves.push({
        nodeId: operation.nodeId,
        parentId: operation.parentId,
        beforeId: operation.beforeId,
      });
      continue;
    }
    if (operation.type === "keyframes.set") {
      keyframes.push({
        name: operation.name,
        keyframes: operation.keyframes.map((keyframe) => ({
          offset: keyframe.offset,
          styles: { ...keyframe.styles },
        })),
      });
      continue;
    }
    if (operation.type !== "node.set-styles") return null;
    if (Object.keys(operation.styles).length > 0) {
      stylesByNode.set(operation.nodeId, {
        ...stylesByNode.get(operation.nodeId),
        ...operation.styles,
      });
    }
  }
  const styleUpdates = [...stylesByNode].map(([nodeId, styles]) => ({
    nodeId,
    styles,
  }));
  if (structure.length && (keyframes.length || inserts.length || moves.some(move =>
    !structure.some(operation => operation.type === "duplicate" && operation.duplicateNodeId === move.nodeId)))) return null;
  if (styleUpdates.length === 0 && keyframes.length === 0 && moves.length === 0 && inserts.length === 0 && structure.length === 0)
    return null;
  return {
    styleUpdates,
    ...(keyframes.length > 0 || moves.length > 0 || inserts.length > 0 || structure.length > 0
      ? {
          patch: {
            ...(keyframes.length ? { keyframes } : {}),
            ...(moves.length ? { moves } : {}),
            ...(inserts.length ? { inserts } : {}),
            ...(structure.length ? { structure } : {}),
            ...(structure.length && structurePreviewId ? { structurePreviewId } : {}),
          },
        }
      : {}),
  };
}

/**
 * Keep the painted document mounted for style-only writes. The engine remains
 * authoritative; any missing/stale runtime safely falls back to the normal
 * source navigation when the aggregate snapshot is published.
 */
async function adoptDesignStyleGeneration(
  workspaceId: string,
  frame: string,
  previousSourceVersion: string,
  nextSourceVersion: string | undefined,
  updates: Array<{
    nodeId: string;
    styles: Record<string, string | null>;
  }>,
  patch?: DesignRuntimeGenerationPatch,
): Promise<boolean> {
  if (
    !nextSourceVersion ||
    nextSourceVersion === previousSourceVersion ||
    (updates.length < 1 && !patch) ||
    designRuntimeFrameState(workspaceId, frame)?.sourceVersion !==
      previousSourceVersion
  ) {
    return false;
  }
  const runtime = designFrameRuntime(workspaceId, frame);
  if (!runtime || runtime.sourceVersion !== previousSourceVersion) return false;
  const owner = designMutationOwner(workspaceId);
  const current = () => designMutationOwner(workspaceId) === owner &&
    designFrameRuntime(workspaceId, frame) === runtime && runtime.isActive?.() !== false;
  if (!current()) return false;
  // An older runtime would ignore inserts it cannot adopt; reload instead.
  if (patch?.inserts?.length && !runtime.supports("previewInsert")) return false;
  if (patch?.structure?.length && !runtime.supports("commitStructure")) return false;
  try {
    const adopted = patch
      ? await runtime.commitStyles(updates, nextSourceVersion, patch)
      : await runtime.commitStyles(updates, nextSourceVersion);
    if (!current()) return false;
    const runtimeStore = useDesignRuntimeStore.getState();
    const updatedNodeIds = new Set(
      adopted.details.map((details) => details.oid),
    );
    const cachedFrame = runtimeStore.byWorkspace[workspaceId]?.frames[frame];
    const affectedParents = new Set(
      adopted.details
        .map((details) => details.layout?.parentId)
        .filter(Boolean),
    );
    for (const operation of patch?.structure ?? []) {
      const parent = cachedFrame?.detailsByNode[operation.nodeId]?.layout?.parentId;
      if (parent) affectedParents.add(parent);
    }
    if (adopted.snapshot.frame.oid) updatedNodeIds.add(adopted.snapshot.frame.oid);
    // A layout change (padding, a gap, a size) can move boxes it never
    // touched: children, siblings, the whole flow after it. Only what is
    // measured again below is promoted; every other cached box is dropped and
    // read again on demand, never relabelled as the new generation's geometry.
    const layoutChanged =
      Boolean(patch) ||
      updates.some((update) =>
        Object.keys(update.styles).some(designStylePropertyAffectsLayout),
      );
    const selectedNodeIds = new Set(
      useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]
        ?.selectedNodeIds ?? [],
    );
    // Container geometry can stay identical while its children's constraints
    // change. Refresh those retained aggregates before promoting the generation;
    // rebasing their old values would make them look like confirmed new data.
    const historyPresented = historyVisualRuntimeByWorkspace.has(workspaceId);
    const refreshNodeIds = (historyPresented ? [] : cachedFrame?.detailOrder ?? [])
      .filter(
        (nodeId) =>
          !updatedNodeIds.has(nodeId) &&
          ((patch && !patch.structure) ||
            affectedParents.has(nodeId) ||
            (layoutChanged && selectedNodeIds.has(nodeId)) ||
            cachedFrame?.detailsByNode[nodeId]?.childrenLayout?.nodeIds.some(
              (childId) => updatedNodeIds.has(childId),
            )),
      )
      .slice(-64);
    const refreshedDetails = (
      await Promise.all(
        refreshNodeIds.map((nodeId) =>
          runtime.getNodeDetails(nodeId).catch(() => null),
        ),
      )
    ).filter((details) => details !== null);
    if (!current()) return false;
    const promoted = runtimeStore.adoptFrameGeneration(
      workspaceId,
      frame,
      previousSourceVersion,
      nextSourceVersion,
      adopted.snapshot,
      [...adopted.details, ...refreshedDetails],
      adopted.treeUnchanged,
      { dropUnrefreshed: layoutChanged || historyPresented },
    );
    const folder = runtimeStore.byWorkspace[workspaceId]?.folder;
    if (promoted && folder) {
      scheduleAdoptedFrameSettlement(
        workspaceId,
        folder,
        frame,
        nextSourceVersion,
      );
    }
    return promoted;
  } catch {
    return false;
  }
}

export async function applyDesignHistoryCached(
  workspaceId: string,
  frame: string | null,
  direction: "undo" | "redo",
): Promise<DesignApiMutationReplyWire> {
  const owner = designMutationOwner(workspaceId);
  const livePreviewSequence = designLivePreviewSequence();
  const view = useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId];
  const selectionOwner = { ownerRevision: view?.ownerRevision, selectionEvent: view?.selectionEvent };
  const currentOwner = () => designMutationOwner(workspaceId) === owner;
  const activeRuntime = (file: string) => {
    if (!currentOwner()) return null;
    const runtime = designFrameRuntime(workspaceId, file);
    return runtime?.isActive?.() === false ? null : runtime;
  };
  const previousVisual = historyVisualIntentByWorkspace.get(workspaceId);
  const visualIntent = { sequence: ++nextHistoryIntent, target: null as DesignHistoryPrediction | null };
  retainHistoryVisualIntent(workspaceId, visualIntent);
  const releaseVisual = () => {
    clearHistoryVisualRuntimes(workspaceId);
    clearDesignHistoryPresentation(workspaceId);
  };
  const paint = (next: DesignHistoryPrediction | null, allowLegacy: boolean) => {
    if (!next) return false;
    const latest = historyVisualIntentByWorkspace.get(workspaceId);
    // A newer step with a safe inverse owns the pixels. A queued step without
    // one still lets earlier confirmed predictions paint as its lane advances.
    if (latest && latest.sequence > visualIntent.sequence && latest.target) return false;
    const runtime = next.kind === "generation" ? activeRuntime(next.frame) : null;
    const isolated = runtime?.supports("previewHistory") && runtime.previewHistory;
    if (next.kind === "generation" && (!runtime || (!isolated && !allowLegacy))) return false;
    visualIntent.target = next;
    if ((!latest || latest.sequence <= visualIntent.sequence) && !retainHistoryVisualIntent(workspaceId, visualIntent)) return false;
    presentDesignHistory(workspaceId, visualIntent, { ...(next.kind === "catalog" ? { catalog: next.catalog } : { geometry: next.geometry }),
      selection: next.selection, selectionOwner });
    if (next.kind === "generation" && runtime?.supports("restoreGeneration")) {
      const measure = (useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]?.selectedNodeIds ?? []).slice(0, 64);
      if (isolated) {
        rememberHistoryVisualRuntime(workspaceId, next.frame, runtime);
      }
      const request = isolated ? runtime.previewHistory!(next.target, measure)
        : measure.length ? runtime.restoreGeneration(next.target, false, undefined, measure) : runtime.restoreGeneration(next.target, false);
      const target = new WeakRef(next);
      void request.then(restored => {
        const prediction = target.deref();
        if (restored && prediction?.kind === "generation" && activeRuntime(prediction.frame) === runtime && visualIntent.target === prediction)
          presentDesignHistoryRuntime(workspaceId, visualIntent, prediction.frame, restored, livePreviewSequence);
      }).catch(() => { clearDesignHistoryPresentation(workspaceId, visualIntent); });
    }
    return true;
  };
  const predict = () => {
    const next = historyPreview.take(workspaceId,
      historyStateKey(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data), direction);
    paint(next, true);
    return next;
  };
  // An edit still saving will adopt its generation on top of whatever is
  // painted; a predicted inverse painted first would be recorded as that
  // edit's baseline and undone to the wrong state. Predict once earlier edits
  // have landed, inside the lane, still ahead of this history round trip.
  const afterPendingEdits =
    pendingEditCountByWorkspace.has(workspaceId) ||
    deferredPredictionCountByWorkspace.has(workspaceId);
  let awaitingPrediction = afterPendingEdits;
  if (awaitingPrediction) adjustCount(deferredPredictionCountByWorkspace, workspaceId, 1);
  const settlePrediction = () => {
    if (!awaitingPrediction) return;
    awaitingPrediction = false;
    adjustCount(deferredPredictionCountByWorkspace, workspaceId, -1);
  };
  if (afterPendingEdits) {
    const edit = pendingEditPresentationByWorkspace.get(workspaceId)?.at(-1);
    const early = edit && edit.sequence > (previousVisual?.sequence ?? 0)
      ? direction === "undo" && edit.input.ready !== false ? edit.before : null
      : previousVisual?.target ? historyPreview.peek(workspaceId, previousVisual.target.state, direction) : null;
    paint(early, false);
  }
  // A queued operation does not keep an evicted catalog vector/geometry map
  // alive. The journal and bounded visual holder own optional predictions.
  const weakPrediction = (value: DesignHistoryPrediction | null) => value ? new WeakRef(value) : null;
  let predictionRef = afterPendingEdits ? null : weakPrediction(predict());
  // Port order puts this repaint ahead of any later step's runtime request.
  const recover = () => {
    settlePrediction();
    if (!currentOwner()) return;
    historyPreview.clear(workspaceId);
    releaseVisual();
    historyVisualIntentByWorkspace.delete(workspaceId);
    const prediction = predictionRef?.deref();
    if (prediction?.kind !== "generation") return;
    const runtime = activeRuntime(prediction.frame);
    if (runtime?.supports("restoreGeneration") && !runtime.supports("previewHistory"))
      void runtime.restoreGeneration(runtime.sourceVersion, false).catch(() => {});
  };
  return runLocalDesignMutation(workspaceId, async () => {
    if (awaitingPrediction) {
      predictionRef = weakPrediction(predict());
      settlePrediction();
    }
    const previousSourceVersions = new Map(
      (
        designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames ??
        []
      ).map((candidate) => [candidate.file, candidate.sourceVersion]),
    );
    const result = await designHistory(workspaceId, frame, direction,
      isCloudWorkspace(workspaceId) ? Object.fromEntries(previousSourceVersions) : undefined);
    const prediction = predictionRef?.deref();
    assertDesignMutationOwner(workspaceId, owner);
    const historyFrame = result.historyFrame ?? (result.result ? frame : null);
    const revisionKey = historyFrame
      ? frameMutationKey(workspaceId, historyFrame)
      : null;
    const previousRevision = revisionKey
      ? localFoundationRevisionByFrame.get(revisionKey)?.current
      : undefined;
    if (revisionKey) {
      recordLocalGeneration(
        localFoundationRevisionByFrame,
        revisionKey,
        previousRevision,
        result.result?.revision,
      );
    }
    if (result.snapshot) {
      if (historyFrame) {
        recordLocalFrameGeneration(
          workspaceId,
          historyFrame,
          previousSourceVersions.get(historyFrame),
          result.snapshot.frames.find(
            (candidate) => candidate.file === historyFrame,
          )?.sourceVersion,
        );
      }
      const restoredFrame = historyFrame ?? prediction?.frame;
      const target = result.snapshot.frames.find(
        (candidate) => candidate.file === restoredFrame,
      )?.sourceVersion;
      if (prediction) {
        if (historyStateKey(result.snapshot) === prediction.state)
          historyPreview.confirm(
            workspaceId,
            prediction,
            historyStateKey(result.snapshot),
          );
        else {
          historyPreview.clear(workspaceId);
          clearDesignHistoryPresentation(workspaceId);
        }
      }
      if (restoredFrame && target) {
        const runtime = activeRuntime(restoredFrame);
        if (runtime?.supports("restoreGeneration")) {
          const previous = runtime.sourceVersion;
          try {
            // History can move any box. The selection is measured in the
            // same restore; every other cached box is read again on demand
            // rather than relabelled as the restored generation's geometry.
            const restored = await runtime.restoreGeneration(
              target,
              true,
              undefined,
              (
                useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]
                  ?.selectedNodeIds ?? []
              ).slice(0, 64),
            );
            assertDesignMutationOwner(workspaceId, owner);
            if (activeRuntime(restoredFrame) === runtime) {
              useDesignRuntimeStore
                .getState()
                .adoptFrameGeneration(
                  workspaceId,
                  restoredFrame,
                  previous,
                  target,
                  restored.snapshot,
                  restored.details,
                  restored.treeUnchanged,
                  { dropUnrefreshed: true },
                );
              const pendingTarget = historyPreview.pendingTarget(
                workspaceId,
                restoredFrame,
              );
              if (pendingTarget && !runtime.supports("previewHistory"))
                await runtime.restoreGeneration(pendingTarget, false);
            }
          } catch {
            /* Unknown generations fall back to the authoritative document. */
          }
        }
      }
      assertDesignMutationOwner(workspaceId, owner);
      const snapshot = publishDesignWorkspaceSnapshot(
        workspaceId,
        result.snapshot,
      );
      if (historyVisualIntentByWorkspace.get(workspaceId) === visualIntent) {
        releaseVisual();
        historyVisualIntentByWorkspace.delete(workspaceId);
      }
      settleFoundationMutation(
        workspaceId,
        historyFrame,
        snapshot,
        result.result
          ? {
              before: result.result.receipt.beforeRevision,
              after: result.result.receipt.afterRevision,
            }
          : previousRevision
            ? { before: previousRevision, after: previousRevision }
            : undefined,
      );
    }
    if (!result.snapshot) {
      historyPreview.clear(workspaceId);
      releaseVisual();
      if (historyVisualIntentByWorkspace.get(workspaceId) === visualIntent) historyVisualIntentByWorkspace.delete(workspaceId);
      invalidateWorkspaceDesignFoundations(workspaceId);
    }
    return result;
  }, "history", recover);
}

/** Test-only reset for exact-key/reference-stability coverage. */
export function resetDesignWorkspaceCacheForTests(): void {
  designSourceVectorCache.clear();
  historyPreview.clear();
  clearDesignHistoryPresentation();
  for (const cancel of pendingAdoptedSettlementByFrame.values()) cancel();
  pendingAdoptedSettlementByFrame.clear();
  pendingLocalMutationByWorkspace.clear();
  pendingEditCountByWorkspace.clear();
  deferredPredictionCountByWorkspace.clear();
  historyVisualIntentByWorkspace.clear();
  historyVisualRuntimeByWorkspace.clear();
  pendingEditPresentationByWorkspace.clear();
  localMutationTailByWorkspace.clear();
  localFrameGenerationByOwner.clear();
  localTokenGenerationByWorkspace.clear();
  localFoundationRevisionByFrame.clear();
  staleFoundationRevisionByFrame.clear();
  retainedRuntimeAuditByFrame.clear();
  runtimeAuditSettlementByFrame.clear();
  designWorkspaceSnapshotCache.clear();
  designFrameDocumentCache.clear();
  designFoundationCache.clear();
  resetDesignWorkspaceBootCacheForTests();
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
  const localMutation = pendingLocalMutationByWorkspace.get(workspaceId);
  if (localMutation) {
    localMutation.deferredRefresh = true;
    return;
  }
  invalidateDesignWorkspaceSnapshot(workspaceId);
}

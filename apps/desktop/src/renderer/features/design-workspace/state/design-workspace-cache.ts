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
  designStage,
  designSetText,
  designSnapshot,
  designUpdateToken,
  designUpdateCanvas,
  designUpdateStyles,
  designWriteHtml,
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
import type { DesignRuntimeGenerationPatch } from "@zeros/protocol/design-runtime";
import { KeyedAsyncCache } from "../../../shared/lib/keyed-async-cache";
import { onActiveBridgeConnected } from "../../../platform/bridge/active-bridge";
import { classifyRpcError } from "../../../platform/bridge/failure";
import { designFrameRuntime } from "../../../platform/bridge/design-frame-runtime";
import { clearCommittedDesignLivePreviewStyles } from "./design-live-preview";
import {
  designRuntimeFrameState,
  useDesignRuntimeStore,
} from "./design-runtime-store";
import {
  captureDesignRuntimeScreenshot,
  persistDesignRuntimeAuditSnapshot,
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

async function runLocalDesignMutation<T>(
  workspaceId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const finishMutation = beginLocalDesignMutation(workspaceId);
  const previous = localMutationTailByWorkspace.get(workspaceId);
  const result = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(mutation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  localMutationTailByWorkspace.set(workspaceId, tail);
  try {
    return await result;
  } finally {
    finishMutation();
    if (localMutationTailByWorkspace.get(workspaceId) === tail) {
      localMutationTailByWorkspace.delete(workspaceId);
    }
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
  return designWorkspaceSnapshotCache
    .peekSnapshot(workspaceId)
    .data?.frames.find((candidate) => candidate.file === frame)?.sourceVersion;
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
    if (!runtime || runtime.sourceVersion !== sourceVersion) return;
    const snapshot = await runtime.getSnapshot();
    if (
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
    void settleAudit().catch(() => {
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

/** Warm one exact rendered source on selection or explicit pointer/focus
 * intent. Concurrent iframe/code-view consumers share the same request. */
export function warmDesignFrameDocument(
  workspaceId: string,
  frame: string,
  sourceVersion: string,
): void {
  const key = designFrameDocumentKey(workspaceId, frame, sourceVersion);
  void designFrameDocumentCache
    .load(key, () => fetchDesignFrameDocument(key), {
      maxAgeMs: DESIGN_FRAME_DOCUMENT_MAX_AGE_MS,
    })
    .catch(() => {});
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
    left.title === right.title &&
    left.kind === right.kind &&
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
  const previous = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
  if ((pendingLocalMutationByWorkspace.get(workspaceId)?.depth ?? 0) > 0) {
    rememberAdvancedFrameRuntimeAudits(workspaceId, previous, next);
  }
  const retained = applyRetainedRuntimeAuditViolations(workspaceId, next);
  const stable = stabilizeDesignWorkspaceSnapshot(previous, retained);
  designWorkspaceSnapshotCache.setData(workspaceId, stable);
  queueDesignWorkspaceBootSnapshot(workspaceId, stable);
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
    const current = designWorkspaceSnapshotCache
      .peekSnapshot(input.workspaceId)
      .data?.frames.find((candidate) => candidate.file === input.frame);
    if (current?.sourceVersion !== input.sourceVersion) return;
    const persisted = await persistDesignRuntimeAuditSnapshot(input);
    if (!persisted) return;
    const authoritative = await designSnapshot(input.workspaceId);
    if (
      authoritative.frames.find((candidate) => candidate.file === input.frame)
        ?.sourceVersion !== input.sourceVersion ||
      designWorkspaceSnapshotCache
        .peekSnapshot(input.workspaceId)
        .data?.frames.find((candidate) => candidate.file === input.frame)
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
): Promise<DesignWorkspaceSnapshotWire> {
  const next = await executeDesignReadWithTransientRetry(() =>
    designSnapshot(workspaceId),
  );
  const stable = stabilizeDesignWorkspaceSnapshot(
    designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data,
    applyRetainedRuntimeAuditViolations(workspaceId, next),
  );
  queueDesignWorkspaceBootSnapshot(workspaceId, stable);
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
    () => fetchDesignWorkspaceSnapshot(workspaceId),
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
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return runLocalDesignMutation(workspaceId, async () => {
    const result = await designCreateFrame(workspaceId, title, geometry, seed);
    const snapshot = publishDesignWorkspaceSnapshot(
      workspaceId,
      result.snapshot,
    );
    settleFoundationMutation(workspaceId, null, snapshot);
    return {
      frame: result.frame,
      snapshot,
    };
  });
}

export async function renameDesignFrameAndRefresh(
  workspaceId: string,
  frame: string,
  title: string,
): Promise<DesignWorkspaceSnapshotWire> {
  return runLocalDesignMutation(workspaceId, async () => {
    const result = await designRenameFrame(workspaceId, frame, title);
    const snapshot = publishDesignWorkspaceSnapshot(
      workspaceId,
      result.snapshot,
    );
    settleFoundationMutation(workspaceId, null, snapshot);
    return snapshot;
  });
}

export async function duplicateDesignFrameCached(
  workspaceId: string,
  frame: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  return runLocalDesignMutation(workspaceId, async () => {
    const result = await designDuplicateFrame(workspaceId, frame);
    const snapshot = publishDesignWorkspaceSnapshot(
      workspaceId,
      result.snapshot,
    );
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
  return runLocalDesignMutation(workspaceId, async () => {
    const result = await designDeleteFrame(workspaceId, frame);
    const snapshot = publishDesignWorkspaceSnapshot(
      workspaceId,
      result.snapshot,
    );
    settleFoundationMutation(workspaceId, null, snapshot);
    return snapshot;
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
  return runLocalDesignMutation(workspaceId, async () =>
    executeWithFreshGenerationRetry(
      workspaceId,
      input.frame,
      resolveLocalFrameSourceVersion(
        workspaceId,
        input.frame,
        input.sourceVersion,
      ),
      async (sourceVersion) => {
        const result = await designUpdateStyles(workspaceId, {
          ...input,
          sourceVersion,
        });
        const nextSourceVersion = result.snapshot.frames.find(
          (frame) => frame.file === input.frame,
        )?.sourceVersion;
        recordLocalFrameGeneration(
          workspaceId,
          input.frame,
          sourceVersion,
          nextSourceVersion,
        );
        await adoptDesignStyleGeneration(
          workspaceId,
          input.frame,
          sourceVersion,
          nextSourceVersion,
          [{ nodeId: input.nodeId, styles: input.styles }],
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
  return runLocalDesignMutation(workspaceId, async () =>
    executeWithFreshGenerationRetry(
      workspaceId,
      input.frame,
      resolveLocalFrameSourceVersion(
        workspaceId,
        input.frame,
        input.sourceVersion,
      ),
      async (sourceVersion) => {
        const result = await designSetText(workspaceId, {
          ...input,
          sourceVersion,
        });
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
  return runLocalDesignMutation(workspaceId, async () =>
    executeWithFreshGenerationRetry(
      workspaceId,
      input.frame,
      resolveLocalFrameSourceVersion(
        workspaceId,
        input.frame,
        input.sourceVersion,
      ),
      async (sourceVersion) => {
        const result = await designWriteHtml(workspaceId, {
          ...input,
          sourceVersion,
          mode: "append",
        });
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
  return runLocalDesignMutation(workspaceId, async () =>
    executeWithFreshGenerationRetry(
      workspaceId,
      input.frame,
      resolveLocalFrameSourceVersion(
        workspaceId,
        input.frame,
        input.sourceVersion,
      ),
      async (sourceVersion) => {
        const result = await designInsertAsset(workspaceId, {
          ...input,
          sourceVersion,
        });
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

export async function saveDesigns(
  workspaceId: string,
): Promise<{ sha: string; branch: string }> {
  return runLocalDesignMutation(workspaceId, async () => {
    const result = await designSave(workspaceId);
    invalidateDesignWorkspaceSnapshot(workspaceId);
    return result;
  });
}

export async function stageDesigns(workspaceId: string): Promise<{ ok: true }> {
  return runLocalDesignMutation(workspaceId, () => designStage(workspaceId));
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
  return runLocalDesignMutation(workspaceId, async () => {
    const execute = async (sourceVersion: string) => {
      const previous =
        designWorkspaceSnapshotCache.getSnapshot(workspaceId).data ?? null;
      const result = await designUpdateToken(workspaceId, {
        ...input,
        sourceVersion,
      });
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
  return runLocalDesignMutation(workspaceId, async () => {
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
    settleFoundationMutation(
      workspaceId,
      frameFile,
      snapshot,
      result.foundationRevision,
    );
    return result.geometry;
  });
}

export async function applyDesignTransactionCached(
  workspaceId: string,
  frame: string,
  transaction: DesignTransaction,
): Promise<DesignApiMutationReplyWire> {
  return runLocalDesignMutation(workspaceId, async () => {
    const revisionKey = frameMutationKey(workspaceId, frame);
    const execute = async () => {
      const baseRevision = await resolveFoundationBaseRevision(
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
      const result = await designApplyTransaction(
        workspaceId,
        frame,
        rebasedTransaction,
      );
      recordLocalGeneration(
        localFoundationRevisionByFrame,
        revisionKey,
        baseRevision,
        result.result?.revision,
      );
      if (result.snapshot) {
        const nextSourceVersion = result.snapshot.frames.find(
          (candidate) => candidate.file === frame,
        )?.sourceVersion;
        recordLocalFrameGeneration(
          workspaceId,
          frame,
          previousSourceVersion,
          nextSourceVersion,
        );
        const adoption = transactionRuntimeAdoption(rebasedTransaction);
        if (adoption && previousSourceVersion) {
          await adoptDesignStyleGeneration(
            workspaceId,
            frame,
            previousSourceVersion,
            nextSourceVersion,
            adoption.styleUpdates,
            adoption.patch,
          );
        }
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
      if (!isStaleDesignGenerationError(error)) throw error;
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
  });
}

function transactionRuntimeAdoption(transaction: DesignTransaction): {
  styleUpdates: Array<{
    nodeId: string;
    styles: Record<string, string | null>;
  }>;
  patch?: DesignRuntimeGenerationPatch;
} | null {
  if (
    !Array.isArray(transaction.operations) ||
    transaction.operations.length > 32 ||
    transaction.operations.some(
      (operation) =>
        operation.type !== "node.set-styles" &&
        operation.type !== "keyframes.set",
    )
  ) {
    return null;
  }
  const stylesByNode = new Map<string, Record<string, string | null>>();
  const keyframes: NonNullable<DesignRuntimeGenerationPatch["keyframes"]> = [];
  for (const operation of transaction.operations) {
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
  if (styleUpdates.length === 0 && keyframes.length === 0) return null;
  return {
    styleUpdates,
    ...(keyframes.length > 0 ? { patch: { keyframes } } : {}),
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
  try {
    const adopted = patch
      ? await runtime.commitStyles(updates, nextSourceVersion, patch)
      : await runtime.commitStyles(updates, nextSourceVersion);
    const runtimeStore = useDesignRuntimeStore.getState();
    const updatedNodeIds = new Set(
      adopted.details.map((details) => details.oid),
    );
    const refreshNodeIds = patch
      ? (
          runtimeStore.byWorkspace[workspaceId]?.frames[frame]?.detailOrder ??
          []
        )
          .filter((nodeId) => !updatedNodeIds.has(nodeId))
          .slice(-64)
      : [];
    const refreshedDetails = (
      await Promise.all(
        refreshNodeIds.map((nodeId) =>
          runtime.getNodeDetails(nodeId).catch(() => null),
        ),
      )
    ).filter((details) => details !== null);
    const promoted = runtimeStore.adoptFrameGeneration(
      workspaceId,
      frame,
      previousSourceVersion,
      nextSourceVersion,
      adopted.snapshot,
      [...adopted.details, ...refreshedDetails],
      adopted.treeUnchanged,
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
  return runLocalDesignMutation(workspaceId, async () => {
    const previousSourceVersions = new Map(
      (
        designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames ??
        []
      ).map((candidate) => [candidate.file, candidate.sourceVersion]),
    );
    const result = await designHistory(workspaceId, frame, direction);
    const historyFrame = result.result ? (result.historyFrame ?? frame) : null;
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
      const snapshot = publishDesignWorkspaceSnapshot(
        workspaceId,
        result.snapshot,
      );
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
    if (!result.snapshot) invalidateWorkspaceDesignFoundations(workspaceId);
    return result;
  });
}

/** Test-only reset for exact-key/reference-stability coverage. */
export function resetDesignWorkspaceCacheForTests(): void {
  for (const cancel of pendingAdoptedSettlementByFrame.values()) cancel();
  pendingAdoptedSettlementByFrame.clear();
  pendingLocalMutationByWorkspace.clear();
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

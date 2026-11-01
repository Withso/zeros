// Typed renderer bridge for the first-party design document operations.
//
// Kept separate from the already-large workspace bridge: transport and error
// semantics still go through its shared workspaceOp helper, while the design
// wire vocabulary remains cohesive and cheap for the design shell to import.

import { DESIGN_COPY_PLACEMENT_CAPABILITY, type DesignRelocation, type DesignMovementGuard } from "@zeros/protocol/design-relocation";
import {
  designFoundationManifestSchema,
  designTransactionSchema,
  type DesignFoundationManifest,
  type DesignTransaction,
} from "@zeros/design-core";
import type {
  DesignAuthoredKeyframes,
  DesignApiApplyResult,
  DesignDocumentSummary,
  DesignStyleProvenance,
} from "@zeros/design-web";
import type { DesignRuntimeMatchedDeclaration } from "@zeros/protocol/design-runtime";
import {
  DESIGN_CAPTURE_TIMEOUT_MS,
  DESIGN_PREVIEW_JOBS_CAPABILITY,
  DESIGN_PREVIEW_JOB_TIMEOUT_MS,
  DesignCaptureCleanupUnconfirmedError,
  designPreviewReplySchema,
  type DesignPreviewReply,
} from "@zeros/protocol/design-capture";
import { designPageCatalogSchema, designPageIdSchema, normalizeDesignPagesSnapshot, type DesignPageSummary } from "@zeros/protocol/design-pages";
import { DESIGN_LAZY_PREPARATION_CAPABILITY, DESIGN_MUTATION_SNAPSHOTS_CAPABILITY, designMutationCatalogSchema, designPreparedFrameSchema, designFramesPrepareSchema, designFramesPrepareReplySchema, type DesignMutationCatalog } from "@zeros/protocol/design-catalog";
import { DESIGN_SOURCE_SURFACES_CAPABILITY } from "@zeros/protocol/design-surface";
import { isCloudWorkspace } from "./cloud-workspace-key";

import type { RuntimeClient } from "./ws-client";
import { workspaceOp as rawWorkspaceOp } from "./workspace-bridge";
import { designCaptureScheduler, type DesignCapturePriority } from "./design-capture-scheduler";

const directoryIds = new Map<string, string>();
export function rememberDesignDirectoryIdentity(workspaceId: string, directoryId: string): void {
  directoryIds.delete(workspaceId);
  directoryIds.set(workspaceId, directoryId);
  if (directoryIds.size > 64) directoryIds.delete(directoryIds.keys().next().value!);
}

const workspaceOp: typeof rawWorkspaceOp = (bridge, op, params = {}, ...rest) => {
  const directoryId = typeof params.workspaceId === "string" ? directoryIds.get(params.workspaceId) : undefined;
  return rawWorkspaceOp(bridge, op, { ...params, ...(directoryId ? { directoryId } : {}) }, ...rest);
};

// A cold aggregate snapshot intentionally parses, lints, and composes every
// frame's lightweight render identity. Large documents can exceed the generic
// 10s workspace RPC budget even on a healthy engine; the renderer retains a
// warm exact-key snapshot while this bounded revalidation runs.
const DESIGN_AGGREGATE_READ_TIMEOUT_MS = 30_000;

export interface DesignFrameSummaryWire {
  file: string;
  frameId?: string;
  pageId?: string;
  title: string;
  /** Omitted by older remote engines; absence is a conventional frame. */
  kind?: "frame" | "text";
  width: number;
  height: number;
  x: number;
  y: number;
  z: number;
  nodeCount: number;
  /** Nodes Layers lists under the frame row (a seeded frame root is the row
   * itself). Omitted by older engines, which report only `nodeCount`. */
  layerCount?: number;
  modifiedAt: number;
}

export interface DesignFrameTreeNodeWire {
  tag: string;
  oid: string | null;
  text: string | null;
  children: DesignFrameTreeNodeWire[];
}

export interface DesignCanvasFrameWire extends DesignFrameSummaryWire {
  sourceVersion: string;
  surfaceCost?: import("@zeros/protocol/design-surface").DesignSurfaceCost | null;
}

/** Navigation metadata cannot authorize rendering or editing. */
export interface DesignFrameDescriptionWire extends Omit<DesignFrameSummaryWire, "nodeCount" | "layerCount" | "modifiedAt"> {
  preparation: "unprepared";
  sourceVersion?: never;
  nodeCount?: never;
  layerCount?: never;
  modifiedAt?: never;
}

export interface DesignFrameDocumentWire extends DesignCanvasFrameWire {
  source: string;
  srcDoc: string;
  tree: DesignFrameTreeNodeWire[];
}

export async function bridgeDesignPrepareFrames(bridge: RuntimeClient, input: {
  workspaceId: string; directoryId: string; catalogRevision: string; files: readonly string[];
}) {
  const params = designFramesPrepareSchema.parse({ ...input,
    ...(bridge.supportsEngineCapability?.(DESIGN_SOURCE_SURFACES_CAPABILITY, input.workspaceId) ? { surfaceCosts: true } : {}),
  });
  if (isCloudWorkspace(params.workspaceId) || !bridge.supportsEngineCapability?.(DESIGN_LAZY_PREPARATION_CAPABILITY, params.workspaceId))
    throw new Error("Design preparation requires a capable Local engine.");
  let retired = false;
  const off = bridge.onStatusChange?.((status) => { if (status !== "connected") retired = true; });
  try {
    // Preserve the directory that produced the descriptions, even when a new
    // selection has already updated the bridge's remembered directory.
    const raw = await rawWorkspaceOp(bridge, "design.frames.prepare", params, 20_000);
    if (retired) throw new Error("Design preparation connection was retired.");
    const result = designFramesPrepareReplySchema.parse(raw);
    const files = [...result.frames, ...result.errors].map((frame) => frame.file);
    if (result.directoryId !== params.directoryId || result.catalogRevision !== params.catalogRevision ||
      files.length !== params.files.length || new Set(files).size !== files.length || files.some((file) => !params.files.includes(file)))
      throw new Error("Invalid Design preparation coverage or owner.");
    return result;
  } finally { off?.(); }
}

export interface DesignLintViolationWire {
  ruleId: string;
  severity: "error" | "warning";
  message: string;
  file: string;
  line: number;
  column: number;
  oid?: string;
  fix?: string;
}

export interface DesignLintReportWire {
  workspacePath: string;
  checkedFiles: string[];
  violations: DesignLintViolationWire[];
  healedOids: number;
}

export interface DesignTokenWire {
  name: string;
  syntax: string;
  inherits: boolean;
  initialValue: string;
  value: string;
  themeValues: Record<string, string>;
  usageCount: number;
  usageCountKnown?: boolean;
  line: number;
}

/** An imported style source declared in meta/canvas.json, as the theme editor
 * shows it. The CSS itself reaches frames through rendering. */
export interface DesignStyleSourceWire {
  id: string;
  title: string;
  kind: string;
  path: string;
  status: "ready" | "warning" | "error";
  /** `action` says what resolves a message: "update" (the Update button) or
   * "agent" (Ask agent to fix). Absent on older engines. */
  messages: { level: "info" | "warning" | "error"; text: string; action?: "update" | "agent" }[];
  themes: string[];
  tokens: { name: string; value: string; themeValues: Record<string, string> }[];
  bytes: number;
  revision: string | null;
}

/** A theme with its display name. `base` marks the default theme, whose
 * values are `:root`; frames carry its id when no other theme is chosen. */
export interface DesignThemeWire {
  id: string;
  label: string;
  base?: true;
}

export interface DesignTokenMutationWire {
  changed: boolean;
  document: {
    sourceVersion: string;
    themes: string[];
    tokens: DesignTokenWire[];
  };
}

export interface DesignFrameGeometryWire {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface DesignTextFrameSeedWire {
  kind: "text";
  nodeId: string;
  text: string;
  fixedSize: boolean;
}

export interface DesignAssetWire {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedAt: number;
  dataUrl: string | null;
}

export interface DesignWorkspaceSnapshotWire {
  mutationCatalog?: DesignMutationCatalog;
  /** Renderer-owned projection, never an authored or persisted source version. */
  preparation?: {
    revision: string;
    epoch: number;
    descriptions: DesignFrameDescriptionWire[];
    current: string[];
    errors: Record<string, string>;
  };
  /** Absent only on older engines and pre-migration boot snapshots. */
  directoryId?: string;
  directory?: string;
  /** Optional for older engines; normalized to a single legacy root page. */
  pages?: DesignPageSummary[];
  /** Host-local resource authority. Null on remote/srcDoc renderers. */
  protocolCapability: string | null;
  frames: DesignCanvasFrameWire[];
  tokens: DesignTokenWire[];
  tokenSourceVersion: string;
  /** Absent on older engines, which have no imported style sources. */
  styleSources?: DesignStyleSourceWire[];
  styleSourceErrors?: string[];
  /** Absent on older engines, whose default theme is always "Base". */
  themes?: DesignThemeWire[];
  assets: DesignAssetWire[];
  lint: DesignLintReportWire;
}

function validProtocolCapability(
  snapshot: DesignWorkspaceSnapshotWire | undefined,
): boolean {
  return (
    !!snapshot &&
    (snapshot.protocolCapability === null ||
      /^[a-f0-9]{64}$/.test(snapshot.protocolCapability))
  );
}

function validMutationSnapshot(snapshot: DesignWorkspaceSnapshotWire | undefined): boolean {
  return validProtocolCapability(snapshot) &&
    (snapshot?.mutationCatalog === undefined || isDesignWorkspaceSnapshotWire(snapshot));
}

export function isDesignWorkspaceSnapshotWire(
  value: unknown,
): value is DesignWorkspaceSnapshotWire {
  const snapshot = value as DesignWorkspaceSnapshotWire | undefined;
  if (!snapshot || !validProtocolCapability(snapshot)) return false;
  if (snapshot.pages !== undefined && !designPageCatalogSchema.safeParse(snapshot.pages).success) return false;
  if (snapshot.mutationCatalog !== undefined) {
    const catalog = designMutationCatalogSchema.safeParse(snapshot.mutationCatalog);
    if (!catalog.success || !snapshot.directoryId || !Array.isArray(snapshot.frames) || !snapshot.pages) return false;
    const descriptions = new Map(catalog.data.frames.map(frame => [frame.source, frame]));
    if (descriptions.size !== catalog.data.frames.length || new Set(catalog.data.frames.map(frame => frame.id)).size !== descriptions.size) return false;
    if (snapshot.frames.some(frame => {
      const description = descriptions.get(frame?.file);
      return !description || !designPreparedFrameSchema.safeParse(frame).success || frame.frameId !== description.id || frame.pageId !== description.pageId ||
        (frame.kind === "text" ? "text" : "html") !== description.kind ||
        (["title", "x", "y", "width", "height", "z"] as const).some(key => frame[key] !== description[key]);
    })) return false;
    const described = snapshot.pages.flatMap(page => page.frameFiles);
    if (described.length !== descriptions.size || described.some(file => !descriptions.has(file)) ||
      snapshot.pages.some(page => page.frameFiles.some((file, index) => {
        const description = descriptions.get(file);
        return !description || description.pageId !== page.id || description.order !== index || page.frameIds?.[index] !== description.id;
      }))) return false;
  }
  if (Object.hasOwn(snapshot, "nextCursor") || Object.hasOwn(snapshot, "coverage")) return false;
  if (snapshot.pages !== undefined) {
    const files = new Set<string>();
    if (!Array.isArray(snapshot.frames) || snapshot.frames.some((frame) => {
      if (!frame || typeof frame.file !== "string" || files.has(frame.file)) return true;
      files.add(frame.file);
      const page = snapshot.pages!.find((page) => page.frameFiles.includes(frame.file));
      return !page || (frame.pageId !== undefined && frame.pageId !== page.id);
    })) return false;
  }
  return (
    Array.isArray(snapshot.frames) &&
    Array.isArray(snapshot.tokens) &&
    Array.isArray(snapshot.assets) &&
    typeof snapshot.tokenSourceVersion === "string" &&
    typeof snapshot.lint?.workspacePath === "string" &&
    Array.isArray(snapshot.lint.checkedFiles) &&
    Array.isArray(snapshot.lint.violations) &&
    typeof snapshot.lint.healedOids === "number"
  );
}

export function normalizeDesignWorkspaceSnapshotPages(snapshot: DesignWorkspaceSnapshotWire): DesignWorkspaceSnapshotWire {
  return normalizeDesignPagesSnapshot(snapshot);
}

export interface DesignMutationResultWire {
  changed: boolean;
  frame: DesignFrameDocumentWire;
  lint: DesignLintReportWire;
}

export interface DesignFoundationRevisionWire {
  before: string;
  after: string;
}

export interface DesignMutationReplyWire {
  mutation: DesignMutationResultWire;
  snapshot: DesignWorkspaceSnapshotWire;
  /** Exact authored lineage produced by this compatibility mutation. Older
   * engines may omit it; the renderer then refreshes the current Foundation
   * before its next transaction instead of guessing across a revision. */
  foundationRevision?: DesignFoundationRevisionWire;
}

export interface DesignSelectionInputWire {
  frame: string;
  sourceVersion: string;
  /** Wall-clock time used in the public MCP response. This is deliberately
   * separate from the renderer's synthetic monotonic conflict version. */
  updatedAt: number;
  nodeIds: string[];
  breadcrumb: string[];
  rects: Array<{ x: number; y: number; width: number; height: number }>;
  keyComputedStyles: Record<string, string>;
}

export interface DesignScreenshotInputWire {
  frame: string;
  nodeId: string | null;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
  width: number;
  height: number;
  scale: number;
  capturedAt: number;
  sourceVersion: string;
}

export interface DesignRuntimeWarningWire {
  ruleId:
    | "contrast"
    | "overflow"
    | "spacing-scale"
    | "audit-limit"
    | "layer-tree-limit";
  message: string;
  oid: string;
  fix: string;
}

export interface DesignFoundationOpenWire {
  summary: DesignDocumentSummary;
  foundation: {
    documentId: string;
    revision: string;
    manifest: DesignFoundationManifest;
    keyframes: DesignAuthoredKeyframes[];
  };
}

function validDesignKeyframes(
  value: unknown,
): value is DesignAuthoredKeyframes[] {
  if (!Array.isArray(value) || value.length > 128) return false;
  return value.every((definition: unknown) => {
    if (!definition || typeof definition !== "object") return false;
    const candidate = definition as {
      file?: unknown;
      name?: unknown;
      keyframes?: unknown;
    };
    if (
      typeof candidate.file !== "string" ||
      typeof candidate.name !== "string" ||
      !Array.isArray(candidate.keyframes) ||
      candidate.keyframes.length > 32
    ) {
      return false;
    }
    return candidate.keyframes.every((keyframe: unknown) => {
      if (!keyframe || typeof keyframe !== "object") return false;
      const frame = keyframe as { offset?: unknown; styles?: unknown };
      return (
        typeof frame.offset === "number" &&
        frame.offset >= 0 &&
        frame.offset <= 100 &&
        Boolean(frame.styles) &&
        typeof frame.styles === "object" &&
        !Array.isArray(frame.styles) &&
        Object.keys(frame.styles as object).length <= 64 &&
        Object.entries(frame.styles as Record<string, unknown>).every(
          ([property, style]) =>
            property.length > 0 &&
            property.length <= 128 &&
            typeof style === "string" &&
            style.length <= 2_048,
        )
      );
    });
  });
}

export interface DesignApiMutationReplyWire {
  result: DesignApiApplyResult | null;
  snapshot?: DesignWorkspaceSnapshotWire;
  /** Structural history can restore/delete a frame independently of the frame
   * that happened to own keyboard focus when the shortcut was pressed. */
  historySelection?: string | null;
  /** Affected frame for semantic, structural and transfer history, including
   * removed frames. Its folder lets the renderer reveal the affected page. */
  historyFrame?: string;
  /** Catalog history can affect an empty page with no frame to identify it. */
  historyPageId?: string;
}

function designFoundationOpenReply(value: unknown): DesignFoundationOpenWire {
  const reply = value as Partial<DesignFoundationOpenWire> | null;
  const manifest = designFoundationManifestSchema.safeParse(
    reply?.foundation?.manifest,
  );
  if (
    !reply?.summary ||
    typeof reply.summary.documentId !== "string" ||
    typeof reply.summary.revision !== "string" ||
    typeof reply.summary.valid !== "boolean" ||
    !reply.summary.history ||
    typeof reply.summary.history.canUndo !== "boolean" ||
    typeof reply.summary.history.canRedo !== "boolean" ||
    !reply.foundation ||
    reply.foundation.documentId !== reply.summary.documentId ||
    reply.foundation.revision !== reply.summary.revision ||
    !manifest.success ||
    !validDesignKeyframes(reply.foundation.keyframes)
  ) {
    throw new Error("design.foundation.open: malformed engine response");
  }
  return {
    summary: reply.summary,
    foundation: {
      ...reply.foundation,
      manifest: manifest.data,
      keyframes: reply.foundation.keyframes,
    },
  };
}

function designApiMutationReply(
  value: unknown,
  operation: string,
  requireSnapshot: boolean,
): DesignApiMutationReplyWire {
  const reply = value as Partial<DesignApiMutationReplyWire> | null;
  if (
    !reply ||
    !("result" in reply) ||
    (reply.result !== null &&
      (typeof reply.result !== "object" ||
        typeof reply.result.revision !== "string" ||
        typeof reply.result.receipt?.status !== "string")) ||
    (reply.historySelection !== undefined &&
      reply.historySelection !== null &&
      typeof reply.historySelection !== "string") ||
    (reply.historyFrame !== undefined &&
      typeof reply.historyFrame !== "string") ||
    (reply.historyPageId !== undefined &&
      !designPageIdSchema.safeParse(reply.historyPageId).success) ||
    (requireSnapshot &&
      (!reply.snapshot ||
        !validMutationSnapshot(reply.snapshot) ||
        !Array.isArray(reply.snapshot.frames)))
  ) {
    throw new Error(`${operation}: malformed engine response`);
  }
  return reply as DesignApiMutationReplyWire;
}

export async function bridgeDesignFoundationOpen(
  bridge: RuntimeClient,
  workspaceId: string,
  frame: string,
): Promise<DesignFoundationOpenWire> {
  return designFoundationOpenReply(
    await workspaceOp(bridge, "design.foundation.open", {
      workspaceId,
      frame,
    }),
  );
}

export async function bridgeDesignProvenance(
  bridge: RuntimeClient,
  workspaceId: string,
  input: {
    frame: string;
    nodeId: string;
    property: string;
    expectedRevision?: string;
    computedValue?: string | null;
    matched?: DesignRuntimeMatchedDeclaration[];
  },
): Promise<DesignStyleProvenance> {
  const value = (await workspaceOp(bridge, "design.provenance", {
    workspaceId,
    ...input,
  })) as { provenance?: DesignStyleProvenance };
  if (
    !value?.provenance ||
    typeof value.provenance.nodeId !== "string" ||
    typeof value.provenance.property !== "string" ||
    typeof value.provenance.confidence !== "string" ||
    !Array.isArray(value.provenance.candidates)
  ) {
    throw new Error("design.provenance: malformed engine response");
  }
  return value.provenance;
}

export async function bridgeDesignApplyTransaction(
  bridge: RuntimeClient,
  workspaceId: string,
  frame: string,
  transaction: DesignTransaction,
  dryRun = false,
  movementGuard?: DesignMovementGuard,
): Promise<DesignApiMutationReplyWire> {
  const parsed = designTransactionSchema.parse(transaction);
  return designApiMutationReply(
    await workspaceOp(bridge, "design.transaction.apply", {
      workspaceId,
      frame,
      transaction: parsed,
      dryRun,
      ...(movementGuard ? { movementGuard } : {}),
      ...scopedMutationSnapshot(bridge, workspaceId),
    }),
    "design.transaction.apply",
    !dryRun,
  );
}

export async function bridgeDesignHistory(
  bridge: RuntimeClient,
  workspaceId: string,
  frame: string | null,
  direction: "undo" | "redo",
  expectedSourceVersions?: Record<string, string>,
): Promise<DesignApiMutationReplyWire> {
  return designApiMutationReply(
    await workspaceOp(bridge, `design.history.${direction}`, {
      workspaceId,
      ...(frame ? { frame } : {}),
      ...(expectedSourceVersions ? { expectedSourceVersions } : {}),
      ...scopedMutationSnapshot(bridge, workspaceId),
    }),
    `design.history.${direction}`,
    true,
  );
}

export async function bridgeDesignFrames(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<DesignFrameSummaryWire[]> {
  const result = (await workspaceOp(bridge, "design.frames", {
    workspaceId,
  })) as { frames?: DesignFrameSummaryWire[] };
  return Array.isArray(result?.frames) ? result.frames : [];
}

export async function bridgeDesignFrame(
  bridge: RuntimeClient,
  workspaceId: string,
  frame: string,
  depth = 4,
): Promise<DesignFrameDocumentWire> {
  const result = (await workspaceOp(bridge, "design.frame", {
    workspaceId,
    frame,
    depth,
  })) as { frame?: DesignFrameDocumentWire };
  if (!result?.frame || typeof result.frame.file !== "string") {
    throw new Error("design.frame: malformed engine response");
  }
  return result.frame;
}

export async function bridgeDesignSnapshot(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<DesignWorkspaceSnapshotWire> {
  const result = (await workspaceOp(
    bridge,
    "design.snapshot",
    { workspaceId },
    DESIGN_AGGREGATE_READ_TIMEOUT_MS,
  )) as { snapshot?: DesignWorkspaceSnapshotWire };
  if (!isDesignWorkspaceSnapshotWire(result?.snapshot)) {
    throw new Error("design.snapshot: malformed engine response");
  }
  return normalizeDesignWorkspaceSnapshotPages(result.snapshot);
}

function designMutationReply(
  result: unknown,
  operation: string,
): DesignMutationReplyWire {
  const reply = result as Partial<DesignMutationReplyWire> | null;
  const revision = reply?.foundationRevision;
  if (
    !reply?.mutation ||
    typeof reply.mutation.changed !== "boolean" ||
    typeof reply.mutation.frame?.file !== "string" ||
    !reply.snapshot ||
    !validMutationSnapshot(reply.snapshot) ||
    !Array.isArray(reply.snapshot.frames) ||
    !Array.isArray(reply.snapshot.assets) ||
    typeof reply.snapshot.tokenSourceVersion !== "string" ||
    (revision !== undefined &&
      (typeof revision.before !== "string" ||
        typeof revision.after !== "string"))
  ) {
    throw new Error(`${operation}: malformed engine response`);
  }
  return reply as DesignMutationReplyWire;
}

/** One frame's canvas preview, rendered from its saved source by the
 * workspace's capture host. A stale answer names the saved version. */
export async function bridgeDesignPreview(
  bridge: RuntimeClient,
  workspaceId: string,
  input: {
    directoryId: string;
    frame: string;
    sourceVersion: string;
    theme: string | null;
    maxDimension: number;
  },
  options: { signal?: AbortSignal; priority?: DesignCapturePriority; /** Producer retains admission through PNG re-encoding. */ admitted?: boolean } = {},
): Promise<DesignPreviewReply> {
  const work = async (signal: AbortSignal) => {
    const cancellable = bridge.supportsEngineCapability?.(DESIGN_PREVIEW_JOBS_CAPABILITY, workspaceId) === true;
    const jobId = cancellable ? crypto.randomUUID() : undefined;
    const deadline = Date.now() + DESIGN_PREVIEW_JOB_TIMEOUT_MS;
    let terminal = false;
    let lostConnection = false;
    const offStatus = bridge.onStatusChange?.((status) => {
      if (status !== "connected") lostConnection = true;
    });
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      if (cancellation) return;
      // A cancellation on another socket could acknowledge an empty job while
      // the original connection is still draining. Never use it as proof.
      cancellation = !jobId || lostConnection
        ? Promise.reject(new DesignCaptureCleanupUnconfirmedError())
        : rawWorkspaceOp(bridge, "design.preview.cancel", {
        workspaceId, directoryId: input.directoryId, jobId, deadline,
      }, DESIGN_CAPTURE_TIMEOUT_MS + 15_000).then((result) => {
        if (lostConnection || (result as { settled?: unknown })?.settled !== true) throw new DesignCaptureCleanupUnconfirmedError();
      });
      // Attach immediately; the original job is still awaited below.
      void cancellation.catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    let outcome: { reply: DesignPreviewReply } | { error: unknown };
    try {
      signal.throwIfAborted();
      const result = await rawWorkspaceOp(bridge, "design.preview", { workspaceId, ...input, ...(jobId ? { jobId, deadline } : {}) },
        DESIGN_CAPTURE_TIMEOUT_MS + 15_000);
      terminal = true;
      signal.throwIfAborted();
      const reply = designPreviewReplySchema.safeParse(result);
      if (!reply.success) throw new Error("design.preview: malformed engine response");
      outcome = { reply: reply.data };
    } catch (error) {
      cancel();
      outcome = { error };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    try { await cancellation; }
    catch {
      if (!terminal) {
        designCaptureScheduler.quarantine();
        throw new DesignCaptureCleanupUnconfirmedError();
      }
    } finally { offStatus?.(); }
    if ("error" in outcome) throw outcome.error;
    return outcome.reply;
  };
  return options.admitted
    ? work(options.signal ?? new AbortController().signal)
    : designCaptureScheduler.schedule(JSON.stringify(["native", workspaceId, input]), options.priority ?? "visible", work, options.signal);
}

export async function bridgeDesignTokens(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<DesignTokenWire[]> {
  const result = (await workspaceOp(bridge, "design.tokens", {
    workspaceId,
  })) as { tokens?: DesignTokenWire[] };
  return Array.isArray(result?.tokens) ? result.tokens : [];
}

export async function bridgeDesignUpdateToken(
  bridge: RuntimeClient,
  workspaceId: string,
  input: {
    frame: string;
    name: string;
    theme: string | null;
    value: string;
    sourceVersion: string;
  },
): Promise<{
  mutation: DesignTokenMutationWire;
  snapshot: DesignWorkspaceSnapshotWire;
  foundationRevision?: DesignFoundationRevisionWire;
}> {
  const result = (await workspaceOp(bridge, "design.token.update", {
    workspaceId,
    ...input,
  })) as {
    mutation?: DesignTokenMutationWire;
    snapshot?: DesignWorkspaceSnapshotWire;
    foundationRevision?: DesignFoundationRevisionWire;
  };
  const revision = result.foundationRevision;
  if (
    !result.mutation ||
    typeof result.mutation.changed !== "boolean" ||
    !result.snapshot ||
    !validProtocolCapability(result.snapshot) ||
    !Array.isArray(result.snapshot.tokens) ||
    typeof result.snapshot.tokenSourceVersion !== "string" ||
    (revision !== undefined &&
      (typeof revision.before !== "string" ||
        typeof revision.after !== "string"))
  ) {
    throw new Error("design.token.update: malformed engine response");
  }
  return {
    mutation: result.mutation,
    snapshot: result.snapshot,
    ...(revision ? { foundationRevision: revision } : {}),
  };
}

export async function bridgeDesignLint(
  bridge: RuntimeClient,
  workspaceId: string,
  frame?: string,
): Promise<DesignLintReportWire> {
  const result = (await workspaceOp(bridge, "design.lint", {
    workspaceId,
    ...(frame ? { frame } : {}),
  })) as { report?: DesignLintReportWire };
  if (!result?.report || !Array.isArray(result.report.violations)) {
    throw new Error("design.lint: malformed engine response");
  }
  return result.report;
}

export async function bridgeDesignSetSelection(
  bridge: RuntimeClient,
  workspaceId: string,
  selection: DesignSelectionInputWire | null,
  selectionVersion: number,
): Promise<void> {
  await workspaceOp(bridge, "design.selection.set", {
    workspaceId,
    selectionVersion,
    ...(selection ?? {}),
  });
}

export async function bridgeDesignSetScreenshot(
  bridge: RuntimeClient,
  workspaceId: string,
  screenshot: DesignScreenshotInputWire,
): Promise<void> {
  await workspaceOp(bridge, "design.screenshot.set", {
    workspaceId,
    ...screenshot,
  });
}

/** This workspace's Design tab is showing (`present`), or was left. Showing
 * starts the person's style builds; leaving starts their idle timer. */
export async function bridgeDesignStyleBuildPresence(
  bridge: RuntimeClient,
  workspaceId: string,
  present: boolean,
): Promise<void> {
  await workspaceOp(bridge, "design.styleBuilds.presence", {
    workspaceId,
    present,
  });
}

/** The theme editor's Update: re-read every imported source and run its
 * builds now. The caller re-reads the snapshot afterwards. */
export async function bridgeDesignRefreshStyles(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<void> {
  await workspaceOp(bridge, "design.styles.refresh", { workspaceId });
}

export async function bridgeDesignSetRuntimeAudit(
  bridge: RuntimeClient,
  workspaceId: string,
  input: {
    frame: string;
    sourceVersion: string;
    warnings: DesignRuntimeWarningWire[];
  },
): Promise<{ sourceVersion: string; violations: DesignLintViolationWire[] } | undefined> {
  const result = await workspaceOp(bridge, "design.runtime.audit", {
    workspaceId,
    ...input,
  }) as { sourceVersion?: unknown; violations?: DesignLintViolationWire[] };
  if (result?.sourceVersion === undefined && result?.violations === undefined) return;
  if (result.sourceVersion !== input.sourceVersion || !Array.isArray(result.violations) || result.violations.length > 128 ||
    result.violations.some((row) => !row || row.file !== input.frame || row.severity !== "warning" ||
      !["contrast", "overflow", "spacing-scale", "audit-limit", "layer-tree-limit"].includes(row.ruleId) || typeof row.message !== "string" ||
      !Number.isSafeInteger(row.line) || row.line < 1 || !Number.isSafeInteger(row.column) || row.column < 1 ||
      (row.oid !== undefined && typeof row.oid !== "string") || (row.fix !== undefined && typeof row.fix !== "string")))
    throw new Error("design.runtime.audit: malformed engine response");
  return { sourceVersion: input.sourceVersion, violations: result.violations };
}

export interface DesignPageMutationReplyWire {
  page: DesignPageSummary;
  snapshot: DesignWorkspaceSnapshotWire;
}

function designPageMutationReply(value: unknown, operation: string): DesignPageMutationReplyWire {
  const result = value as Partial<DesignPageMutationReplyWire> | null;
  const snapshot = result?.snapshot;
  if (!result?.page || !snapshot?.pages || !isDesignWorkspaceSnapshotWire(snapshot))
    throw new Error(`${operation}: malformed engine response`);
  const page = snapshot.pages.find(page => page.id === result.page!.id);
  if (!page || page.title !== result.page.title || page.folder !== result.page.folder ||
    !Array.isArray(result.page.frameFiles) || page.frameFiles.length !== result.page.frameFiles.length ||
    page.frameFiles.some((file, index) => file !== result.page!.frameFiles[index]))
    throw new Error(`${operation}: malformed engine response`);
  return { page, snapshot: normalizeDesignWorkspaceSnapshotPages(snapshot) };
}

export async function bridgeDesignCreatePage(bridge: RuntimeClient, workspaceId: string, title?: string): Promise<DesignPageMutationReplyWire> {
  return designPageMutationReply(await workspaceOp(bridge, "design.page.create", {
    workspaceId, ...(title !== undefined ? { title } : {}),
  }), "design.page.create");
}

export async function bridgeDesignRenamePage(bridge: RuntimeClient, workspaceId: string, pageId: string, title: string): Promise<DesignPageMutationReplyWire> {
  return designPageMutationReply(await workspaceOp(bridge, "design.page.rename", {
    workspaceId, pageId, title,
  }), "design.page.rename");
}

export async function bridgeDesignUpdateTheme(
  bridge: RuntimeClient,
  workspaceId: string,
  theme: { id: string; label: string; base?: boolean },
): Promise<{ themes: DesignThemeWire[]; snapshot: DesignWorkspaceSnapshotWire }> {
  const result = await workspaceOp(bridge, "design.themes.update", { workspaceId, theme }) as {
    themes?: DesignThemeWire[]; snapshot?: DesignWorkspaceSnapshotWire;
  } | null;
  if (!Array.isArray(result?.themes) || !result.snapshot || !isDesignWorkspaceSnapshotWire(result.snapshot))
    throw new Error("design.themes.update: malformed engine response");
  return { themes: result.themes, snapshot: normalizeDesignWorkspaceSnapshotPages(result.snapshot) };
}

export async function bridgeDesignDeletePage(bridge: RuntimeClient, workspaceId: string, pageId: string, expectedFrameIds: readonly string[]): Promise<{
  deleted: { pageId: string };
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  const result = await workspaceOp(bridge, "design.page.delete", { workspaceId, pageId, expectedFrameIds }) as {
    deleted?: { pageId: string }; snapshot?: DesignWorkspaceSnapshotWire;
  } | null;
  if (result?.deleted?.pageId !== pageId || !result.snapshot?.pages ||
    !isDesignWorkspaceSnapshotWire(result.snapshot) || result.snapshot.pages.some(page => page.id === pageId))
    throw new Error("design.page.delete: malformed engine response");
  return { deleted: result.deleted, snapshot: normalizeDesignWorkspaceSnapshotPages(result.snapshot) };
}

export async function bridgeDesignSelectPage(bridge: RuntimeClient, workspaceId: string, directoryId: string, pageId: string): Promise<void> {
  // This hint captures its owner; a newer mutation binding must not retarget it.
  const result = await rawWorkspaceOp(bridge, "design.page.select", { workspaceId, directoryId, pageId }) as { ok?: boolean } | null;
  if (result?.ok !== true) throw new Error("design.page.select: malformed engine response");
}

export async function bridgeDesignCreateFrame(
  bridge: RuntimeClient,
  workspaceId: string,
  title?: string,
  geometry?: DesignFrameGeometryWire,
  seed?: DesignTextFrameSeedWire,
  pageId?: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  const result = (await workspaceOp(bridge, "design.frame.create", {
    workspaceId,
    ...scopedMutationSnapshot(bridge, workspaceId),
    ...(pageId !== undefined ? { pageId } : {}),
    ...(title ? { title } : {}),
    ...(geometry ? geometry : {}),
    ...(seed
      ? {
          kind: seed.kind,
          textNodeId: seed.nodeId,
          text: seed.text,
          textFixedSize: seed.fixedSize,
        }
      : {}),
  })) as {
    frame?: DesignFrameSummaryWire;
    snapshot?: DesignWorkspaceSnapshotWire;
  };
  if (
    !result?.frame ||
    typeof result.frame.file !== "string" ||
    !result.snapshot ||
    !validMutationSnapshot(result.snapshot)
  ) {
    throw new Error("design.frame.create: malformed engine response");
  }
  return { frame: result.frame, snapshot: result.snapshot };
}

export async function bridgeDesignRenameFrame(
  bridge: RuntimeClient,
  workspaceId: string,
  frame: string,
  title: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  const result = (await workspaceOp(bridge, "design.frame.rename", {
    workspaceId,
    frame,
    title,
  })) as {
    frame?: DesignFrameSummaryWire;
    snapshot?: DesignWorkspaceSnapshotWire;
  };
  if (
    !result?.frame ||
    typeof result.frame.file !== "string" ||
    !result.snapshot ||
    !validProtocolCapability(result.snapshot)
  ) {
    throw new Error("design.frame.rename: malformed engine response");
  }
  return { frame: result.frame, snapshot: result.snapshot };
}

export async function bridgeDesignUpdateCanvas(
  bridge: RuntimeClient,
  workspaceId: string,
  frame: string,
  geometry: DesignFrameGeometryWire,
): Promise<{
  geometry: DesignFrameGeometryWire;
  snapshot: DesignWorkspaceSnapshotWire;
  foundationRevision?: DesignFoundationRevisionWire;
}> {
  const result = (await workspaceOp(bridge, "design.canvas.update", {
    workspaceId,
    frame,
    ...geometry,
    ...scopedMutationSnapshot(bridge, workspaceId),
  })) as {
    geometry?: DesignFrameGeometryWire;
    snapshot?: DesignWorkspaceSnapshotWire;
    foundationRevision?: DesignFoundationRevisionWire;
  };
  const revision = result.foundationRevision;
  if (
    !result?.geometry ||
    typeof result.geometry.x !== "number" ||
    !result.snapshot ||
    !validMutationSnapshot(result.snapshot) ||
    (revision !== undefined &&
      (typeof revision.before !== "string" ||
        typeof revision.after !== "string"))
  ) {
    throw new Error("design.canvas.update: malformed engine response");
  }
  return {
    geometry: result.geometry,
    snapshot: result.snapshot,
    ...(revision ? { foundationRevision: revision } : {}),
  };
}

/** Several selected canvas frames moved together: one canvas write and one
 * undo step. Each move names the geometry it was measured at. */
export async function bridgeDesignMoveFrames(
  bridge: RuntimeClient,
  workspaceId: string,
  moves: readonly {
    frame: string;
    from: DesignFrameGeometryWire;
    to: DesignFrameGeometryWire;
  }[],
): Promise<DesignWorkspaceSnapshotWire> {
  const result = (await workspaceOp(bridge, "design.frames.move", {
    workspaceId,
    moves,
    ...scopedMutationSnapshot(bridge, workspaceId),
  })) as { snapshot?: DesignWorkspaceSnapshotWire };
  if (!result?.snapshot || !isDesignWorkspaceSnapshotWire(result.snapshot))
    throw new Error("design.frames.move: malformed engine response");
  return normalizeDesignWorkspaceSnapshotPages(result.snapshot);
}

export async function bridgeDesignDuplicateFrame(
  bridge: RuntimeClient,
  workspaceId: string,
  frame: string,
  pageId?: string,
  placement?: { sourceVersion: string; geometry: DesignFrameGeometryWire },
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  if (placement && (isCloudWorkspace(workspaceId) || !bridge.supportsEngineCapability?.(DESIGN_COPY_PLACEMENT_CAPABILITY, workspaceId)))
    throw new Error("Update the Local engine to copy frames at the pointer.");
  const result = (await workspaceOp(bridge, "design.frame.duplicate", {
    workspaceId,
    frame,
    ...(pageId !== undefined ? { pageId } : {}),
    ...placement,
    ...scopedMutationSnapshot(bridge, workspaceId),
  })) as {
    frame?: DesignFrameSummaryWire;
    snapshot?: DesignWorkspaceSnapshotWire;
  };
  if (
    !result.frame ||
    !result.snapshot ||
    !validMutationSnapshot(result.snapshot)
  ) {
    throw new Error("design.frame.duplicate: malformed engine response");
  }
  return { frame: result.frame, snapshot: result.snapshot };
}

export async function bridgeDesignDeleteFrame(
  bridge: RuntimeClient,
  workspaceId: string,
  frame: string,
): Promise<{
  deleted: { file: string };
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  const result = (await workspaceOp(bridge, "design.frame.delete", {
    workspaceId,
    frame,
    ...scopedMutationSnapshot(bridge, workspaceId),
  })) as {
    deleted?: { file: string };
    snapshot?: DesignWorkspaceSnapshotWire;
  };
  if (
    !result.deleted ||
    !result.snapshot ||
    !validMutationSnapshot(result.snapshot)
  ) {
    throw new Error("design.frame.delete: malformed engine response");
  }
  return { deleted: result.deleted, snapshot: result.snapshot };
}

export interface DesignNodeTransferInput {
  frame: string;
  pageId?: string;
  sourceVersion: string;
  nodeId: string;
  duplicateNodeId?: string;
  destinationFrame?: string;
  destinationSourceVersion?: string;
  parentId?: string;
  beforeId?: string | null;
  styles?: Record<string, string | null>;
  relocation?: DesignRelocation;
  movementGuard?: DesignMovementGuard;
  destinationMovementGuard?: DesignMovementGuard;
  /** Makes a static destination parent positioned in the same move. */
  parentStyles?: { position: "relative" };
  /** A whole body-rooted frame's body background, kept on its new layer. */
  frameBackground?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export async function bridgeDesignTransferNode(
  bridge: RuntimeClient,
  workspaceId: string,
  input: DesignNodeTransferInput,
): Promise<{
  frame: string;
  nodeId: string;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  if (input.duplicateNodeId !== undefined && (isCloudWorkspace(workspaceId) || !bridge.supportsEngineCapability?.(DESIGN_COPY_PLACEMENT_CAPABILITY, workspaceId)))
    throw new Error("Update the Local engine to copy layers between frames.");
  const value = (await workspaceOp(bridge, "design.node.transfer", {
    workspaceId,
    ...input,
    ...scopedMutationSnapshot(bridge, workspaceId),
  })) as {
    frame?: string;
    nodeId?: string;
    snapshot?: DesignWorkspaceSnapshotWire;
  };
  if (
    typeof value.frame !== "string" ||
    typeof value.nodeId !== "string" ||
    !isDesignWorkspaceSnapshotWire(value.snapshot)
  )
    throw new Error("Invalid layer transfer response.");
  return { frame: value.frame, nodeId: value.nodeId, snapshot: value.snapshot };
}

function scopedMutationSnapshot(bridge: RuntimeClient, workspaceId: string) {
  return !isCloudWorkspace(workspaceId) && bridge.supportsEngineCapability?.(DESIGN_MUTATION_SNAPSHOTS_CAPABILITY, workspaceId)
    ? { snapshotMode: "scoped" } : {};
}

export async function bridgeDesignUpdateStyles(
  bridge: RuntimeClient,
  workspaceId: string,
  input: {
    frame: string;
    nodeId: string;
    sourceVersion: string;
    styles: Record<string, string | null>;
  },
): Promise<DesignMutationReplyWire> {
  return designMutationReply(
    await workspaceOp(bridge, "design.node.styles", {
      workspaceId,
      ...input,
      ...scopedMutationSnapshot(bridge, workspaceId),
    }),
    "design.node.styles",
  );
}

export async function bridgeDesignSetText(
  bridge: RuntimeClient,
  workspaceId: string,
  input: {
    frame: string;
    nodeId: string;
    sourceVersion: string;
    text: string;
  },
): Promise<DesignMutationReplyWire> {
  return designMutationReply(
    await workspaceOp(bridge, "design.node.text", {
      workspaceId,
      ...input,
      ...scopedMutationSnapshot(bridge, workspaceId),
    }),
    "design.node.text",
  );
}

export async function bridgeDesignWriteHtml(
  bridge: RuntimeClient,
  workspaceId: string,
  input: {
    frame: string;
    nodeId: string;
    sourceVersion: string;
    html: string;
    mode: "append" | "replace-inner";
  },
): Promise<DesignMutationReplyWire> {
  return designMutationReply(
    await workspaceOp(bridge, "design.node.html", {
      workspaceId,
      ...input,
      ...scopedMutationSnapshot(bridge, workspaceId),
    }),
    "design.node.html",
  );
}

export async function bridgeDesignInsertAsset(
  bridge: RuntimeClient,
  workspaceId: string,
  input: {
    frame: string;
    sourceVersion: string;
    assetPath: string;
    x: number;
    y: number;
  },
): Promise<DesignMutationReplyWire> {
  return designMutationReply(
    await workspaceOp(bridge, "design.asset.insert", {
      workspaceId,
      ...input,
      ...scopedMutationSnapshot(bridge, workspaceId),
    }),
    "design.asset.insert",
  );
}

export async function bridgeDesignStage(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<{ ok: true }> {
  return (await workspaceOp(bridge, "design.stage", {
    workspaceId,
  })) as { ok: true };
}

export async function bridgeDesignSave(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<{ ok: true }> {
  return (await workspaceOp(bridge, "design.save", {
    workspaceId,
  })) as { ok: true };
}

export async function bridgeDesignCommit(
  bridge: RuntimeClient,
  workspaceId: string,
  message?: string,
): Promise<{ sha: string; branch: string }> {
  return (await workspaceOp(bridge, "design.commit", {
    workspaceId,
    ...(message ? { message } : {}),
  })) as { sha: string; branch: string };
}

/** Every design folder in a checkout (recognized by its committed
 *  `.zeros-canvas.json` marker) plus the resolved `[design] directory`
 *  pointer. `workspaceId` may be a workspace id or a known repo root. */
export interface DesignDirectoryListingWire {
  /** Stable identities from this checkout's tracked registry. */
  directoryIds?: Record<string, string>;
  /** Every folder recognized by a committed `.zeros-canvas.json` marker. */
  directories: string[];
  /** The resolved `[design] directory` pointer ("Zeros Design" when unset). */
  pointer: string;
  /** The folder the engine currently treats as active for this checkout. */
  active: string;
  /** The folder Design mode WOULD use on entry and whether its Design document
   *  is initialized. `exists: false` means switching to Design creates the
   *  document, even if an empty isolation-reservation folder is already on
   *  disk. Omitted by older engines; null when the engine's preview refused. */
  target?: { directory: string; exists: boolean } | null;
}

export async function bridgeDesignListDirectories(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<DesignDirectoryListingWire> {
  return (await workspaceOp(bridge, "design.listDirectories", {
    workspaceId,
  })) as DesignDirectoryListingWire;
}

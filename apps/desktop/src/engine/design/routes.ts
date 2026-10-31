import { designContextReferenceSchema } from "@zeros/protocol/design-context";
import {
  designFramesMoveSchema,
  designMovementGuardSchema,
  designRelocationSchema,
} from "@zeros/protocol/design-relocation";
import { designCatalogReadSchema, designNavigationReadSchema, designFramesPrepareSchema, type DesignCatalogRead, type DesignCatalogReply } from "@zeros/protocol/design-catalog";
import { prepareDesignNavigationFrames } from "./document";
import type { DesignCatalogAdmission } from "./catalog";
import { encodeDesignFramePath } from "@zeros/protocol/design-path";
import { designPageCreateInputSchema, designPageDeleteInputSchema, designPageIdSchema, designPageRenameInputSchema } from "@zeros/protocol/design-pages";
import { selectDesignPageHint } from "./page-selection";
import { DESIGN_CAPTURE_TIMEOUT_MS, designPreviewCancelSchema, designPreviewRequestSchema, designWorkspaceCaptureSchema } from "@zeros/protocol/design-capture";
import type { DesignPreviewJobs } from "./preview-jobs";
import { captureWorkspaceDesign, previewWorkspaceDesign } from "./workspace-capture";
import { openDesignVerification, designFramePreviewUrl } from "./verification-service";
import { createDesignContextReference, inspectDesignContext } from "./context";
import {
  designReviewCaptureRequestSchema,
  designReviewEvidenceRequestSchema,
} from "@zeros/protocol/design-review";
import {
  captureDesignProposalEvidence,
  readDesignReviewEvidence,
} from "./review-evidence";
import type { DesignLocalHistoryCheckpoint } from "@zeros/design-web";
import {
  designReviewRequestSchema,
  designReviewProposalRequestSchema,
  designReviewDecisionSchema,
  designReviewFileRequestSchema,
} from "@zeros/protocol/design-review";
import { readDesignReviewSnapshot, readDesignReviewFile } from "./review-git";
import {
  assertDesignReviewDirectory,
  readDesignProposalReview,
  resolveDesignProposalReview,
} from "./review";
import { removeDesignDirectory } from "./remove-directory";
import { designMetadataIndexPaths } from "./metadata-git";
import {
  adoptExistingDesignDirectory,
  previewExistingDesignDirectory,
} from "./adopt-directory";
import { stageDesignRegistry } from "./metadata-git";
import { createHash, randomUUID } from "node:crypto";
import { readCanvas } from "./document-storage";
import { refreshDesignStyleBuilds, setDesignStyleBuildPresence } from "./style-builds";
import { retryDesignFonts } from "./style-fonts";
import { designStyleBuildSettings, forgetDesignStyleSourceCaches } from "./style-sources";
import {
  designDirectoryFromSettings,
  designDocumentMetadataPath,
  readDesignDirectoryRegistry,
  readDesignStorageFile,
} from "./metadata";
import { MAX_DESIGN_TEXT_BYTES } from "./render-budget";
import * as fs from "node:fs";
import {
  GitError,
  assertGitCheckpointReady,
  commit,
  renameDesignDirectory,
  getWorkspaceById,
  listWorkspaces,
  stagePaths,
  unstagePaths,
  type Workspace,
} from "../git";
import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";
import {
  designTransactionSchema,
  type DesignOperation,
  type DesignActor,
} from "@zeros/design-core";
import {
  opSettingsPreviewWrite,
  opSettingsResolveWithOverride,
} from "../settings/ops";
import { personalRepoRoot } from "../settings/personal-repo";
import {
  designDocumentIdForFrame,
  forgetWorkspaceDesignApiFrames,
  getWorkspaceDesignApi,
} from "./design-api";
import { DesignPageTargetError, designPageForWrite, designPageFrameFiles } from "./pages";
import {
  captureDesignFrameRestorePoint,
  transferDesignNode,
  moveDesignFrameGeometries,
  restoreDesignFrameChanges,
  createDesignFrame,
  createDesignPage,
  renameDesignPage,
  deleteDesignPage,
  deleteDesignFrame,
  designDirectoryNameFor,
  DESIGN_TOKENS_FILE,
  duplicateDesignFrame,
  lintDesignDocument,
  listDesignFrames,
  readDesignFrame,
  readDesignMutationResult,
  recoverPendingDesignTransaction,
  readDesignElementOffsetMap,
  readDesignFrameRenderIdentity,
  readDesignFrameSelectionIdentity,
  readDesignTokens,
  readDesignTokensDocument,
  prepareDesignAssetInsertion,
  renameDesignFrame,
  replaceDesignFrameFromHistory,
  restoreDesignFrame,
  sameDesignFrameRestorePoint,
  type DesignLintViolation,
  type DesignWorkspaceSnapshot,
} from "./document";
import {
  discoverDesignDirectories,
  previewDesignDirectoryForEnter,
  resolveDesignDirectoryPointerState,
} from "./directory";
import { DEFAULT_DESIGN_DIRECTORY_NAME } from "./directory-registry";
import { stickyRecognizedDesignDirectories } from "./recognition-store";
import { withDesignWorkspaceMutation } from "./document-write-lock";
import { withMeasuredDesignMovement } from "./movement-guard";
import { upsertDesignTheme } from "./theme-lifecycle";
import { restoreDesignCatalogChange } from "./page-history";
import { setDesignRuntimeAudit } from "./runtime-audits";
import { normalizeDesignScreenshot, setDesignScreenshot } from "./screenshots";
import { setDesignSelection } from "./selection";
import { isKnownRepoRoot } from "../db/projects";

import {
  reqStr,
  reqNum,
  optStr,
  optNum,
  optBool,
  type Params,
} from "../workspace/params";
import {
  designSelectionStrings,
  designSelectionRects,
  designSelectionStyles,
  designMatchedDeclarations,
  designMutationStyles,
} from "./route-params";
import {
  catalogDesignHistoryBytes,
  catalogDesignHistoryEntry,
  captureCatalogDesignHistory,
  MAX_DESIGN_HISTORY_BYTES,
  transferDesignHistoryBytes,
  pruneWorkspaceDesignHistory,
  documentDesignHistoryEntry,
  geometryDesignHistoryEntry,
  frameDesignHistoryEntry,
  type WorkspaceDesignHistoryEntry,
  type WorkspaceDesignHistoryState,
} from "./workspace-history";
async function applyHumanDesignOperation(
  actor: DesignActor,
  workspacePath: string,
  frame: string,
  intent: string,
  operation: DesignOperation,
  coalesceKey?: string,
  expectedRevision?: string,
) {
  const api = getWorkspaceDesignApi(workspacePath);
  const documentId = designDocumentIdForFrame(frame);
  const baseRevision =
    expectedRevision ?? (await api.open(documentId)).revision;
  return api.apply({
    schemaVersion: 1,
    transactionId: `desktop:${randomUUID()}`,
    documentId,
    baseRevision,
    actor,
    intent,
    createdAt: Date.now(),
    ...(coalesceKey ? { coalesceKey } : {}),
    operations: [operation],
  });
}

export interface DesignReadWorkspace {
  workspace: Workspace;
  root: string;
  writeBack: boolean;
  designDirectory: string;
}
export interface DesignWorkspaceRouteHost {
  readDesignNavigation(workspaceId: string, remote: boolean, hostLocalResources: boolean): Promise<unknown>;
  previewJobs: DesignPreviewJobs;
  readDesignCatalog(input: DesignCatalogRead, remote: boolean, admission: DesignCatalogAdmission): Promise<DesignCatalogReply>;
  resolveDesignWorkspace(workspaceId: string, remote: boolean): Workspace;
  resolveReadCwd(workspaceId: string, remote: boolean): string;
  withDesignReadWorkspace<T>(
    workspaceId: string,
    remote: boolean,
    read: (target: DesignReadWorkspace) => Promise<T>,
  ): Promise<T>;
  designHistoryState(
    workspacePath: string,
    create?: boolean,
  ): WorkspaceDesignHistoryState | undefined;
  recordDesignHistory(
    workspacePath: string,
    entry: WorkspaceDesignHistoryEntry,
  ): void;
  pruneDesignHistoryFrames(
    workspacePath: string,
    frames: readonly string[],
    folder?: string,
  ): void;
  readDesignSnapshot(
    workspace: Workspace,
    remote: boolean,
    options?: {
      root?: string;
      writeBack?: boolean;
      designDirectory?: string;
      hostLocalResources?: boolean;
      fresh?: boolean;
      affectedFrames?: string[];
    },
  ): Promise<DesignWorkspaceSnapshot & { protocolCapability: string | null }>;
  readDesignSnapshotRequest(
    workspaceId: string,
    remote: boolean,
    hostLocalResources: boolean,
  ): Promise<DesignWorkspaceSnapshot & { protocolCapability: string | null }>;
}
const DESIGN_WORKSPACE_ROUTES = new Set([
  "design.navigation.read",
  "design.frames.prepare",
  "design.catalog.read",
  "design.capture",
  "design.preview",
  "design.preview.cancel",
  "design.styleBuilds.presence",
  "design.styles.refresh",
  "design.context.create",
  "design.context.inspect",
  "design.verification.open",
  "design.context.capture",
  "design.review.snapshot",
  "design.review.file",
  "design.review.proposal",
  "design.review.resolve",
  "design.review.capture",
  "design.review.evidence",
  "design.foundation.open",
  "design.projection",
  "design.provenance",
  "design.source",
  "design.transaction.apply",
  "design.history.undo",
  "design.history.redo",
  "design.frames",
  "design.frame",
  "design.snapshot",
  "design.tokens",
  "design.token.update",
  "design.lint",
  "design.selection.set",
  "design.screenshot.set",
  "design.runtime.audit",
  "design.frame.create",
  "design.page.create",
  "design.page.rename",
  "design.page.delete",
  "design.page.select",
  "design.themes.update",
  "design.frame.rename",
  "design.frame.duplicate",
  "design.frame.delete",
  "design.canvas.update",
  "design.frames.move",
  "design.node.transfer",
  "design.node.styles",
  "design.node.text",
  "design.node.html",
  "design.asset.insert",
  "design.stage",
  "design.unstage",
  "design.save",
  "design.commit",
  "design.listDirectories",
  "design.previewExistingDirectory",
  "design.adoptDirectory",
  "design.removeDirectory",
  "design.renameDirectory",
]);
export function isDesignWorkspaceRoute(op: string): boolean {
  return DESIGN_WORKSPACE_ROUTES.has(op);
}
/** Called only after WorkspaceService has admitted lifecycle, remote policy,
 * Git serialization, and the operation-scoped Design directory lease. */
export async function handleDesignWorkspaceRoute(
  host: DesignWorkspaceRouteHost,
  op: string,
  params: Params,
  options: { remote: boolean; hostLocalResources: boolean; catalogAdmission?: DesignCatalogAdmission; previewAdmission?: DesignCatalogAdmission },
): Promise<unknown> {
  const { remote, hostLocalResources } = options;
  const applyDesktopDesignOperation = applyHumanDesignOperation.bind(null, { kind: "human", id: "desktop" });
  switch (op) {
    case "design.navigation.read": {
      if (remote || !hostLocalResources) throw new Error("Design navigation requires a Local workspace.");
      return host.readDesignNavigation(designNavigationReadSchema.parse(params).workspaceId, remote, hostLocalResources);
    }
    case "design.frames.prepare": {
      if (remote || !hostLocalResources) throw new Error("Design preparation requires a Local workspace.");
      const input = designFramesPrepareSchema.parse(params);
      const result = await host.withDesignReadWorkspace(input.workspaceId, remote, ({ root }) =>
        prepareDesignNavigationFrames(root, input.catalogRevision, input.files, input.directoryId));
      // Older preparation decoders reject unknown fields. Keep their exact
      // reply shape; a new renderer opts in after capability negotiation.
      return input.surfaceCosts ? result : { ...result, frames: result.frames.map(({ surfaceCost: _cost, ...frame }) => frame) };
    }
    case "design.catalog.read": {
      if (!options.catalogAdmission) throw new GitError({ code: "REMOTE_RESTRICTED", message: "Design catalog requires a live connection." });
      return host.readDesignCatalog(designCatalogReadSchema.parse(params), remote, options.catalogAdmission);
    }
    case "design.capture": {
      const input = designWorkspaceCaptureSchema.parse(params);
      return host.withDesignReadWorkspace(input.workspaceId, remote, ({ root }) => captureWorkspaceDesign(root, input));
    }
    case "design.preview": {
      // A canvas preview of the saved source; it never changes the checkout.
      const input = designPreviewRequestSchema.parse(params);
      const run = (signal?: AbortSignal) => host.withDesignReadWorkspace(input.workspaceId, remote, ({ root }) => previewWorkspaceDesign(root, input, { signal }));
      if (!input.jobId) return run();
      if (!options.previewAdmission || !input.directoryId || !input.deadline || remote)
        throw new Error("Design preview cancellation requires a live Local connection and directory.");
      return host.previewJobs.run({ workspaceId: input.workspaceId, directoryId: input.directoryId, jobId: input.jobId, deadline: input.deadline }, options.previewAdmission, run);
    }
    case "design.preview.cancel": {
      const input = designPreviewCancelSchema.parse(params);
      if (!options.previewAdmission || remote) throw new Error("Design preview cancellation requires a live Local connection.");
      return host.previewJobs.cancel(input, options.previewAdmission);
    }
    case "design.styleBuilds.presence": {
      // A Design tab shows this workspace, or stopped showing it. Builds start
      // without waiting for them to finish; leaving starts their idle timer.
      const workspaceId = reqStr(params, "workspaceId");
      const present = params.present === true;
      return host.withDesignReadWorkspace(workspaceId, remote, async ({ root }) => {
        const canvas = present ? await readCanvas(root).catch(() => null) : null;
        await setDesignStyleBuildPresence(root, present, canvas ? designStyleBuildSettings(root, canvas) : []);
        return { ok: true };
      });
    }
    case "design.styles.refresh": {
      // The theme editor's Update: re-read every imported source from disk
      // and run its builds now. The caller re-reads the snapshot afterwards.
      const workspaceId = reqStr(params, "workspaceId");
      return host.withDesignReadWorkspace(workspaceId, remote, async ({ root }) => {
        forgetDesignStyleSourceCaches(root);
        retryDesignFonts();
        const canvas = await readCanvas(root).catch(() => null);
        await refreshDesignStyleBuilds(root, canvas ? designStyleBuildSettings(root, canvas) : []);
        return { ok: true };
      });
    }
    case "design.review.snapshot": {
      const input = designReviewRequestSchema.parse(params);
      return host.withDesignReadWorkspace(
        input.workspaceId,
        remote,
        ({ root }) =>
          withDesignWorkspaceMutation(root, () =>
            readDesignReviewSnapshot(input.workspaceId, root, input),
          ),
      );
    }
    case "design.review.file": {
      const input = designReviewFileRequestSchema.parse(params);
      return host.withDesignReadWorkspace(
        input.workspaceId,
        remote,
        ({ root }) =>
          withDesignWorkspaceMutation(root, () =>
            readDesignReviewFile(input.workspaceId, root, input),
          ),
      );
    }
    case "design.review.proposal": {
      const input = designReviewProposalRequestSchema.parse(params);
      return host.withDesignReadWorkspace(
        input.workspaceId,
        remote,
        ({ root }) => readDesignProposalReview(root, input),
      );
    }
    case "design.review.capture": {
      const input = designReviewCaptureRequestSchema.parse(params);
      host.resolveDesignWorkspace(input.workspaceId, remote);
      return host.withDesignReadWorkspace(input.workspaceId, remote, ({ root }) => captureDesignProposalEvidence(root, input));
    }
    case "design.review.evidence": {
      const input = designReviewEvidenceRequestSchema.parse(params);
      return host.withDesignReadWorkspace(
        input.workspaceId,
        remote,
        ({ root }) => readDesignReviewEvidence(root, input),
      );
    }
    case "design.review.resolve": {
      const input = designReviewDecisionSchema.parse(params);
      const workspace = host.resolveDesignWorkspace(input.workspaceId, remote);
      return resolveDesignProposalReview(workspace.path, input);
    }
    // ── Design document ────────────────────────────────────
    // Renderer and first-party MCP calls share this exact interpretation.
    // Every operation starts from an opaque workspace id and kind check; no
    // caller-supplied host path can escape into the filesystem layer.
    case "design.foundation.open": {
      return host.withDesignReadWorkspace(
        reqStr(params, "workspaceId"),
        remote,
        async ({ root }) => {
          const documentId = designDocumentIdForFrame(reqStr(params, "frame"));
          const api = getWorkspaceDesignApi(root);
          const summary = await api.open(documentId);
          return {
            summary,
            foundation: await api.readFoundation({
              documentId,
              expectedRevision: summary.revision,
            }),
          };
        },
      );
    }
    case "design.projection": {
      return host.withDesignReadWorkspace(
        reqStr(params, "workspaceId"),
        remote,
        async ({ root }) => {
          const documentId = designDocumentIdForFrame(reqStr(params, "frame"));
          return {
            projection: await getWorkspaceDesignApi(root).readProjection({
              documentId,
              expectedRevision: optStr(params, "expectedRevision"),
              cursor: optStr(params, "cursor"),
              limit: optNum(params, "limit"),
              maxDepth: optNum(params, "maxDepth"),
            }),
          };
        },
      );
    }
    case "design.provenance": {
      return host.withDesignReadWorkspace(
        reqStr(params, "workspaceId"),
        remote,
        async ({ root }) => {
          const documentId = designDocumentIdForFrame(reqStr(params, "frame"));
          return {
            provenance: await getWorkspaceDesignApi(root).readProvenance({
              documentId,
              nodeId: reqStr(params, "nodeId"),
              property: reqStr(params, "property"),
              expectedRevision: optStr(params, "expectedRevision"),
              computedValue:
                params.computedValue === null
                  ? null
                  : optStr(params, "computedValue"),
              ...(params.matched === undefined
                ? {}
                : { matched: designMatchedDeclarations(params.matched) }),
            }),
          };
        },
      );
    }
    case "design.source": {
      return host.withDesignReadWorkspace(
        reqStr(params, "workspaceId"),
        remote,
        async ({ root }) => {
          const documentId = designDocumentIdForFrame(reqStr(params, "frame"));
          return {
            source: await getWorkspaceDesignApi(root).readSource({
              documentId,
              file: reqStr(params, "file"),
              expectedRevision: optStr(params, "expectedRevision"),
            }),
          };
        },
      );
    }
    case "design.transaction.apply": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const documentId = designDocumentIdForFrame(reqStr(params, "frame"));
      let transaction;
      try {
        transaction = designTransactionSchema.parse(params.transaction);
      } catch (error) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "Design transaction is invalid.",
          cause: error,
        });
      }
      if (transaction.documentId !== documentId) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "Design transaction does not target the selected frame.",
        });
      }
      const dryRun = params.dryRun === true;
      const api = getWorkspaceDesignApi(workspace.path);
      if (dryRun) {
        return { result: await api.apply(transaction, { dryRun: true }) };
      }

      if (params.movementGuard !== undefined) {
        const guard = designMovementGuardSchema.parse(params.movementGuard);
        const frame = reqStr(params, "frame");
        const geometry = guard.geometry
          ? (await captureDesignFrameRestorePoint(workspace.path, frame))
              .geometry
          : null;
        const render = await readDesignFrameRenderIdentity(
          workspace.path,
          frame,
        );
        if (
          render.sourceVersion !== guard.sourceVersion ||
          (geometry &&
            guard.geometry &&
            (["x", "y", "w", "h", "z"] as const).some(
              (key) => geometry[key] !== guard.geometry![key],
            ))
        ) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message:
              "The source or frame geometry changed after this movement was measured.",
          });
        }
      }

      const result =
        params.movementGuard === undefined
          ? await api.apply(transaction)
          : await withMeasuredDesignMovement(
              workspace.path,
              reqStr(params, "frame"),
              designMovementGuardSchema.parse(params.movementGuard),
              () => api.apply(transaction),
            );
      if (result.receipt.status === "applied") {
        host.recordDesignHistory(
          workspace.path,
          documentDesignHistoryEntry(
            reqStr(params, "frame"),
            transaction.coalesceKey,
            transaction.createdAt,
          ),
        );
      }
      return {
        result,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
          ...(params.snapshotMode === "scoped" ? { affectedFrames: [...new Set([reqStr(params, "frame"), ...transaction.operations.flatMap(operation => operation.type === "frame.set-geometry" ? [operation.frame] : [])])] } : {}),
        }),
      };
    }
    case "design.history.undo":
    case "design.history.redo": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const direction = op === "design.history.undo" ? "undo" : "redo";
      const history = host.designHistoryState(workspace.path);
      const source = history?.[direction];
      const entry = source?.pop();
      if (history && source && entry) {
        const destination = direction === "undo" ? history.redo : history.undo;
        if (entry.kind === "catalog") {
          const api = getWorkspaceDesignApi(workspace.path);
          let currentHistory: Awaited<ReturnType<typeof captureCatalogDesignHistory>>;
          const before = direction === "undo" ? entry.change.after : entry.change.before;
          const after = direction === "undo" ? entry.change.before : entry.change.after;
          const changedFiles = entry.change.sources.map(change => change.file.slice(before.directory.length + 1));
          try {
            const presentFiles = entry.change.sources.filter(change => (direction === "undo" ? change.after : change.before) !== null)
              .map(change => change.file.slice(before.directory.length + 1)).filter(file => before.canvas.frames[file]);
            currentHistory = await captureCatalogDesignHistory(presentFiles, file => api.captureLocalHistory(designDocumentIdForFrame(file)));
            await restoreDesignCatalogChange(workspace.path, entry.change, direction);
          } catch (error) {
            if (error instanceof DesignPageTargetError) history.bytes = Math.max(0, history.bytes - entry.bytes);
            else source.push(entry);
            throw error;
          }
          forgetWorkspaceDesignApiFrames(workspace.path, changedFiles.filter(file => !after.canvas.frames[file]));
          const restored = direction === "undo" ? entry.beforeHistory : entry.afterHistory;
          for (const checkpoint of restored) await api.restoreLocalHistory(checkpoint).catch(() => false);
          if (direction === "undo") entry.afterHistory = currentHistory.checkpoints;
          else entry.beforeHistory = currentHistory.checkpoints;
          const bytes = currentHistory.complete ? catalogDesignHistoryBytes(entry) : MAX_DESIGN_HISTORY_BYTES + 1;
          history.bytes += bytes - entry.bytes; entry.bytes = bytes;
          destination.push(entry); pruneWorkspaceDesignHistory(history);
          const snapshot = await host.readDesignSnapshot(workspace, remote, { hostLocalResources, fresh: true });
          const page = snapshot.pages?.find(page => page.id === entry.pageId);
          return { result: null, snapshot,
            ...(entry.pageId ? { historyPageId: page?.id ?? snapshot.pages?.[0]?.id,
              historySelection: (page ?? snapshot.pages?.[0])?.frameFiles[0] ?? null } : {}) };
        }
        if (entry.kind === "transfer") {
          const api = getWorkspaceDesignApi(workspace.path);
          let currentHistory: DesignLocalHistoryCheckpoint[];
          try {
            currentHistory = [];
            for (const change of entry.changes) {
              const point = direction === "undo" ? change.after : change.before;
              if (point)
                currentHistory.push(
                  await api.captureLocalHistory(
                    designDocumentIdForFrame(point.file),
                  ),
                );
            }
            await restoreDesignFrameChanges(
              workspace.path,
              entry.changes,
              direction,
            );
          } catch (error) {
            if (error instanceof DesignPageTargetError)
              history.bytes = Math.max(0, history.bytes - entry.bytes);
            else source.push(entry);
            throw error;
          }
          const replacementHistory =
            direction === "undo" ? entry.beforeHistory : entry.afterHistory;
          for (const checkpoint of replacementHistory) {
            // Source restoration already committed atomically. If an
            // external writer won next, load() must keep its reconciliation.
            await api.restoreLocalHistory(checkpoint).catch(() => false);
          }
          if (direction === "undo") entry.afterHistory = currentHistory;
          else entry.beforeHistory = currentHistory;
          const bytes = transferDesignHistoryBytes(entry);
          history.bytes += bytes - entry.bytes;
          entry.bytes = bytes;
          destination.push(entry);
          pruneWorkspaceDesignHistory(history);
          const snapshot = await host.readDesignSnapshot(workspace, remote, {
            hostLocalResources,
            fresh: true,
          });
          return {
            result: null,
            snapshot,
            historySelection:
              direction === "redo"
                ? entry.frame
                : (entry.changes[0]?.before?.file ?? null),
            historyFrame: direction === "redo" ? entry.frame : (entry.changes[0]?.before?.file ?? entry.frame),
          };
        }
        if (entry.kind === "geometry") {
          try {
            await moveDesignFrameGeometries(
              workspace.path,
              entry.moves.map((move) => ({
                file: move.file,
                from: direction === "undo" ? move.after : move.before,
                to: direction === "undo" ? move.before : move.after,
              })),
            );
          } catch (error) {
            if (error instanceof DesignPageTargetError)
              history.bytes = Math.max(0, history.bytes - entry.bytes);
            else source.push(entry);
            throw error;
          }
          destination.push(entry);
          return {
            result: null,
            snapshot: await host.readDesignSnapshot(workspace, remote, {
              hostLocalResources,
              fresh: true,
            }),
            historySelection: entry.frame,
            historyFrame: entry.frame,
          };
        }
        if (entry.kind === "frame") {
          const expected = direction === "undo" ? entry.after : entry.before;
          const replacement = direction === "undo" ? entry.before : entry.after;
          try {
            if (expected && replacement) {
              await replaceDesignFrameFromHistory(
                workspace.path,
                expected,
                replacement,
              );
            } else if (expected) {
              await deleteDesignFrame(workspace.path, expected.file, expected);
            } else if (replacement) {
              await restoreDesignFrame(workspace.path, replacement);
            } else {
              throw new Error("Design frame history entry is empty.");
            }
          } catch (error) {
            if (error instanceof DesignPageTargetError)
              history.bytes = Math.max(0, history.bytes - entry.bytes);
            else source.push(entry);
            throw error;
          }
          destination.push(entry);
          const snapshot = await host.readDesignSnapshot(workspace, remote, {
            hostLocalResources,
            fresh: true,
          });
          const affectedPage = snapshot.pages?.find(page => page.id === (replacement ?? expected)?.pageId);
          return {
            result: null,
            snapshot,
            historySelection:
              replacement?.file ?? (affectedPage ? affectedPage.frameFiles[0] : snapshot.frames[0]?.file) ?? null,
            historyFrame: (replacement ?? expected)!.file,
          };
        }

        const api = getWorkspaceDesignApi(workspace.path);
        const documentId = designDocumentIdForFrame(entry.frame);
        let result;
        try {
          result =
            direction === "undo"
              ? await api.undo(documentId)
              : await api.redo(documentId);
        } catch (error) {
          if (error instanceof DesignPageTargetError)
            history.bytes = Math.max(0, history.bytes - entry.bytes);
          else source.push(entry);
          throw error;
        }
        if (result) destination.push(entry);
        else history.bytes = Math.max(0, history.bytes - entry.bytes);
        return {
          result,
          snapshot: await host.readDesignSnapshot(workspace, remote, {
            hostLocalResources,
            fresh: true,
          }),
          ...(result ? { historyFrame: entry.frame } : {}),
        };
      }

      // Compatibility fallback for a history session created before this
      // service began tracking workspace-wide ordering. An empty canvas has
      // no fallback document, but a structural deletion above still works.
      const frame = optStr(params, "frame");
      if (!frame) {
        return {
          result: null,
          snapshot: await host.readDesignSnapshot(workspace, remote, {
            hostLocalResources,
            fresh: true,
          }),
        };
      }
      const documentId = designDocumentIdForFrame(frame);
      const api = getWorkspaceDesignApi(workspace.path);
      const result =
        direction === "undo"
          ? await api.undo(documentId)
          : await api.redo(documentId);
      return {
        result,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
        }),
        ...(result ? { historyFrame: frame } : {}),
      };
    }
    case "design.context.create": {
      const workspaceId = reqStr(params, "workspaceId");
      return host.withDesignReadWorkspace(workspaceId, remote, async ({ root }) => ({
        reference: await createDesignContextReference(root, workspaceId, reqStr(params, "frame"), optStr(params, "nodeId"), optStr(params, "expectedDirectoryId")),
      }));
    }
    case "design.context.inspect": {
      const reference = designContextReferenceSchema.parse(params.reference);
      if (reqStr(params, "workspaceId") !== reference.workspaceId) throw new GitError({ code: "VALIDATION_FAILED", message: "The Design reference belongs to another workspace." });
      return host.withDesignReadWorkspace(reference.workspaceId, remote, async ({ root, designDirectory }) => {
        const inspection = await inspectDesignContext(root, reference);
        if (inspection.status !== "ready" || remote || !hostLocalResources) return inspection;
        const verification = await openDesignVerification({ workspaceId: reference.workspaceId, workspacePath: root, directory: designDirectory, directoryId: reference.directoryId });
        return { ...inspection, verification, previewUrl: designFramePreviewUrl(verification, reference) };
      });
    }
    case "design.verification.open": {
      // The qualified cloud primary owns its loopback preview. Desktop clients
      // reach it only through the existing authenticated Browser preview host.
      if (remote || !hostLocalResources) throw new Error("Frame preview is currently available in local workspaces.");
      const workspaceId = reqStr(params, "workspaceId");
      return host.withDesignReadWorkspace(workspaceId, false, async ({ root, designDirectory }) => {
        const reference = await createDesignContextReference(root, workspaceId, reqStr(params, "frame"), undefined, reqStr(params, "directoryId"));
        const verification = await openDesignVerification({ workspaceId, workspacePath: root, directory: designDirectory, directoryId: reference.directoryId });
        return { reference, verification, previewUrl: designFramePreviewUrl(verification, reference) };
      });
    }
    case "design.context.capture": {
      if (remote || !hostLocalResources) throw new Error("Frame image attachments require an admitted workspace host.");
      const reference = designContextReferenceSchema.parse(params.reference);
      if (reqStr(params, "workspaceId") !== reference.workspaceId)
        throw new Error("The frame belongs to another workspace.");
      return host.withDesignReadWorkspace(
        reference.workspaceId,
        false,
        async ({ root, designDirectory }) => {
          if ((await inspectDesignContext(root, reference)).status !== "ready")
            throw new Error(
              "The selected frame changed. Send again to capture its current revision.",
            );
          const access = await openDesignVerification({
            workspaceId: reference.workspaceId,
            workspacePath: root,
            directory: designDirectory,
            directoryId: reference.directoryId,
          });
          const response = await fetch(
            `${access.url}/${encodeDesignFramePath(reference.frame)}/capture?revision=${reference.revision}&frameId=${encodeURIComponent(reference.frameId ?? "")}`,
            {
              signal: AbortSignal.timeout(DESIGN_CAPTURE_TIMEOUT_MS + 3_000),
              redirect: "error",
            },
          );
          if (!response.ok) {
            const error = (await response.json()) as { error: string };
            throw new Error(error.error);
          }
          return {
            reference,
            mimeType: "image/png",
            data: Buffer.from(await response.arrayBuffer()).toString("base64"),
          };
        },
      );
    }
    case "design.frames": {
      return host.withDesignReadWorkspace(
        reqStr(params, "workspaceId"),
        remote,
        async ({ root, writeBack }) => ({
          frames: await listDesignFrames(root, { writeBack }),
        }),
      );
    }
    case "design.frame": {
      return host.withDesignReadWorkspace(
        reqStr(params, "workspaceId"),
        remote,
        async ({ root, writeBack }) => ({
          frame: await readDesignFrame(
            root,
            reqStr(params, "frame"),
            optNum(params, "depth") ?? 4,
            { writeBack },
          ),
        }),
      );
    }
    case "design.snapshot": {
      return {
        snapshot: await host.readDesignSnapshotRequest(
          reqStr(params, "workspaceId"),
          remote,
          hostLocalResources,
        ),
      };
    }
    case "design.tokens": {
      return host.withDesignReadWorkspace(
        reqStr(params, "workspaceId"),
        remote,
        async ({ root }) => ({ tokens: await readDesignTokens(root) }),
      );
    }
    case "design.token.update": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const theme = params.theme;
      if (theme !== null && typeof theme !== "string") {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "Design token theme must be a string or null.",
        });
      }
      const requestedFrame = optStr(params, "frame");
      const frame =
        requestedFrame ??
        (
          await listDesignFrames(workspace.path, {
            writeBack: false,
          })
        )[0]?.file;
      if (!frame) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "A design frame is required to own token history.",
        });
      }
      const api = getWorkspaceDesignApi(workspace.path);
      const documentId = designDocumentIdForFrame(frame);
      const summary = await api.open(documentId);
      const current = await readDesignTokensDocument(workspace.path);
      if (current.sourceVersion !== reqStr(params, "sourceVersion")) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message:
            "Design tokens changed before the mutation. Re-read them and retry.",
        });
      }
      const name = reqStr(params, "name");
      if (!current.tokens.some((token) => token.name === name)) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `Design token not found: ${name}`,
        });
      }
      const operationId = randomUUID();
      const applied = await applyDesktopDesignOperation(
        workspace.path,
        frame,
        `Change ${name}${theme ? ` for ${theme}` : ""}`,
        {
          operationId,
          type: "token.set",
          file: DESIGN_TOKENS_FILE,
          name,
          theme,
          value: reqStr(params, "value"),
        },
        `token:${theme ?? "base"}:${name}`,
        summary.revision,
      );
      const mutation = {
        changed: applied.receipt.status === "applied",
        document: await readDesignTokensDocument(workspace.path),
      };
      if (mutation.changed) {
        host.recordDesignHistory(
          workspace.path,
          documentDesignHistoryEntry(frame, `token:${theme ?? "base"}:${name}`),
        );
      }
      return {
        mutation,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
        }),
        foundationRevision: {
          before: applied.receipt.beforeRevision,
          after: applied.receipt.afterRevision,
        },
      };
    }
    case "design.lint": {
      return host.withDesignReadWorkspace(
        reqStr(params, "workspaceId"),
        remote,
        async ({ workspace, root, writeBack }) => {
          const report = await lintDesignDocument(
            root,
            optStr(params, "frame"),
            { healOids: writeBack },
          );
          return {
            report: { ...report, workspacePath: workspace.path },
          };
        },
      );
    }
    case "design.selection.set": {
      if (remote) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "Canvas selection is local to the desktop.",
        });
      }
      const workspaceId = reqStr(params, "workspaceId");
      const workspace = host.resolveDesignWorkspace(workspaceId, false);
      const selectionVersion = reqNum(params, "selectionVersion");
      if (!Number.isSafeInteger(selectionVersion) || selectionVersion <= 0) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "selectionVersion must be a positive safe integer.",
        });
      }
      const frameFile = optStr(params, "frame");
      if (!frameFile) {
        setDesignSelection(workspaceId, null, selectionVersion);
        return { ok: true };
      }
      const frame = await readDesignFrameSelectionIdentity(
        workspace.path,
        frameFile,
      );
      const sourceVersion = reqStr(params, "sourceVersion");
      if (
        !/^[a-f0-9]{24}$/.test(sourceVersion) ||
        sourceVersion !== frame.sourceVersion
      ) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `Design selection source changed before publication: ${frame.file}`,
        });
      }
      const nodeIds = designSelectionStrings(
        params.nodeIds ?? [],
        "nodeIds",
        DESIGN_SELECTION_NODE_LIMIT,
        256,
      );
      if (nodeIds.length > 0) {
        const validNodeIds = new Set(frame.nodeIds);
        const missing = nodeIds.find((nodeId) => !validNodeIds.has(nodeId));
        if (missing) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: `Design element not found in ${frame.file}: ${missing}`,
          });
        }
      }
      const breadcrumb = designSelectionStrings(
        params.breadcrumb ?? [],
        "breadcrumb",
        16,
        160,
        true,
      );
      const rects = designSelectionRects(params.rects ?? []);
      const updatedAt = reqNum(params, "updatedAt");
      if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "updatedAt must be a positive safe integer.",
        });
      }
      if (nodeIds.length > 0 && rects.length !== nodeIds.length) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "Element selections require one rectangle per nodeId.",
        });
      }
      setDesignSelection(
        workspaceId,
        {
          frame: frame.file,
          filePath: `${designDirectoryNameFor(workspace.path)}/${frame.file}`,
          sourceVersion,
          nodeIds,
          breadcrumb: breadcrumb.length > 0 ? breadcrumb : [frame.title],
          rects:
            rects.length > 0
              ? rects
              : [
                  {
                    x: frame.x,
                    y: frame.y,
                    width: frame.width,
                    height: frame.height,
                  },
                ],
          keyComputedStyles: designSelectionStyles(params.keyComputedStyles),
          updatedAt,
        },
        selectionVersion,
      );
      return { ok: true };
    }
    case "design.screenshot.set": {
      if (remote) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "Design screenshots are local to the desktop canvas.",
        });
      }
      const workspaceId = reqStr(params, "workspaceId");
      const workspace = host.resolveDesignWorkspace(workspaceId, false);
      const frameFile = reqStr(params, "frame");
      const frame = await readDesignFrameRenderIdentity(
        workspace.path,
        frameFile,
      );
      const sourceVersion = reqStr(params, "sourceVersion");
      if (
        !/^[a-f0-9]{24}$/.test(sourceVersion) ||
        sourceVersion !== frame.sourceVersion
      ) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `Design screenshot source changed before capture completed: ${frame.file}`,
        });
      }
      const nodeId = optStr(params, "nodeId") ?? null;
      if (nodeId) {
        const validNodeIds = new Set(
          (await readDesignElementOffsetMap(workspace.path, frame.file)).map(
            (offset) => offset.oid,
          ),
        );
        if (!validNodeIds.has(nodeId)) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: `Design element not found in ${frame.file}: ${nodeId}`,
          });
        }
      }
      const mimeType = reqStr(params, "mimeType");
      if (
        mimeType !== "image/png" &&
        mimeType !== "image/jpeg" &&
        mimeType !== "image/webp"
      ) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `Unsupported design screenshot type: ${mimeType}`,
        });
      }
      setDesignScreenshot(
        normalizeDesignScreenshot({
          workspaceId,
          frame: frame.file,
          nodeId,
          mimeType,
          data: reqStr(params, "data"),
          width: reqNum(params, "width"),
          height: reqNum(params, "height"),
          scale: reqNum(params, "scale"),
          capturedAt: Date.now(),
          sourceVersion,
        }),
        workspace.path,
      );
      return { ok: true };
    }
    case "design.runtime.audit": {
      if (remote) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "Design runtime audits are local to the desktop canvas.",
        });
      }
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        false,
      );
      const frame = await readDesignFrameRenderIdentity(
        workspace.path,
        reqStr(params, "frame"),
      );
      const sourceVersion = reqStr(params, "sourceVersion");
      if (sourceVersion !== frame.sourceVersion) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `Design runtime audit source changed before publication: ${frame.file}`,
        });
      }
      if (!Array.isArray(params.warnings) || params.warnings.length > 128) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "Design runtime warnings must be a bounded array.",
        });
      }
      const offsets = new Map(
        (await readDesignElementOffsetMap(workspace.path, frame.file)).map(
          (offset) => [offset.oid, offset],
        ),
      );
      const allowed = new Set([
        "contrast",
        "overflow",
        "spacing-scale",
        "audit-limit",
        "layer-tree-limit",
      ]);
      const warnings: DesignLintViolation[] = [];
      for (const rawWarning of params.warnings) {
        if (
          !rawWarning ||
          typeof rawWarning !== "object" ||
          Array.isArray(rawWarning)
        ) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: "Design runtime warning is malformed.",
          });
        }
        const warning = rawWarning as Record<string, unknown>;
        const ruleId = reqStr(warning, "ruleId");
        const oid = reqStr(warning, "oid");
        const message = reqStr(warning, "message");
        const fix = reqStr(warning, "fix");
        if (
          !allowed.has(ruleId) ||
          message.length > 1_000 ||
          fix.length > 1_000
        ) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: "Design runtime warning is invalid.",
          });
        }
        const offset = offsets.get(oid);
        if (!offset) continue;
        warnings.push({
          ruleId: ruleId as DesignLintViolation["ruleId"],
          severity: "warning",
          message,
          file: frame.file,
          line: offset.startLine,
          column: offset.startColumn,
          oid,
          fix,
        });
      }
      setDesignRuntimeAudit({
        workspacePath: workspace.path,
        frame: frame.file,
        sourceVersion,
        warnings,
      });
      // Optional readback lets lazy canvases settle this exact frame's audit
      // without composing every offscreen source via an aggregate refresh.
      return { ok: true, sourceVersion, violations: warnings };
    }
    case "design.page.select": {
      const workspaceId = reqStr(params, "workspaceId");
      const root = host.resolveReadCwd(workspaceId, remote);
      selectDesignPageHint(workspaceId, root, {
        directoryId: reqStr(params, "directoryId"),
        pageId: designPageIdSchema.parse(params.pageId),
      });
      return { ok: true };
    }
    case "design.page.create":
    case "design.page.rename":
    case "design.page.delete": {
      const workspace = host.resolveDesignWorkspace(reqStr(params, "workspaceId"), remote);
      return withDesignWorkspaceMutation(workspace.path, async () => {
        if (op === "design.page.delete") {
          const input = designPageDeleteInputSchema.parse({
            pageId: params.pageId,
            expectedFrameIds: params.expectedFrameIds,
          });
          const canvas = await readCanvas(workspace.path);
          const files = designPageFrameFiles(canvas, designPageForWrite(canvas, input.pageId));
          const api = getWorkspaceDesignApi(workspace.path);
          const beforeHistory = await captureCatalogDesignHistory(files, async file => {
            // A registered source may already be missing. Deleting the page
            // must retain that absence, while unsafe files still refuse.
            if (readDesignStorageFile(workspace.path, `${designDirectoryNameFor(workspace.path)}/${file}`, MAX_DESIGN_TEXT_BYTES, true) !== null)
              return api.captureLocalHistory(designDocumentIdForFrame(file));
            return null;
          });
          const deleted = await deleteDesignPage(
            workspace.path,
            input.pageId,
            input.expectedFrameIds,
            change => host.recordDesignHistory(workspace.path, catalogDesignHistoryEntry(change, input.pageId, beforeHistory.checkpoints, beforeHistory.complete)),
          );
          forgetWorkspaceDesignApiFrames(
            workspace.path,
            deleted.frameFiles,
            deleted.folder,
          );
          return {
            deleted: { pageId: input.pageId },
            snapshot: await host.readDesignSnapshot(workspace, remote, {
              hostLocalResources,
              fresh: true,
            }),
          };
        }
        let page;
        if (op === "design.page.create") {
          page = await createDesignPage(workspace.path, designPageCreateInputSchema.parse({ title: params.title }), change => {
            const created = change.after.canvas.pages?.find(page => !change.before.canvas.pages?.some(previous => previous.id === page.id));
            host.recordDesignHistory(workspace.path, catalogDesignHistoryEntry(change, created?.id));
          });
        } else {
          const input = designPageRenameInputSchema.parse({ pageId: params.pageId, title: params.title });
          page = await renameDesignPage(workspace.path, input.pageId, input.title,
            change => host.recordDesignHistory(workspace.path, catalogDesignHistoryEntry(change, input.pageId)));
        }
        return { page, snapshot: await host.readDesignSnapshot(workspace, remote, { hostLocalResources, fresh: true }) };
      });
    }
    case "design.themes.update": {
      // Name one theme, or make it the default, from the theme editor.
      const workspace = host.resolveDesignWorkspace(reqStr(params, "workspaceId"), remote);
      const theme = params.theme as Record<string, unknown> | null | undefined;
      if (!theme || typeof theme.id !== "string" || typeof theme.label !== "string" || (theme.base !== undefined && typeof theme.base !== "boolean"))
        throw new Error("design.themes.update requires a theme with a string id and label.");
      const input = { id: theme.id, label: theme.label, ...(theme.base === true ? { base: true } : {}) };
      return withDesignWorkspaceMutation(workspace.path, async () => ({
        themes: await upsertDesignTheme(workspace.path, input,
          change => host.recordDesignHistory(workspace.path, catalogDesignHistoryEntry(change))),
        snapshot: await host.readDesignSnapshot(workspace, remote, { hostLocalResources, fresh: true }),
      }));
    }
    case "design.frame.create": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const geometryKeys = ["x", "y", "w", "h", "z"] as const;
      const suppliedGeometryKeys = geometryKeys.filter(
        (key) => params[key] !== undefined,
      );
      if (
        suppliedGeometryKeys.length > 0 &&
        suppliedGeometryKeys.length !== geometryKeys.length
      ) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "Initial frame geometry requires x, y, w, h, and z.",
        });
      }
      const frame = await createDesignFrame(workspace.path, {
        title: optStr(params, "title"),
        pageId: designPageIdSchema.optional().parse(params.pageId),
        ...(suppliedGeometryKeys.length === geometryKeys.length
          ? {
              geometry: {
                x: reqNum(params, "x"),
                y: reqNum(params, "y"),
                w: reqNum(params, "w"),
                h: reqNum(params, "h"),
                z: reqNum(params, "z"),
              },
            }
          : {}),
        ...(params.kind === "text"
          ? {
              seed: {
                kind: "text" as const,
                nodeId: reqStr(params, "textNodeId"),
                text: reqStr(params, "text"),
                fixedSize: optBool(params, "textFixedSize") ?? false,
              },
            }
          : {}),
      });
      host.recordDesignHistory(
        workspace.path,
        frameDesignHistoryEntry(
          null,
          await captureDesignFrameRestorePoint(workspace.path, frame.file),
        ),
      );
      return {
        frame,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
          ...(params.snapshotMode === "scoped" ? { affectedFrames: [frame.file] } : {}),
        }),
      };
    }
    case "design.frame.rename": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const file = reqStr(params, "frame");
      const before = await captureDesignFrameRestorePoint(workspace.path, file);
      const frame = await renameDesignFrame(
        workspace.path,
        file,
        reqStr(params, "title"),
      );
      const after = await captureDesignFrameRestorePoint(workspace.path, file);
      if (!sameDesignFrameRestorePoint(before, after)) {
        host.recordDesignHistory(
          workspace.path,
          frameDesignHistoryEntry(before, after),
        );
      }
      return {
        frame,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
        }),
      };
    }
    case "design.frame.duplicate": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const frame = await duplicateDesignFrame(
        workspace.path,
        reqStr(params, "frame"),
        { pageId: designPageIdSchema.optional().parse(params.pageId),
          ...(params.geometry !== undefined ? designMovementGuardSchema.parse({ sourceVersion: params.sourceVersion, geometry: params.geometry }) : {}) },
      );
      host.recordDesignHistory(
        workspace.path,
        frameDesignHistoryEntry(
          null,
          await captureDesignFrameRestorePoint(workspace.path, frame.file),
        ),
      );
      return {
        frame,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
          ...(params.snapshotMode === "scoped" ? { affectedFrames: [frame.file, reqStr(params, "frame")] } : {}),
        }),
      };
    }
    case "design.frame.delete": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const restorePoint = await deleteDesignFrame(
        workspace.path,
        reqStr(params, "frame"),
      );
      host.recordDesignHistory(
        workspace.path,
        frameDesignHistoryEntry(restorePoint, null),
      );
      return {
        deleted: { file: restorePoint.file },
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
          ...(params.snapshotMode === "scoped" ? { affectedFrames: [] } : {}),
        }),
      };
    }
    case "design.canvas.update": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const frame = reqStr(params, "frame");
      const coalesceKey = `frame-geometry:${frame.includes("/") ? createHash("sha256").update(frame).digest("hex").slice(0, 24) : frame}`;
      const geometry = {
        x: Math.min(1_000_000, Math.max(-1_000_000, reqNum(params, "x"))),
        y: Math.min(1_000_000, Math.max(-1_000_000, reqNum(params, "y"))),
        w: Math.min(16_384, Math.max(1, reqNum(params, "w"))),
        h: Math.min(16_384, Math.max(1, reqNum(params, "h"))),
        z: Math.round(Math.min(256, Math.max(0, reqNum(params, "z")))),
      };
      const operationId = randomUUID();
      const applied = await applyDesktopDesignOperation(
        workspace.path,
        frame,
        `Move or resize ${frame}`,
        {
          operationId,
          type: "frame.set-geometry",
          frame,
          geometry: {
            x: geometry.x,
            y: geometry.y,
            width: geometry.w,
            height: geometry.h,
            z: geometry.z,
          },
        },
        coalesceKey,
      );
      if (applied.receipt.status === "applied") {
        host.recordDesignHistory(
          workspace.path,
          documentDesignHistoryEntry(frame, coalesceKey),
        );
      }
      return {
        geometry,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
          ...(params.snapshotMode === "scoped" ? { affectedFrames: [frame] } : {}),
        }),
        foundationRevision: {
          before: applied.receipt.beforeRevision,
          after: applied.receipt.afterRevision,
        },
      };
    }
    case "design.frames.move": {
      // Several selected canvas frames move together in one canvas write
      // and one undo step.
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const moves = designFramesMoveSchema.parse(params.moves);
      await moveDesignFrameGeometries(
        workspace.path,
        moves.map((move) => ({ file: move.frame, from: move.from, to: move.to })),
      );
      host.recordDesignHistory(
        workspace.path,
        geometryDesignHistoryEntry(
          moves.map((move) => ({ file: move.frame, before: move.from, after: move.to })),
        ),
      );
      return {
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
          ...(params.snapshotMode === "scoped" ? { affectedFrames: moves.map(move => move.frame) } : {}),
        }),
      };
    }
    case "design.node.transfer": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const destinationFrame = optStr(params, "destinationFrame");
      const frame = reqStr(params, "frame");
      const api = getWorkspaceDesignApi(workspace.path);
      const beforeHistory: DesignLocalHistoryCheckpoint[] = [];
      for (const file of new Set([
        frame,
        ...(destinationFrame ? [destinationFrame] : []),
      ])) {
        beforeHistory.push(
          await api.captureLocalHistory(designDocumentIdForFrame(file)),
        );
      }
      const result = await transferDesignNode(workspace.path, {
        frame,
        ...(params.duplicateNodeId !== undefined ? { duplicateNodeId: reqStr(params, "duplicateNodeId") } : {}),
        pageId: designPageIdSchema.optional().parse(params.pageId),
        sourceVersion: reqStr(params, "sourceVersion"),
        nodeId: reqStr(params, "nodeId"),
        ...(destinationFrame
          ? {
              destinationFrame,
              destinationSourceVersion: reqStr(
                params,
                "destinationSourceVersion",
              ),
              parentId: reqStr(params, "parentId"),
              beforeId: optStr(params, "beforeId") ?? null,
            }
          : {}),
        ...(params.styles
          ? { styles: designMutationStyles(params.styles) }
          : {}),
        ...(params.relocation !== undefined
          ? { relocation: designRelocationSchema.parse(params.relocation) }
          : {}),
        ...(params.movementGuard !== undefined
          ? {
              movementGuard: designMovementGuardSchema.parse(
                params.movementGuard,
              ),
            }
          : {}),
        ...(params.destinationMovementGuard !== undefined
          ? {
              destinationMovementGuard: designMovementGuardSchema.parse(
                params.destinationMovementGuard,
              ),
            }
          : {}),
        ...(params.parentStyles !== undefined
          ? { parentStyles: params.parentStyles as { position: "relative" } }
          : {}),
        ...(params.frameBackground !== undefined
          ? { frameBackground: reqStr(params, "frameBackground") }
          : {}),
        geometry: {
          x: reqNum(params, "x"),
          y: reqNum(params, "y"),
          w: reqNum(params, "w"),
          h: reqNum(params, "h"),
          z: reqNum(params, "z"),
        },
      });
      const entry: Extract<WorkspaceDesignHistoryEntry, { kind: "transfer" }> =
        {
          kind: "transfer",
          changes: result.changes,
          frame: result.frame,
          beforeHistory,
          afterHistory: [],
          bytes: 0,
        };
      entry.bytes = transferDesignHistoryBytes(entry);
      host.recordDesignHistory(workspace.path, entry);
      return {
        frame: result.frame,
        nodeId: result.nodeId,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
          ...(params.snapshotMode === "scoped" ? { affectedFrames: [result.frame, frame] } : {}),
        }),
      };
    }
    case "design.node.styles": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const frame = reqStr(params, "frame");
      const sourceVersion = reqStr(params, "sourceVersion");
      const api = getWorkspaceDesignApi(workspace.path);
      const documentId = designDocumentIdForFrame(frame);
      // The authored revision (files, manifest, and geometry) and rendered
      // sourceVersion (composed HTML/CSS/assets/viewport) are distinct CAS
      // identities. Compatibility mutation handlers must validate both before
      // adapting the request into a Foundation transaction.
      const summary = await api.open(documentId);
      const render = await readDesignFrameRenderIdentity(workspace.path, frame);
      if (render.sourceVersion !== sourceVersion) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `Design frame changed before the mutation: ${render.file}. Re-read it and retry.`,
        });
      }
      const operationId = randomUUID();
      const nodeId = reqStr(params, "nodeId");
      const applied = await applyDesktopDesignOperation(
        workspace.path,
        frame,
        `Change styles on ${nodeId}`,
        {
          operationId,
          type: "node.set-styles",
          nodeId,
          styles: designMutationStyles(params.styles),
          scope: "auto",
          responsiveContext: "base",
          stateContext: "default",
        },
        undefined,
        summary.revision,
      );
      const mutation = await readDesignMutationResult(
        workspace.path,
        frame,
        applied.receipt.status === "applied",
      );
      if (applied.receipt.status === "applied") {
        host.recordDesignHistory(
          workspace.path,
          documentDesignHistoryEntry(frame),
        );
      }
      return {
        mutation,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
          ...(params.snapshotMode === "scoped" ? { affectedFrames: [frame] } : {}),
        }),
        foundationRevision: {
          before: applied.receipt.beforeRevision,
          after: applied.receipt.afterRevision,
        },
      };
    }
    case "design.node.text": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const frame = reqStr(params, "frame");
      const sourceVersion = reqStr(params, "sourceVersion");
      const api = getWorkspaceDesignApi(workspace.path);
      const documentId = designDocumentIdForFrame(frame);
      const summary = await api.open(documentId);
      const render = await readDesignFrameRenderIdentity(workspace.path, frame);
      if (render.sourceVersion !== sourceVersion) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `Design frame changed before the mutation: ${render.file}. Re-read it and retry.`,
        });
      }
      const text =
        typeof params.text === "string" ? params.text : reqStr(params, "text");
      if (text.length > 10_000) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "Design text is too long.",
        });
      }
      const operationId = randomUUID();
      const nodeId = reqStr(params, "nodeId");
      const applied = await applyDesktopDesignOperation(
        workspace.path,
        frame,
        `Change text on ${nodeId}`,
        {
          operationId,
          type: "node.set-text",
          nodeId,
          text,
        },
        undefined,
        summary.revision,
      );
      const mutation = await readDesignMutationResult(
        workspace.path,
        frame,
        applied.receipt.status === "applied",
      );
      if (applied.receipt.status === "applied") {
        host.recordDesignHistory(
          workspace.path,
          documentDesignHistoryEntry(frame),
        );
      }
      return {
        mutation,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
          ...(params.snapshotMode === "scoped" ? { affectedFrames: [frame] } : {}),
        }),
        foundationRevision: {
          before: applied.receipt.beforeRevision,
          after: applied.receipt.afterRevision,
        },
      };
    }
    case "design.node.html": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const mode = optStr(params, "mode");
      if (mode && mode !== "append" && mode !== "replace-inner") {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `Unsupported design HTML write mode: ${mode}`,
        });
      }
      const writeMode = mode === "append" ? "append" : "replace-inner";
      const frame = reqStr(params, "frame");
      const sourceVersion = reqStr(params, "sourceVersion");
      const api = getWorkspaceDesignApi(workspace.path);
      const documentId = designDocumentIdForFrame(frame);
      const summary = await api.open(documentId);
      const render = await readDesignFrameRenderIdentity(workspace.path, frame);
      if (render.sourceVersion !== sourceVersion) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `Design frame changed before the mutation: ${render.file}. Re-read it and retry.`,
        });
      }
      const html = reqStr(params, "html");
      if (!html || html.length > 200_000) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "html must contain between 1 and 200000 characters.",
        });
      }
      const operationId = randomUUID();
      const nodeId = reqStr(params, "nodeId");
      const applied = await applyDesktopDesignOperation(
        workspace.path,
        frame,
        `${writeMode === "append" ? "Append" : "Replace"} HTML on ${nodeId}`,
        {
          operationId,
          type: "node.set-html",
          nodeId,
          html,
          mode: writeMode,
        },
        undefined,
        summary.revision,
      );
      const mutation = await readDesignMutationResult(
        workspace.path,
        frame,
        applied.receipt.status === "applied",
      );
      if (applied.receipt.status === "applied") {
        host.recordDesignHistory(
          workspace.path,
          documentDesignHistoryEntry(frame),
        );
      }
      return {
        mutation,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
          ...(params.snapshotMode === "scoped" ? { affectedFrames: [frame] } : {}),
        }),
        foundationRevision: {
          before: applied.receipt.beforeRevision,
          after: applied.receipt.afterRevision,
        },
      };
    }
    case "design.asset.insert": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      const frame = reqStr(params, "frame");
      const sourceVersion = reqStr(params, "sourceVersion");
      const api = getWorkspaceDesignApi(workspace.path);
      const documentId = designDocumentIdForFrame(frame);
      const summary = await api.open(documentId);
      const render = await readDesignFrameRenderIdentity(workspace.path, frame);
      if (render.sourceVersion !== sourceVersion) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `Design frame changed before the mutation: ${render.file}. Re-read it and retry.`,
        });
      }
      const prepared = await prepareDesignAssetInsertion(workspace.path, {
        frame,
        sourceVersion,
        assetPath: reqStr(params, "assetPath"),
        x: reqNum(params, "x"),
        y: reqNum(params, "y"),
      });
      const operationId = randomUUID();
      const apply = () => applyDesktopDesignOperation(
        workspace.path,
        frame,
        `Insert ${reqStr(params, "assetPath")}`,
        {
          operationId,
          type: "node.set-html",
          nodeId: prepared.nodeId,
          html: prepared.html,
          mode: "append",
        },
        undefined,
        summary.revision,
      );
      const applied = await apply();
      const mutation = await readDesignMutationResult(
        workspace.path,
        frame,
        applied.receipt.status === "applied",
      );
      if (applied.receipt.status === "applied") {
        host.recordDesignHistory(
          workspace.path,
          documentDesignHistoryEntry(frame),
        );
      }
      return {
        mutation,
        snapshot: await host.readDesignSnapshot(workspace, remote, {
          hostLocalResources,
          fresh: true,
          ...(params.snapshotMode === "scoped" ? { affectedFrames: [frame] } : {}),
        }),
        foundationRevision: {
          before: applied.receipt.beforeRevision,
          after: applied.receipt.afterRevision,
        },
      };
    }
    case "design.stage": {
      const workspaceId = reqStr(params, "workspaceId");
      const workspace = host.resolveDesignWorkspace(workspaceId, remote);
      // Stage is an explicit Git-index checkpoint, separate from Command-S
      // (`design.save`) and Commit. Take the same semantic document lane as
      // Design API writes so the index receives one exact durable snapshot.
      return withDesignWorkspaceMutation(workspace.path, async () => {
        const directoryId = optStr(params, "directoryId");
        if (directoryId)
          assertDesignReviewDirectory(workspace.path, directoryId);
        await assertGitCheckpointReady(workspace.path);
        await recoverPendingDesignTransaction(workspace.path);
        const designDir = designDirectoryNameFor(workspace.path);
        await stagePaths({
          workspaceId,
          paths: [
            designDir,
            ...(await designMetadataIndexPaths(workspace.path, designDir)),
          ],
          force: true,
        });
        await stageDesignRegistry(workspace.path, designDir);
        return { ok: true };
      });
    }
    case "design.unstage": {
      const workspaceId = reqStr(params, "workspaceId");
      const workspace = host.resolveDesignWorkspace(workspaceId, remote);
      return withDesignWorkspaceMutation(workspace.path, async () => {
        const directoryId = optStr(params, "directoryId");
        if (directoryId)
          assertDesignReviewDirectory(workspace.path, directoryId);
        await assertGitCheckpointReady(workspace.path);
        await unstagePaths({
          workspaceId,
          paths: [
            designDirectoryNameFor(workspace.path),
            ...(await designMetadataIndexPaths(
              workspace.path,
              designDirectoryNameFor(workspace.path),
              true,
            )),
          ],
        });
        await stageDesignRegistry(
          workspace.path,
          designDirectoryNameFor(workspace.path),
          true,
        );
        return { ok: true };
      });
    }
    case "design.save": {
      const workspace = host.resolveDesignWorkspace(
        reqStr(params, "workspaceId"),
        remote,
      );
      return withDesignWorkspaceMutation(workspace.path, async () => {
        const report = await lintDesignDocument(workspace.path, undefined, {
          healOids: false,
        });
        const errors = report.violations.filter(
          (violation) => violation.severity === "error",
        );
        if (errors.length > 0) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: `Fix ${errors.length} design ${errors.length === 1 ? "error" : "errors"} before saving: ${errors[0]!.ruleId}`,
            remediation: errors[0]!.message,
          });
        }
        // Design transactions are already crash-safe durable writes. "Save"
        // validates that live draft only; it never mutates the Git index,
        // creates a commit, or changes refs. Staging remains the separate
        // explicit `design.stage` action.
        return { ok: true };
      });
    }
    case "design.commit": {
      const workspaceId = reqStr(params, "workspaceId");
      const workspace = host.resolveDesignWorkspace(workspaceId, remote);
      return withDesignWorkspaceMutation(workspace.path, async () => {
        const directoryId = optStr(params, "directoryId");
        if (directoryId)
          assertDesignReviewDirectory(workspace.path, directoryId);
        // Commit validates the captured index. A later, invalid worktree draft
        // cannot invalidate a previously reviewed staged checkpoint.
        return commit({
          workspaceId,
          message: optStr(params, "message") ?? "Commit Design checkpoint",
          authority: "design",
          expectedIndexFingerprint: optStr(params, "indexFingerprint"),
        });
      });
    }
    // ── Design directory discovery (settings picker + adoption) ──
    // LOCAL-ONLY (off every remote allowlist). Lists every design folder in
    // a checkout, including untracked manifests and recognized legacy metadata,
    // plus the resolved pointer, so the repo settings picker can offer
    // "which folder is active" without guessing. Accepts a workspace id or
    // a known repo root (the settings page targets the main checkout).
    //
    // `target` previews the active folder without creating it. The Design tab
    // and legacy creation UI use this for explicit initialization. An invalid
    // configured pointer yields no target and must surface a recovery path.
    case "design.listDirectories": {
      const target = reqStr(params, "workspaceId");
      const cwd = host.resolveReadCwd(target, remote);
      if (remote) {
        throw new GitError({
          code: "REMOTE_RESTRICTED",
          message: "Design workspaces are available only in the desktop app.",
        });
      }
      const workspace = getWorkspaceById(target);
      const repoRoot = workspace?.repoRoot ?? cwd;
      const [directories, pointerState, sticky] = await Promise.all([
        discoverDesignDirectories(cwd),
        resolveDesignDirectoryPointerState(
          workspace
            ? { repoRoot, workspacePath: workspace.path }
            : { repoRoot },
        ),
        stickyRecognizedDesignDirectories(cwd),
      ]);
      const pointer = pointerState.directory;
      let entryTarget: { directory: string; exists: boolean } | null = null;
      try {
        const directory = await previewDesignDirectoryForEnter(
          { path: cwd, repoRoot },
          { strict: false, additionalRecognized: sticky },
        );
        entryTarget = {
          directory,
          // Code-agent admission may reserve an empty directory so a future
          // Design switch cannot race its sandbox boundary. That vnode is
          // not a Design document yet: only the canvas marker means the
          // requested "Create design directory" action has completed.
          exists: fs.existsSync(designDocumentMetadataPath(cwd, directory)),
        };
      } catch {
        entryTarget = null;
      }
      return {
        directories,
        directoryIds: Object.fromEntries(
          Object.entries(
            readDesignDirectoryRegistry(cwd)?.directories ?? {},
          ).map(([id, entry]) => [entry.path, id]),
        ),
        pointer,
        active: designDirectoryNameFor(cwd),
        target: entryTarget,
      };
    }

    case "design.previewExistingDirectory":
    case "design.adoptDirectory": {
      if (remote)
        throw new GitError({
          code: "REMOTE_RESTRICTED",
          message: "Design folders are managed in the desktop app.",
        });
      const repoRoot = reqStr(params, "repoRoot");
      if (!isKnownRepoRoot(repoRoot))
        throw new GitError({
          code: "WORKSPACE_NOT_FOUND",
          message: "Open this repository in Zeros first.",
        });
      const folder = reqStr(params, "folder");
      return op === "design.previewExistingDirectory"
        ? previewExistingDesignDirectory(repoRoot, folder)
        : adoptExistingDesignDirectory(
            repoRoot,
            folder,
            reqStr(params, "revision"),
            (id) => {
              // Registration must not invalidate inherited selections in older
              // worktrees. A later "Use this folder" goes through settings.write
              // and its complete live-territory transition once Git carries it.
              const preview = opSettingsPreviewWrite(
                "repo-local",
                { design: { directory: null, directory_id: id } },
                repoRoot,
              );
              return listWorkspaces({ archived: false })
                .filter(
                  (workspace) =>
                    personalRepoRoot(workspace.repoRoot) ===
                    personalRepoRoot(repoRoot),
                )
                .every((workspace) => {
                  try {
                    const projected = opSettingsResolveWithOverride(
                      workspace.path,
                      workspace.repoRoot,
                      preview,
                    );
                    const next =
                      designDirectoryFromSettings(
                        workspace.path,
                        projected.effective,
                      ) ?? DEFAULT_DESIGN_DIRECTORY_NAME;
                    return next === designDirectoryNameFor(workspace.path);
                  } catch {
                    return false;
                  }
                });
            },
          );
    }

    case "design.removeDirectory": {
      if (remote) {
        throw new GitError({
          code: "REMOTE_RESTRICTED",
          message: "Design folders are managed in the desktop app.",
        });
      }
      const repoRoot = reqStr(params, "repoRoot");
      if (!isKnownRepoRoot(repoRoot)) {
        throw new GitError({
          code: "WORKSPACE_NOT_FOUND",
          message: "Open this repository in Zeros first.",
        });
      }
      await removeDesignDirectory({
        repoRoot,
        directory: reqStr(params, "directory"),
      });
      return { removed: true };
    }

    // ── Design directory rename (repo settings → Design tab) ──
    // LOCAL-ONLY. Renames the folder in one commit in the MAIN checkout.
    // Stable directory IDs preserve other checkouts' selected documents;
    // legacy or incompatible live pointers must be upgraded first.
    case "design.renameDirectory": {
      if (remote) {
        throw new GitError({
          code: "REMOTE_RESTRICTED",
          message: "Design workspaces are available only in the desktop app.",
        });
      }
      const repoRoot = reqStr(params, "repoRoot");
      if (!isKnownRepoRoot(repoRoot)) {
        throw new GitError({
          code: "WORKSPACE_NOT_FOUND",
          message:
            "That repository isn't open in Zeros — open the folder first.",
        });
      }
      return renameDesignDirectory({
        repoRoot,
        from: reqStr(params, "from"),
        to: reqStr(params, "to"),
      });
    }

    default:
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "Unknown Design operation.",
      });
  }
}

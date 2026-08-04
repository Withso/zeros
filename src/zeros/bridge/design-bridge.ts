// Typed renderer bridge for the first-party design document operations.
//
// Kept separate from the already-large workspace bridge: transport and error
// semantics still go through its shared workspaceOp helper, while the design
// wire vocabulary remains cohesive and cheap for the design shell to import.

import type { RuntimeClient } from "./ws-client";
import { workspaceOp } from "./workspace-bridge";

export interface DesignFrameSummaryWire {
  file: string;
  title: string;
  width: number;
  height: number;
  x: number;
  y: number;
  z: number;
  nodeCount: number;
  modifiedAt: number;
}

export interface DesignFrameTreeNodeWire {
  tag: string;
  oid: string | null;
  text: string | null;
  children: DesignFrameTreeNodeWire[];
}

export interface DesignFrameDocumentWire extends DesignFrameSummaryWire {
  sourceVersion: string;
  source: string;
  srcDoc: string;
  tree: DesignFrameTreeNodeWire[];
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
  line: number;
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

export interface DesignAssetWire {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedAt: number;
  dataUrl: string | null;
}

export interface DesignWorkspaceSnapshotWire {
  /** Host-local resource authority. Null on remote/srcDoc renderers. */
  protocolCapability: string | null;
  frames: DesignFrameDocumentWire[];
  tokens: DesignTokenWire[];
  tokenSourceVersion: string;
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

export interface DesignMutationResultWire {
  changed: boolean;
  frame: DesignFrameDocumentWire;
  lint: DesignLintReportWire;
}

export interface DesignMutationReplyWire {
  mutation: DesignMutationResultWire;
  snapshot: DesignWorkspaceSnapshotWire;
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
  ruleId: "contrast" | "overflow" | "spacing-scale";
  message: string;
  oid: string;
  fix: string;
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
  const result = (await workspaceOp(bridge, "design.snapshot", {
    workspaceId,
  })) as { snapshot?: DesignWorkspaceSnapshotWire };
  if (
    !result?.snapshot ||
    !validProtocolCapability(result.snapshot) ||
    !Array.isArray(result.snapshot.frames) ||
    !Array.isArray(result.snapshot.tokens) ||
    !Array.isArray(result.snapshot.assets) ||
    typeof result.snapshot.tokenSourceVersion !== "string" ||
    !Array.isArray(result.snapshot.lint?.violations)
  ) {
    throw new Error("design.snapshot: malformed engine response");
  }
  return result.snapshot;
}

function designMutationReply(
  result: unknown,
  operation: string,
): DesignMutationReplyWire {
  const reply = result as Partial<DesignMutationReplyWire> | null;
  if (
    !reply?.mutation ||
    typeof reply.mutation.changed !== "boolean" ||
    typeof reply.mutation.frame?.file !== "string" ||
    !reply.snapshot ||
    !validProtocolCapability(reply.snapshot) ||
    !Array.isArray(reply.snapshot.frames) ||
    !Array.isArray(reply.snapshot.assets) ||
    typeof reply.snapshot.tokenSourceVersion !== "string"
  ) {
    throw new Error(`${operation}: malformed engine response`);
  }
  return reply as DesignMutationReplyWire;
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
    name: string;
    theme: string | null;
    value: string;
    sourceVersion: string;
  },
): Promise<{
  mutation: DesignTokenMutationWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  const result = (await workspaceOp(bridge, "design.token.update", {
    workspaceId,
    ...input,
  })) as {
    mutation?: DesignTokenMutationWire;
    snapshot?: DesignWorkspaceSnapshotWire;
  };
  if (
    !result.mutation ||
    typeof result.mutation.changed !== "boolean" ||
    !result.snapshot ||
    !validProtocolCapability(result.snapshot) ||
    !Array.isArray(result.snapshot.tokens) ||
    typeof result.snapshot.tokenSourceVersion !== "string"
  ) {
    throw new Error("design.token.update: malformed engine response");
  }
  return {
    mutation: result.mutation,
    snapshot: result.snapshot,
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

export async function bridgeDesignSetRuntimeAudit(
  bridge: RuntimeClient,
  workspaceId: string,
  input: {
    frame: string;
    sourceVersion: string;
    warnings: DesignRuntimeWarningWire[];
  },
): Promise<void> {
  await workspaceOp(bridge, "design.runtime.audit", {
    workspaceId,
    ...input,
  });
}

export async function bridgeDesignCreateFrame(
  bridge: RuntimeClient,
  workspaceId: string,
  title?: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  const result = (await workspaceOp(bridge, "design.frame.create", {
    workspaceId,
    ...(title ? { title } : {}),
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
}> {
  const result = (await workspaceOp(bridge, "design.canvas.update", {
    workspaceId,
    frame,
    ...geometry,
  })) as {
    geometry?: DesignFrameGeometryWire;
    snapshot?: DesignWorkspaceSnapshotWire;
  };
  if (
    !result?.geometry ||
    typeof result.geometry.x !== "number" ||
    !result.snapshot ||
    !validProtocolCapability(result.snapshot)
  ) {
    throw new Error("design.canvas.update: malformed engine response");
  }
  return { geometry: result.geometry, snapshot: result.snapshot };
}

export async function bridgeDesignDuplicateFrame(
  bridge: RuntimeClient,
  workspaceId: string,
  frame: string,
): Promise<{
  frame: DesignFrameSummaryWire;
  snapshot: DesignWorkspaceSnapshotWire;
}> {
  const result = (await workspaceOp(bridge, "design.frame.duplicate", {
    workspaceId,
    frame,
  })) as {
    frame?: DesignFrameSummaryWire;
    snapshot?: DesignWorkspaceSnapshotWire;
  };
  if (
    !result.frame ||
    !result.snapshot ||
    !validProtocolCapability(result.snapshot)
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
  })) as {
    deleted?: { file: string };
    snapshot?: DesignWorkspaceSnapshotWire;
  };
  if (
    !result.deleted ||
    !result.snapshot ||
    !validProtocolCapability(result.snapshot)
  ) {
    throw new Error("design.frame.delete: malformed engine response");
  }
  return { deleted: result.deleted, snapshot: result.snapshot };
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
    }),
    "design.asset.insert",
  );
}

export async function bridgeDesignSave(
  bridge: RuntimeClient,
  workspaceId: string,
  message?: string,
): Promise<{ sha: string; branch: string }> {
  return (await workspaceOp(bridge, "design.save", {
    workspaceId,
    ...(message ? { message } : {}),
  })) as { sha: string; branch: string };
}

import { DesignApi, type DesignHeadlessRenderer } from "@zeros/design-web";
import {
  DESIGN_CAPTURE_PNG_BYTES,
  DESIGN_CAPTURE_TIMEOUT_MS,
  designCaptureRasterSize,
  designPreviewRequestSchema,
  designWorkspaceCaptureSchema,
  type DesignPreviewReply,
} from "@zeros/protocol/design-capture";
import { createDesignCaptureRenderer } from "./capture-client";
import { DesignDraftStore, designDocumentIdForFrame } from "./design-api";
import { designDirectoryNameFor } from "./directory-registry";
import { designDirectoryEntry } from "./metadata";
import {
  assertDesignThemeName,
  readDesignFrameRenderIdentity,
  readDesignFrameSelectionIdentity,
} from "./document";

/** The largest canvas frame side (document-storage FRAME_MAX_SIZE). */
const DESIGN_FRAME_MAX_LAYOUT_SIDE = 16_384;

/** Called only inside the workspace's authorized Design-directory lease. */
export async function captureWorkspaceDesign(root: string, raw: unknown) {
  const input = designWorkspaceCaptureSchema.parse(raw);
  const renderer = createDesignCaptureRenderer(root);
  if (!renderer) throw new Error("No qualified Design capture host is available.");
  const api = new DesignApi(new DesignDraftStore(root), {
    authorization: { kind: "trusted-in-process" }, renderer, maxSessions: 1,
    maxSessionBytes: 32 * 1024 * 1024,
  });
  const artifact = await api.render({
    documentId: designDocumentIdForFrame(input.frame), expectedRevision: input.expectedRevision,
    viewport: { width: input.width, height: input.height, deviceScaleFactor: 1, reducedMotion: "reduce" },
    signal: AbortSignal.timeout(DESIGN_CAPTURE_TIMEOUT_MS + 1000),
  });
  if (artifact.revision !== input.expectedRevision || artifact.mimeType !== "image/png" ||
    artifact.bytes.byteLength > DESIGN_CAPTURE_PNG_BYTES)
    throw new Error("Capture does not match the requested Design revision or byte limit.");
  // Publish only the portable artifact; host metadata and capture credentials
  // are private implementation details, never part of a workspace response.
  return { revision: artifact.revision, mimeType: artifact.mimeType, width: artifact.width,
    height: artifact.height, data: Buffer.from(artifact.bytes).toString("base64") };
}

/** A canvas preview: the frame's saved source, laid out at its own canvas
 * size (so media queries and viewport units match the canvas) and rasterized
 * to fit `maxDimension`. Animations and transitions are still (the capture
 * hosts apply the static render stylesheet and reduced motion). A frame whose
 * source changed since the canvas asked, or while it rendered, answers
 * `stale` with the saved version. Reads only this frame, never the whole
 * directory. Called only inside the workspace's authorized Design-directory
 * lease. */
export async function previewWorkspaceDesign(
  root: string,
  raw: unknown,
  deps: { renderer?: DesignHeadlessRenderer; signal?: AbortSignal } = {},
): Promise<DesignPreviewReply> {
  const input = designPreviewRequestSchema.parse(raw);
  const signal = AbortSignal.any([...(deps.signal ? [deps.signal] : []), AbortSignal.timeout(DESIGN_CAPTURE_TIMEOUT_MS + 1000)]);
  signal.throwIfAborted();
  if (input.directoryId !== undefined &&
    designDirectoryEntry(root, designDirectoryNameFor(root))?.id !== input.directoryId)
    throw new Error("The active Design directory changed. Refresh before previewing.");
  const frame = await readDesignFrameSelectionIdentity(root, input.frame);
  signal.throwIfAborted();
  if (frame.sourceVersion !== input.sourceVersion)
    return { stale: true, sourceVersion: frame.sourceVersion };
  // Checked once here; the capture renderer is told not to repeat it. A
  // preview is background work: it yields a busy capture slot to explicit
  // captures, and the canvas asks again later.
  if (input.theme !== null) await assertDesignThemeName(root, input.theme);
  signal.throwIfAborted();
  const renderer = deps.renderer ??
    createDesignCaptureRenderer(root, undefined, undefined, { themeChecked: true, capacityRetry: false });
  if (!renderer) throw new Error("No qualified Design capture host is available.");
  // A render viewport is whole pixels; the canvas size may not be. The whole
  // frame is laid out (frames reach 16,384 px) and scaled into the raster.
  const viewport = {
    width: Math.max(1, Math.min(DESIGN_FRAME_MAX_LAYOUT_SIDE, Math.ceil(frame.width))),
    height: Math.max(1, Math.min(DESIGN_FRAME_MAX_LAYOUT_SIDE, Math.ceil(frame.height))),
  };
  const raster = designCaptureRasterSize(viewport, input.maxDimension);
  const scaled = raster.width !== viewport.width || raster.height !== viewport.height;
  const api = new DesignApi(new DesignDraftStore(root), {
    authorization: { kind: "trusted-in-process" }, renderer, maxSessions: 1,
    maxSessionBytes: 32 * 1024 * 1024,
  });
  const artifact = await api.render({
    documentId: designDocumentIdForFrame(frame.file),
    viewport: { ...viewport, deviceScaleFactor: 1, reducedMotion: "reduce" },
    ...(input.theme !== null ? { theme: input.theme } : {}),
    ...(scaled ? { rasterSize: { width: raster.width, height: raster.height } } : {}),
    signal,
  });
  signal.throwIfAborted();
  // A whole-pixel canvas size makes the artifact's own generation exact, so
  // it alone proves which source rendered. A fractional size changes the
  // generation's size part (and a renderer may report none); then the frame
  // is read again, and matching identities on both sides of the render prove
  // the source instead.
  const exact = viewport.width === frame.width && viewport.height === frame.height;
  const rendered = exact ? artifact.metadata?.sourceVersion : undefined;
  const settled = typeof rendered === "string"
    ? rendered
    : (await readDesignFrameRenderIdentity(root, frame.file)).sourceVersion;
  signal.throwIfAborted();
  if (settled !== input.sourceVersion) return { stale: true, sourceVersion: settled };
  if (artifact.mimeType !== "image/png" || artifact.bytes.byteLength > DESIGN_CAPTURE_PNG_BYTES)
    throw new Error("Preview does not match the requested Design frame or byte limit.");
  return {
    sourceVersion: input.sourceVersion, theme: input.theme, mimeType: "image/png",
    width: artifact.width, height: artifact.height,
    data: Buffer.from(artifact.bytes).toString("base64"),
  };
}

import { DesignApi } from "@zeros/design-web";
import { DESIGN_CAPTURE_PNG_BYTES, DESIGN_CAPTURE_TIMEOUT_MS, designWorkspaceCaptureSchema } from "@zeros/protocol/design-capture";
import { createDesignCaptureRenderer } from "./capture-client";
import { DesignDraftStore, designDocumentIdForFrame } from "./design-api";

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

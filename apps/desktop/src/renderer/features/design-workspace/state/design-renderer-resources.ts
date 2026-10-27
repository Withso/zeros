import { designDocumentReplacements } from "./design-document-replacements";
import { designImageResidency } from "./design-image-residency";
import { designResourceCounters } from "./design-resource-counters";
import { useDesignRuntimeStore } from "./design-runtime-store";
import { designFrameDocumentCache, designFoundationCache, designWorkspaceSnapshotCache, designFramePreparation } from "./design-workspace-cache";
import { designFramePreviews, designPreviewDecodes } from "./use-design-frame-previews";
import { designCaptureScheduler } from "../../../platform/bridge/design-capture-scheduler";
import { designHiddenDocuments } from "./design-hidden-documents";
import { designSourceSurfaceBudget } from "../design-source-surfaces";
import { designSourceLoadSlots, designSourceVectorBudget, designSourceVectorCache } from "../design-source-vector";
import { designSourceTiles } from "../design-source-tiles";
import { designSourceSceneUsage } from "../design-source-scene";

/** Explicit diagnostic read, with no subscriptions or recurring work. No
 * paths, source, images, workspace identity or credentials leave the stores. */
export function designRendererResources() {
  let documents = 0;
  let sourceBytes = 0;
  let composedBytes = 0;
  for (const key of designFrameDocumentCache.keys()) {
    const document = designFrameDocumentCache.peekSnapshot(key).data;
    if (!document) continue;
    documents++;
    sourceBytes += document.source.length * 2;
    composedBytes += document.srcDoc.length * 2;
  }
  let runtimeFrames = 0;
  let screenshots = 0;
  let screenshotEncodedBytes = 0;
  let screenshotGuardBytes = 0;
  for (const workspace of Object.values(useDesignRuntimeStore.getState().byWorkspace)) {
    runtimeFrames += Object.keys(workspace.frames).length;
    for (const frame of Object.values(workspace.frames)) {
      for (const screenshot of Object.values(frame.screenshotsByNode)) {
        screenshots++;
        screenshotEncodedBytes += screenshot.dataUrl.length * 2;
        screenshotGuardBytes += Math.max(screenshot.dataUrl.length * 2, screenshot.width * screenshot.height * 4);
      }
    }
  }
  return {
    counters: designResourceCounters(),
    captures: designCaptureScheduler.usage(),
    documents: designHiddenDocuments.usage(),
    preparation: designFramePreparation.usage(),
    sourceSurfaces: designSourceSurfaceBudget.usage(),
    sourceLoads: designSourceLoadSlots.usage(),
    sourceVectors: designSourceVectorBudget.usage(),
    sourceVectorCache: designSourceVectorCache.usage(),
    sourceTiles: { ...designSourceTiles.usage(), ...designSourceSceneUsage() },
    replacements: designDocumentReplacements.usage(),
    images: designImageResidency.usage(),
    previews: designFramePreviews.usage(),
    previewDecodes: designPreviewDecodes.usage(),
    source: { documents, sourceBytes, composedBytes,
      snapshots: designWorkspaceSnapshotCache.keys().length, foundations: designFoundationCache.keys().length },
    runtime: { frames: runtimeFrames, screenshots, screenshotEncodedBytes, screenshotGuardBytes },
  };
}

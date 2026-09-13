// Full frame hydration is a bounded fallback for hosts without the authenticated
// zeros-design: protocol, or for an individual frame whose protocol handshake
// fails. Healthy Electron canvases render directly from the protocol.

import { useCachedRead } from "../../../state/use-cached-read";
import {
  DESIGN_FRAME_DOCUMENT_MAX_AGE_MS,
  designFrameDocumentCache,
  designFrameDocumentKey,
  fetchDesignFrameDocument,
} from "./design-workspace-cache";

export function useDesignFrameDocument(
  workspaceId: string,
  frame: string,
  sourceVersion: string,
  enabled: boolean,
) {
  const key = designFrameDocumentKey(workspaceId, frame, sourceVersion);
  return useCachedRead(
    designFrameDocumentCache,
    enabled ? key : null,
    fetchDesignFrameDocument,
    { maxAgeMs: DESIGN_FRAME_DOCUMENT_MAX_AGE_MS, enabled },
  );
}

/// <reference lib="webworker" />
// Encodes Design frame pictures away from the canvas thread.

import { downscaleDesignPreview, encodeDesignPreview, type DesignPreviewEncodeReply, type DesignPreviewEncodeRequest } from "./design-preview-encoding";

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", async ({ data }: MessageEvent<DesignPreviewEncodeRequest>) => {
  let reply: DesignPreviewEncodeReply;
  try {
    const blob = data.op === "encode" ? await encodeDesignPreview(data.picture, data.level)
      : await downscaleDesignPreview(data.picture, data.width, data.height, data.level);
    reply = { id: data.id, blob };
  } catch (error) {
    reply = { id: data.id, error: error instanceof Error ? error.message : String(error) };
  }
  scope.postMessage(reply);
});

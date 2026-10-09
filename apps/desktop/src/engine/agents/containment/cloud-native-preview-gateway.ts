import {
  isCloudAgentPreviewTarget,
  type CloudAgentPreviewTarget,
} from "@zeros/protocol/containment";
import type {
  BoundaryPreviewGateway,
  BoundaryPreviewGatewayFactory,
  PreviewTarget,
} from "./preview-gateway";

/** v4 uses the authenticated runtime HTTP/HMR gateway. This factory publishes
 * only an opaque admission target; it neither exposes an application port nor
 * allocates a signed-link pool or another public listener. */
export class CloudNativePreviewGatewayFactory implements BoundaryPreviewGatewayFactory {
  async open(
    target: PreviewTarget,
    identity?: CloudAgentPreviewTarget,
  ): Promise<BoundaryPreviewGateway> {
    if (
      !isCloudAgentPreviewTarget(identity) ||
      !Number.isInteger(target.displayPort) ||
      target.displayPort < 1024 ||
      target.displayPort > 65535
    )
      throw new Error("native preview target is unavailable");
    const nativeTarget = { ...identity };
    const url = `http://localhost:${target.displayPort}/`;
    let closed = false;
    return {
      async navigation() {
        if (closed) throw new Error("native preview target is retired");
        return {
          url,
          admissionUrl: url,
          expiresAt: Date.now() + 60_000,
          nativeTarget,
        };
      },
      async close() {
        closed = true;
      },
    };
  }
}

import {
  designContextReferenceSchema,
  type DesignContextReference,
  type DesignContextInspection,
  type DesignCheckoutStatus,
  type DesignVerificationAccess,
} from "@zeros/protocol/design-context";
import type { RuntimeClient } from "./ws-client";
import { DESIGN_CAPTURE_TIMEOUT_MS } from "@zeros/protocol/design-capture";
import { workspaceOp } from "./workspace-bridge";

/** Context creation/inspection are reads; composer attachment delivery is a
 * separate consumer and cannot infer an editing mode from these references. */
export async function createDesignFrameContext(
  bridge: RuntimeClient,
  workspaceId: string,
  frame: string,
  nodeId?: string,
  expectedDirectoryId?: string,
): Promise<DesignContextReference> {
  const reply = (await workspaceOp(bridge, "design.context.create", {
    workspaceId,
    frame,
    ...(nodeId ? { nodeId } : {}),
    ...(expectedDirectoryId ? { expectedDirectoryId } : {}),
  })) as { reference: unknown };
  return designContextReferenceSchema.parse(reply.reference);
}

export async function openDesignFramePreview(bridge: RuntimeClient, workspaceId: string, directoryId: string, frame: string) {
  return await workspaceOp(bridge, "design.verification.open", { workspaceId, directoryId, frame }) as {
    reference: DesignContextReference; verification: DesignVerificationAccess; previewUrl: string;
  };
}

export async function captureDesignFrameContext(bridge: RuntimeClient, reference: DesignContextReference) {
  // Cover the render deadline and the engine's verification/transport budget.
  return await workspaceOp(bridge, "design.context.capture", { workspaceId: reference.workspaceId, reference }, DESIGN_CAPTURE_TIMEOUT_MS + 5_000) as {
    reference: DesignContextReference; mimeType: "image/png"; data: string;
  };
}

export async function inspectDesignFrameContext(
  bridge: RuntimeClient,
  reference: DesignContextReference,
): Promise<DesignContextInspection> {
  return (await workspaceOp(bridge, "design.context.inspect", {
    workspaceId: reference.workspaceId,
    reference: designContextReferenceSchema.parse(reference),
  })) as DesignContextInspection;
}

export async function readDesignCheckoutStatus(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<DesignCheckoutStatus> {
  return (await workspaceOp(bridge, "design.status", {
    workspaceId,
  })) as DesignCheckoutStatus;
}

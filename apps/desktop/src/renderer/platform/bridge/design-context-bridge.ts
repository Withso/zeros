import {
  designContextReferenceSchema,
  type DesignContextReference,
  type DesignContextInspection,
  type DesignCheckoutStatus,
} from "@zeros/protocol/design-context";
import type { RuntimeClient } from "./ws-client";
import { workspaceOp } from "./workspace-bridge";

/** Context creation/inspection are reads; composer attachment delivery is a
 * separate consumer and cannot infer an editing mode from these references. */
export async function createDesignFrameContext(
  bridge: RuntimeClient,
  workspaceId: string,
  frame: string,
  nodeId?: string,
): Promise<DesignContextReference> {
  const reply = (await workspaceOp(bridge, "design.context.create", {
    workspaceId,
    frame,
    ...(nodeId ? { nodeId } : {}),
  })) as { reference: unknown };
  return designContextReferenceSchema.parse(reply.reference);
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

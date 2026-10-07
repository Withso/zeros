import { randomUUID } from "node:crypto";

import type {
  ExecutionBoundaryRestriction,
  ExecutionBoundaryStatus,
} from "@zeros/protocol/containment";

import type { BoundaryRequest, TerritoryGeneration } from "./types";

export function newTerritoryGeneration(): TerritoryGeneration {
  return randomUUID() as TerritoryGeneration;
}

/** A PreparedBoundary can be a host process-lifecycle wrapper. Presence alone
 * therefore does not mean provider state is isolated or that nested Seatbelt
 * helpers are unavailable. Keep every provider feature gate on this semantic
 * test instead of `Boolean(executionBoundary)`. */
export function hasKernelExecutionBoundary(
  boundary:
    | {
        status?: Pick<ExecutionBoundaryStatus, "backend" | "state">;
      }
    | undefined,
): boolean {
  if (!boundary) return false;
  // Compatibility for direct adapter callers/tests created before status was
  // part of PreparedBoundary: ambiguity must retain the conservative nested-
  // sandbox behavior. Production host boundaries always publish `backend:none`.
  if (!boundary.status) return true;
  if (boundary.status.state !== "ready") return false;
  return (
    boundary.status.backend === "zeros-srt" ||
    boundary.status.backend === "cloud-worker" ||
    boundary.status.backend === "provider-native"
  );
}

export function boundaryParityRestrictions(
  request: Pick<BoundaryRequest, "containerWorkflowExpected">,
  capabilities: { containerWorkflowAvailable?: boolean } = {},
): ExecutionBoundaryRestriction[] {
  return [
    ...(request.containerWorkflowExpected &&
    !capabilities.containerWorkflowAvailable
      ? (["container-workflows-unavailable"] as const)
      : []),
  ];
}

import { randomUUID } from "node:crypto";

import {
  EXECUTION_BOUNDARY_STATUS_VERSION,
  type ExecutionBoundaryRestriction,
  type ExecutionBoundaryStatus,
} from "@zeros/protocol/containment";

import type { AgentFilesystemTerritory } from "../types";
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

/** Build the redacted status exposed to renderer/relay clients. No host path,
 * policy rule, token, or provider configuration crosses this diagnostic seam. */
export function readyBoundaryStatus(opts: {
  territory?: AgentFilesystemTerritory;
  generation?: TerritoryGeneration;
  backend?: "zeros-srt" | "cloud-worker";
  checkedAt?: number;
  restrictions?: readonly ExecutionBoundaryRestriction[];
}): ExecutionBoundaryStatus {
  const restrictions = [...new Set(opts.restrictions ?? [])];
  return {
    version: EXECUTION_BOUNDARY_STATUS_VERSION,
    actor: "agent-code",
    state: "ready",
    backend: opts.backend ?? "zeros-srt",
    designProtection: {
      required: Boolean(opts.territory),
      enforced: Boolean(opts.territory),
      protectedDirectoryCount:
        opts.territory?.protectedDesignDirectories.length ?? 0,
      ...(opts.territory && opts.generation
        ? { territoryGeneration: opts.generation }
        : {}),
    },
    parity: {
      level: restrictions.length === 0 ? "full" : "restricted",
      restrictions,
    },
    services: { state: "ready", activeCount: 0, kinds: [] },
    git: { state: "not-applicable" },
    checkedAt: opts.checkedAt ?? Date.now(),
  };
}

export function unavailableBoundaryStatus(opts: {
  remediation: string;
  checkedAt?: number;
}): ExecutionBoundaryStatus {
  return {
    version: EXECUTION_BOUNDARY_STATUS_VERSION,
    actor: "agent-code",
    state: "unavailable",
    backend: "none",
    designProtection: {
      required: true,
      enforced: false,
      protectedDirectoryCount: 0,
    },
    parity: { level: "restricted", restrictions: [] },
    checkedAt: opts.checkedAt ?? Date.now(),
    remediation: opts.remediation,
  };
}

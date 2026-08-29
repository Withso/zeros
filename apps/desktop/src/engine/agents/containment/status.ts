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

export function boundaryParityRestrictions(
  request: Pick<
    BoundaryRequest,
    "containerWorkflowExpected" | "containerWorker"
  >,
): ExecutionBoundaryRestriction[] {
  return [
    ...(request.containerWorkflowExpected && !request.containerWorker
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

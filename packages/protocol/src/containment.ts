// Renderers and relays receive diagnostics, not authority; policy and capability tokens stay in the engine.

export const EXECUTION_BOUNDARY_STATUS_VERSION = 1 as const;
export const EXECUTION_BOUNDARY_PORTS_VERSION = 1 as const;

export type ExecutionBoundaryActor =
  | "agent-code"
  | "repo-code-task"
  | "design-agent";

export type ExecutionBoundaryBackend =
  | "none"
  | "provider-native"
  | "zeros-srt";

export type ExecutionBoundaryState =
  | "not-required"
  | "ready"
  | "draining"
  | "revoked"
  | "unavailable";

/** Full provider parity requires an empty restrictions list. */
export type ExecutionBoundaryRestriction =
  | "additional-directories-disabled"
  | "local-mcp-disabled"
  | "plugins-disabled"
  | "provider-bypass-mode-disabled"
  | "shadow-git-unavailable"
  | "local-services-unavailable"
  | "container-workflows-unavailable";

export interface ExecutionBoundaryStatus {
  version: typeof EXECUTION_BOUNDARY_STATUS_VERSION;
  actor: ExecutionBoundaryActor;
  state: ExecutionBoundaryState;
  backend: ExecutionBoundaryBackend;
  designProtection: {
    required: boolean;
    enforced: boolean;
    /** Count only. Host paths are intentionally not sent over the bridge. */
    protectedDirectoryCount: number;
    /** Opaque, per-admission nonce. It contains no path or policy material. */
    territoryGeneration?: string;
  };
  parity: {
    level: "full" | "restricted";
    restrictions: ExecutionBoundaryRestriction[];
  };
  /** Only counts and categories cross the bridge, never endpoints, environment values or broker identities. */
  services?: ExecutionBoundaryServicesStatus;
  /** Retained for v1 ChangeSet compatibility; ref names, object IDs, paths and raw errors stay in the engine. */
  git?: ExecutionBoundaryGitStatus;
  /** Last authority-changing lifecycle transition for this exact execution. */
  lifecycle?: ExecutionBoundaryLifecycleStatus;
  /** Epoch milliseconds from the engine that performed the live probe. */
  checkedAt: number;
  /** End-user next step. Never contains credentials or raw policy text. */
  remediation?: string;
  /** Exact-execution terminal classification. This is internal routing state,
   * not a composer diagnostic surface. */
  failure?: "design-protection-failed";
}

export type ExecutionBoundaryServiceKind =
  | "database"
  | "docker"
  | "podman"
  | "nix"
  | "ssh-agent"
  | "gpg-agent"
  | "language-daemon"
  | "other";

export interface ExecutionBoundaryServicesStatus {
  state: "ready" | "revoked";
  activeCount: number;
  kinds: ExecutionBoundaryServiceKind[];
}

export type ExecutionBoundaryGitState =
  /** No repository is involved in this session at all. */
  | "not-applicable"
  /** Native commits are already in the workspace repo; present this differently from a non-Git workspace. */
  | "native"
  | "ready"
  | "synchronizing"
  | "clean"
  | "promoted"
  | "blocked"
  | "revoked";

export interface ExecutionBoundaryGitStatus {
  state: ExecutionBoundaryGitState;
  issue?: "promotion-conflict";
  updatedRefs?: number;
  indexUpdated?: boolean;
  changedAt?: number;
}

export interface ExecutionBoundaryLifecycleStatus {
  lastTransition: "territory-restart";
  transitionedAt: number;
}

/** Report stable issue categories only; raw listener and host diagnostics stay in the engine. */
export type ExecutionBoundaryPortDiscoveryState =
  | "idle"
  | "discovering"
  | "ready"
  | "degraded"
  | "revoked";

export type ExecutionBoundaryPortDiscoveryIssue =
  | "listener-inspection-failed"
  | "listener-capacity-exceeded"
  | "lease-allocation-failed"
  | "policy-update-failed";

/** Browser/UI-safe identity for one session-local listener. `id` is opaque and
 * scoped to the owning execution. Host addresses, namespace target ports,
 * generations, broker credentials, and policy material are never serialized. */
export interface ExecutionBoundaryPortStatus {
  id: string;
  protocol: "tcp";
  /** The port the program asked the user to open, after transparent mapping. */
  port: number;
  purpose: "dev-server" | "preview" | "debug" | "other";
  source: "requested" | "discovered";
}

export interface ExecutionBoundaryPortsSnapshot {
  version: typeof EXECUTION_BOUNDARY_PORTS_VERSION;
  discovery: {
    state: ExecutionBoundaryPortDiscoveryState;
    issue?: ExecutionBoundaryPortDiscoveryIssue;
  };
  ports: ExecutionBoundaryPortStatus[];
}

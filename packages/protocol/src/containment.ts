// ──────────────────────────────────────────────────────────
// Zeros execution-boundary wire contract
// ──────────────────────────────────────────────────────────
//
// This is deliberately diagnostic, not an authority grant. The engine owns
// the real policy and capability tokens; renderer/relay clients receive only
// enough redacted state to explain whether a code actor is ready and which
// compatibility paths are still restricted.

export const EXECUTION_BOUNDARY_STATUS_VERSION = 1 as const;
export const EXECUTION_BOUNDARY_PORTS_VERSION = 1 as const;

export type ExecutionBoundaryActor =
  | "agent-code"
  | "repo-code-task"
  | "design-agent";

export type ExecutionBoundaryBackend =
  | "none"
  | "provider-native"
  | "zeros-srt"
  | "cloud-worker";

export type ExecutionBoundaryState =
  | "not-required"
  | "ready"
  | "draining"
  | "revoked"
  | "unavailable";

/** Temporary compatibility differences are explicit and machine-readable.
 * A backend/provider cannot graduate while any restriction remains. */
export type ExecutionBoundaryRestriction =
  | "additional-directories-disabled"
  | "local-mcp-disabled"
  | "plugins-disabled"
  | "provider-bypass-mode-disabled"
  | "shadow-git-unavailable"
  | "local-services-unavailable"
  | "container-workflows-unavailable"
  /** Retained for v1 wire compatibility. Current ZSR sessions use native Git
   * plus a narrow trusted broker for whole-tree integrations. */
  | "additional-repository-git-read-only";

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
  /** Session-scoped service façades that were successfully established at
   * admission. Counts and stable categories only: endpoints, socket paths,
   * environment values, and broker identities never cross the bridge. */
  services?: ExecutionBoundaryServicesStatus;
  /** Status of the private ChangeSet and its validated promotion into the
   * canonical repository. Ref names, object ids, paths, and error text remain
   * engine-local. */
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
  /** The session uses the workspace's own repository directly, with no private
   * projection to promote. This is the local desktop contract: there is nothing
   * to synchronize because the agent's commits already landed in the real repo.
   * Distinct from `not-applicable` because the difference is user-visible — a
   * local session in a real Git repo must not be labelled "not a Git
   * workspace". */
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

/** Redacted listener-discovery health. Raw process, socket, policy, and host
 * diagnostics remain engine-local; clients receive only a stable category and
 * can offer a safe user action from it. */
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

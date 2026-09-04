import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type {
  ExecutionBoundaryActor,
  ExecutionBoundaryBackend,
  ExecutionBoundaryStatus,
} from "@zeros/protocol/containment";

import type { AgentFilesystemTerritory } from "../types";

/** Cancellation is not a containment failure: it means the owning UI/session
 * disappeared while preparation was still at a safe checkpoint. */
export class AdmissionCancelledError extends Error {
  constructor(message = "execution boundary admission was cancelled") {
    super(message);
    this.name = "AdmissionCancelledError";
  }
}

/** Opaque generation carried by every broker request. A prepared boundary
 * mints a fresh value even when the path set is unchanged, so credentials
 * captured from a retired process cannot be replayed after re-admission. */
export type TerritoryGeneration = string & {
  readonly __territoryGeneration: unique symbol;
};

export interface BoundaryRequest {
  executionId: string;
  actor: ExecutionBoundaryActor;
  /** Provider namespace for purpose-specific persistent state. */
  providerId?: string;
  /** Trusted provider path inputs used to report the effective host HOME.
   * This object is never copied wholesale into the child or persisted. */
  providerStateEnv?: Readonly<Record<string, string>>;
  cwd: string;
  workspaceRoot: string;
  territory?: AgentFilesystemTerritory;
  /** User-authorized roots from the equivalent normal workspace posture.
   * The policy builder subtracts protected authority after adding these. */
  additionalReadWriteRoots?: readonly string[];
  /** Explicit read-only context roots for this actor. */
  additionalReadOnlyRoots?: readonly string[];
  /** Git owners whose Design roots overlap this execution's authority. The
   * boundary uses this semantic map directly; it does not imply sparse
   * checkout, a projection, or an alternate execution backend. */
  codeTerritoryOwners?: readonly {
    workspaceRoot: string;
    protectedDesignDirectories: readonly string[];
  }[];
  /** Stable parent directories that contain Zeros-managed worktrees. Code
   * actors receive these as read-only collections, then reopen only their
   * current workspace and explicitly authorized islands. This protects a
   * sibling before its checkout or Design marker exists, so creating it does
   * not require rebuilding unrelated live boundaries. */
  protectedWorkspaceDirectories?: readonly string[];
  /** Existing managed workspaces covered by a broader user-authorized root.
   * These exact islands preserve `/add-dir` semantics without reopening future
   * siblings that were not present when this immutable boundary was admitted. */
  protectedWorkspaceWriteDirectories?: readonly string[];
  /** App-wide physical repository owners whose code territory a Design actor
   * must not write. Registered owners are deny-only: this never grants a
   * sibling checkout to a code actor or makes it an attached directory. */
  protectedCodeDirectories?: readonly string[];
  /** Canonical registered repository owners where a code actor may ask the
   * trusted engine to perform a tree-level Git integration. This never grants
   * a path-naming checkout/restore; those stay inside the actor fence. */
  gitIntegrationRoots?: readonly string[];
  /** Trusted loopback services intentionally projected to this execution
   * (for example the scoped Zeros MCP gateway). All other Zeros control ports
   * remain denied even when local binding is enabled for dev servers. */
  allowedLocalPorts?: readonly number[];
  /** Engine-minted, method-scoped loopback façades such as the dedicated MCP
   * gateway. Only these may carve a port out of Zeros' reserved control range. */
  trustedLocalPorts?: readonly number[];
  /** The equivalent normal workspace exposes a Docker/Podman CLI or endpoint.
   * Kernel-isolated boundaries report that workflow as unavailable rather
   * than silently pointing the CLI at an engine-owned VM or dead socket.
   * Lightweight host boundaries preserve the ambient workflow unchanged. */
  containerWorkflowExpected?: boolean;
  /** Canonical Git workspace owners nested in user-authorized writable roots
   * whose Design territory is part of this generation. Tree-level integrations
   * may use the trusted engine broker; path-level Git stays native. */
  additionalGitWorkspaceRoots?: readonly string[];
  backendHint?: ExecutionBoundaryBackend;
}

export interface BoundarySpawnRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  /** Complete child environment. Implementations must never ambient-merge. */
  env: Readonly<Record<string, string>>;
  stdio?: "pipe" | "inherit";
}

/** Trusted description used to prepare one repository-controlled command.
 * The manager resolves this before node-pty sees the command, so there is no
 * privileged pre-spawn shell in front of the boundary. */
export interface RepoTaskBoundaryRequest {
  executionId: string;
  cwd: string;
  workspaceRoot: string;
  repoRoot: string;
  /** Complete task environment, used to preserve normal task behavior and
   * describe capabilities to a qualified cloud boundary when applicable. */
  env?: Readonly<Record<string, string>>;
  /** PATH/login-shell discovery uses the normal actor environment but must not
   * provision local-service or container capabilities. */
  serviceCapabilities?: "full" | "none";
  /** Publish the exact authority snapshot before boundary preparation yields.
   * Lifecycle reconciliation uses it to distinguish a safe owner event that
   * preceded resolution from a mutation that made this admission stale. */
  onAuthorityResolved?: (snapshot: BoundaryAuthoritySnapshot) => void;
}

export type RepoTaskBoundaryFactory = (
  request: RepoTaskBoundaryRequest,
) => Promise<PreparedBoundary>;

export interface BoundaryTerritoryContributionSnapshot {
  readonly workspaceRoot: string;
  readonly grants: readonly string[];
  readonly full: boolean;
  /** Filesystem write/deny authority only. */
  readonly identity: string | null;
  /** Optional interactive-session context generation. Repository tasks do not
   * restart merely because protected committed bytes changed. */
  readonly contextIdentity?: string | null;
}

export interface BoundaryAuthoritySnapshot {
  readonly registeredDesignAuthorityIdentity: string | null;
  readonly territoryContributions: readonly BoundaryTerritoryContributionSnapshot[];
}

/** Synchronous spawn descriptor used by provider APIs (notably Claude's SDK)
 * whose custom-process callback cannot await. The selected actor boundary is
 * admitted before this point: a native lifecycle owner for Code, or an
 * installed kernel policy and supervisor for Design/cloud. */
export interface BoundaryLaunchSpec extends BoundarySpawnRequest {
  stdio: "pipe" | "inherit";
  /** Index of an argv value that a trusted intermediate launcher must replace
   * with its own PID immediately before spawn. Host-supervised PTYs use this
   * to bind lifecycle ownership to the Node PTY host instead of incorrectly
   * claiming that the engine is the supervisor's immediate parent. */
  immediateParentPidArgIndex?: number;
}

export interface BoundaryProcessExit {
  code: number | null;
  signal: NodeJS.Signals | string | null;
}

export interface BoundaryProcess {
  readonly pid: number;
  readonly child?: ChildProcess;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  wait(): Promise<BoundaryProcessExit>;
  signal(signal: NodeJS.Signals): Promise<void>;
  /** Terminate the complete supervised process domain and prove it is empty. */
  stopAndProve(): Promise<void>;
}

export interface PortRequest {
  protocol: "tcp" | "udp";
  /** Host/browser-facing port preference. Omit for an atomic random lease. */
  preferredPort?: number;
  /** Namespace-local listener when it intentionally differs from the exposed
   * host port. Defaults to the leased host port. */
  targetPort?: number;
  purpose: "dev-server" | "preview" | "debug" | "other";
}

export interface PortLease {
  readonly leaseId: string;
  readonly generation: TerritoryGeneration;
  readonly host: string;
  readonly port: number;
  readonly targetPort: number;
  revoke(): Promise<void>;
}

export interface PortMapping {
  readonly leaseId: string;
  readonly generation: TerritoryGeneration;
  readonly protocol: "tcp";
  readonly host: string;
  readonly port: number;
  readonly targetPort: number;
  /** Normal-workspace port shown to the user. On macOS an interposed explicit
   * bind such as 5173 may be backed by a generation-private random port. */
  readonly displayPort: number;
  readonly purpose: PortRequest["purpose"];
  readonly source: "requested" | "discovered";
}

export type PortDiscoveryState =
  | "idle"
  | "discovering"
  | "ready"
  | "degraded"
  | "revoked";

export type PortDiscoveryIssue =
  | "listener-inspection-failed"
  | "listener-capacity-exceeded"
  | "lease-allocation-failed"
  | "policy-update-failed";

export interface PortDiscoveryStatus {
  readonly state: PortDiscoveryState;
  readonly issue?: PortDiscoveryIssue;
}

export interface BoundaryProbeResult {
  backend: ExecutionBoundaryBackend;
  available: boolean;
  secureNestedIsolation: boolean;
  reasons: readonly string[];
}

/** Dedicated identity for a trusted Linux cloud worker. The root supervisor
 * may use privilege only while Bubblewrap constructs namespaces and mounts;
 * untrusted bytes must execute as this non-root uid/gid. */
export interface CloudWorkerIdentity {
  readonly uid: number;
  readonly gid: number;
}

export type CloudWorkerRuntimeConfiguration = CloudWorkerIdentity;

/** Root-controlled executables and scripts baked into a qualified cloud
 * image. These paths are deployment authority and therefore never come from
 * a sandbox create-time environment or writable checkout. */
export interface CloudWorkerToolchain {
  readonly node: string;
  readonly supervisor: string;
  readonly bwrap: string;
  readonly setpriv: string;
}

export interface PreparedBoundary {
  readonly generation: TerritoryGeneration;
  /** Behavioral proof for this exact actor boundary. Native Code resolves its
   * lifecycle proof directly. For ZSR, the kernel policy is installed before
   * `prepare()` returns and a live canary may finish in the background;
   * rejection revokes and proves the exact process tree stopped. */
  readonly attestation: Promise<void>;
  readonly status: ExecutionBoundaryStatus;
  /** Cwd-independent identity of the registered Design write subtraction used
   * by Setup/Run repository tasks. Ordinary agent boundaries may omit it. */
  readonly registeredDesignAuthorityIdentity?: string | null;
  /** Per-owner slices reopened by this boundary. Managed sibling collections
   * are stable deny regions, so only these explicitly writable slices need to
   * participate in pointer-change invalidation. */
  readonly territoryContributions?: readonly BoundaryTerritoryContributionSnapshot[];
  /** The effective HOME this session's provider actually runs with — the same
   * path the boundary injects as `HOME` at spawn. Local desktop host-parity
   * and cloud host-parity boundaries both return the deployment's real HOME. */
  readonly providerHomePath?: string;
  wrapSpawn(request: BoundarySpawnRequest): BoundaryLaunchSpec;
  trackProcess(child: ChildProcess): BoundaryProcess;
  /** Adopt a PTY/supervisor process group spawned by the shared Node PTY host.
   * The asynchronous host protocol reports the pid after create() returns. */
  trackProcessGroup(
    pid: number,
    options?: {
      /** True only after the PTY host observed the original group leader exit.
       * Before that event the freshly spawned PID is still an exact ownership
       * token even if macOS policy installation has not become observable. */
      readonly leaderExited?: () => boolean;
    },
  ): BoundaryProcess;
  spawn(request: BoundarySpawnRequest): Promise<BoundaryProcess>;
  requestPort(request: PortRequest): Promise<PortLease>;
  /** Current redacted browser-facing mappings. No token, path, or raw policy
   * material crosses this diagnostic seam. */
  activePorts(): readonly PortMapping[];
  /** Categorized discovery health. Raw errors are deliberately unavailable to
   * renderer/relay callers. */
  portDiscoveryStatus(): PortDiscoveryStatus;
  onPortsChanged(listener: (ports: readonly PortMapping[]) => void): () => void;
  revoke(): Promise<void>;
  /** Resolve only after every descendant is dead and every lease is revoked. */
  stopAndProve(): Promise<void>;
}

export interface ExecutionBoundary {
  readonly backend: ExecutionBoundaryBackend;
  /** Boot-time recovery runs before the engine publishes any local authority.
   * Implementations must fail closed when a prior process domain cannot be
   * proven empty. */
  recoverStaleProcesses?(): Promise<ExecutionBoundaryRecoveryResult>;
  /** Recover mutable Git/provider state only after stale process domains are
   * retired. Keeping this separate makes the boot ordering explicit and
   * preserves compatibility with older session-state recovery. */
  recoverStaleMutableState?(): Promise<ExecutionBoundaryRecoveryResult>;
  probe(request: BoundaryRequest): Promise<BoundaryProbeResult>;
  prepare(
    request: BoundaryRequest,
    control?: AdmissionControl,
  ): Promise<PreparedBoundary>;
  /** Clear retained diagnostics for one generation after a retried teardown
   * proved it stopped. Retirement failures are execution-scoped and must not
   * become a process-wide admission latch. */
  clearRetirementFailure?(generation: TerritoryGeneration): void;
}

/** Out-of-band scheduling control for one admission. Deliberately NOT part of
 * BoundaryRequest: the request is plain serializable data (the utility pool
 * hashes it for reuse keys), while this carries a live handle. */
export interface AdmissionControl {
  /** Checked between acquisitions. A cancellation after preparation starts
   * unwinds through the same proven cleanup path as an admission error. */
  readonly signal?: AbortSignal;
  /** `blocking` is the conservative default for Run, Setup, utilities, and
   * pre-warmed boundaries. Interactive agent create/resume may use
   * `background`; a ZSR kernel policy is still established before return while
   * its live behavioral canary completes concurrently. */
  readonly attestation?: "blocking" | "background";
}

export interface ExecutionBoundaryRecoveryResult {
  readonly discovered: number;
  readonly recovered: number;
  readonly active: number;
  readonly preserved: number;
}

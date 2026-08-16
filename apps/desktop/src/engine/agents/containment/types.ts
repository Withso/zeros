import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type {
  ExecutionBoundaryActor,
  ExecutionBoundaryBackend,
  ExecutionBoundaryStatus,
} from "@zeros/protocol/containment";

import type { AgentFilesystemTerritory } from "../types";
import type { ShadowGitPromotionResult } from "./shadow-git";

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
  /** Trusted provider discovery inputs captured before HOME is virtualized.
   * Only HOME/XDG/provider config path variables belong here; this object is
   * never copied wholesale into the child or persisted. */
  providerStateEnv?: Readonly<Record<string, string>>;
  cwd: string;
  workspaceRoot: string;
  territory?: AgentFilesystemTerritory;
  /** User-authorized roots from the equivalent normal workspace posture.
   * The policy builder subtracts protected authority after adding these. */
  additionalReadWriteRoots?: readonly string[];
  /** Read-only toolchain/configuration roots required by the normal workspace
   * baseline. This becomes material when Linux must hide the ambient root to
   * admit a private Unix façade. */
  additionalReadOnlyRoots?: readonly string[];
  /** Trusted loopback services intentionally projected to this execution
   * (for example the scoped Zeros MCP gateway). All other Zeros control ports
   * remain denied even when local binding is enabled for dev servers. */
  allowedLocalPorts?: readonly number[];
  /** Engine-minted, method-scoped loopback façades such as the dedicated MCP
   * gateway. Only these may carve a port out of Zeros' reserved control range. */
  trustedLocalPorts?: readonly number[];
  /** Trusted, exact host endpoints that may be leased after admission. Their
   * random façade ports are the only endpoints exposed to the child. */
  localServices?: readonly LocalServiceCapability[];
  /** Optional generation-private OCI engine. It runs as an unprivileged
   * sibling inside the same ZSR namespaces, never as a host-daemon tunnel. */
  containerWorker?: ContainerWorkerRequest;
  /** Safe redacted reason a discovered private backend could not be admitted.
   * This refines remediation while the stable parity restriction remains
   * `container-workflows-unavailable`. */
  containerWorkerUnavailableReason?:
    | "insufficient-disk-space"
    | "private-runtime-unavailable";
  /** The equivalent normal workspace exposes a Docker/Podman CLI or endpoint.
   * If no private worker can satisfy it, diagnostics must report a parity
   * restriction instead of silently pointing that CLI at a dead socket. */
  containerWorkflowExpected?: boolean;
  /** Canonical Git workspace owners nested in user-authorized writable roots
   * whose Design territory is part of this generation. Each receives its own
   * private shadow repository and broker; raw canonical metadata stays absent. */
  additionalGitWorkspaceRoots?: readonly string[];
  backendHint?: ExecutionBoundaryBackend;
}

export interface EmbeddedContainerWorkerRequest {
  readonly runtime: "podman";
  readonly backend: "embedded-linux";
  /** Absolute executable available in the equivalent normal-workspace PATH. */
  readonly executable: string;
}

export interface OrbStackContainerWorkerRequest {
  readonly runtime: "podman";
  readonly backend: "orbstack-machine";
  /** Absolute, physical OrbStack CLI selected by the trusted Mac engine. */
  readonly executable: string;
}

export type ContainerWorkerRequest =
  | EmbeddedContainerWorkerRequest
  | OrbStackContainerWorkerRequest;

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
  /** Complete task environment, used only to discover exact local services and
   * read-only toolchain roots before HOME/network isolation is compiled. */
  env?: Readonly<Record<string, string>>;
}

export type RepoTaskBoundaryFactory = (
  request: RepoTaskBoundaryRequest,
) => Promise<PreparedBoundary>;

/** Synchronous spawn descriptor used by provider APIs (notably Claude's SDK)
 * whose custom-process callback cannot await. Policy preparation and the live
 * canary happen before this point; wrapping only writes an engine-private,
 * mode-0600 argv descriptor and returns the already-qualified supervisor. */
export interface BoundaryLaunchSpec extends BoundarySpawnRequest {
  stdio: "pipe" | "inherit";
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

export type LocalServiceKind =
  | "database"
  | "docker"
  | "podman"
  | "nix"
  | "ssh-agent"
  | "gpg-agent"
  | "language-daemon"
  | "other";

export type LocalTcpServiceAdapter =
  | "environment-only"
  | "generic"
  | "postgres"
  | "mysql"
  | "redis"
  | "docker-tcp"
  | "podman-tcp";

export type LocalUnixServiceAdapter =
  | "environment-only"
  | "generic-unix"
  | "docker-unix"
  | "podman-unix"
  | "ssh-agent"
  | "gpg-agent"
  | "nix-daemon";

export interface LocalTcpServiceCapability {
  serviceId: string;
  kind: LocalServiceKind;
  transport: "tcp";
  /** Exact loopback family; never a wildcard or hostname subject to DNS. */
  targetHost: "127.0.0.1" | "::1";
  targetPort: number;
  adapter: LocalTcpServiceAdapter;
  /** Trusted environment templates applied only while leased. `{host}` and
   * `{port}` resolve to the façade, never the raw host endpoint. */
  environment?: Readonly<Record<string, string>>;
}

export interface LocalUnixServiceCapability {
  serviceId: string;
  kind: LocalServiceKind;
  transport: "unix";
  /** Exact physical host socket selected by trusted admission. The broker
   * snapshots its device/inode and refuses a later pathname replacement. */
  targetPath: string;
  adapter: LocalUnixServiceAdapter;
  /** Canonical host GnuPG home used only by the trusted broker to snapshot
   * public key/configuration state. Required for `gpg-agent`; forbidden for
   * other adapters. Private keys, revocation certificates, and host sockets
   * are never projected. */
  sourceHome?: string;
  /** Trusted templates may use `{host}`, `{port}`, and `{socket}`. Docker and
   * Podman intentionally receive TCP façades; SSH/Nix receive a private Unix
   * façade because their protocols require a pathname socket. */
  environment?: Readonly<Record<string, string>>;
}

export type LocalServiceCapability =
  | LocalTcpServiceCapability
  | LocalUnixServiceCapability;

export interface ServiceRequest {
  kind: LocalServiceKind;
  serviceId: string;
}

export interface ServiceLease {
  readonly leaseId: string;
  readonly generation: TerritoryGeneration;
  /** Boundary-private connection metadata, never a raw host control socket. */
  readonly env: Readonly<Record<string, string>>;
  revoke(): Promise<void>;
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

export interface CloudWorkerRuntimeConfiguration extends CloudWorkerIdentity {
  /** Root-controlled delegated cgroup-v2 parent. Each execution receives a
   * distinct child scope before any untrusted byte starts. */
  readonly cgroupParent: string;
  readonly resources: CloudWorkerResourceLimits;
}

export interface CloudWorkerResourceLimits {
  readonly memoryBytes: number;
  readonly cpuQuotaMicros: number;
  readonly cpuPeriodMicros: number;
  readonly processes: number;
}

/** Root-controlled executables and scripts baked into a qualified cloud
 * image. These paths are deployment authority and therefore never come from
 * a sandbox create-time environment or writable checkout. */
export interface CloudWorkerToolchain {
  readonly node: string;
  readonly supervisor: string;
  readonly networkBridge: string;
  readonly containerWorker: string;
  readonly bwrap: string;
  readonly socat: string;
  readonly setpriv: string;
}

export interface PreparedBoundary {
  readonly generation: TerritoryGeneration;
  readonly status: ExecutionBoundaryStatus;
  /** Writable state capability scoped to this provider + canonical workspace.
   * The returned root persists across execution generations; no sibling
   * provider or engine control path is exposed. */
  privateStateDirectory(namespace: string): string;
  wrapSpawn(request: BoundarySpawnRequest): BoundaryLaunchSpec;
  trackProcess(child: ChildProcess): BoundaryProcess;
  /** Adopt a PTY/supervisor process group spawned by the shared Node PTY host.
   * The asynchronous host protocol reports the pid after create() returns. */
  trackProcessGroup(pid: number): BoundaryProcess;
  spawn(request: BoundarySpawnRequest): Promise<BoundaryProcess>;
  requestPort(request: PortRequest): Promise<PortLease>;
  /** Current redacted browser-facing mappings. No token, path, or raw policy
   * material crosses this diagnostic seam. */
  activePorts(): readonly PortMapping[];
  /** Categorized discovery health. Raw errors are deliberately unavailable to
   * renderer/relay callers. */
  portDiscoveryStatus(): PortDiscoveryStatus;
  onPortsChanged(listener: (ports: readonly PortMapping[]) => void): () => void;
  requestLocalService(request: ServiceRequest): Promise<ServiceLease>;
  /** Validate and CAS-promote the session's private Git refs/index. This is a
   * no-op for non-Git folders. */
  synchronizeGit(): Promise<ShadowGitPromotionResult>;
  revoke(): Promise<void>;
  /** Resolve only after every descendant is dead and every lease is revoked. */
  stopAndProve(): Promise<void>;
}

export interface ExecutionBoundary {
  readonly backend: ExecutionBoundaryBackend;
  /** Boot-time recovery runs before the engine publishes any local authority.
   * Implementations must fail closed when a prior process domain cannot be
   * proven empty. */
  recoverStaleProcesses?(): Promise<{
    readonly discovered: number;
    readonly recovered: number;
    readonly active: number;
    readonly preserved: number;
  }>;
  probe(request: BoundaryRequest): Promise<BoundaryProbeResult>;
  prepare(request: BoundaryRequest): Promise<PreparedBoundary>;
}

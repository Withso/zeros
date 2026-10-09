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
import { CloudBrowserCapabilitySchema, type CloudBrowserCapability, type CloudNativeCapabilities, type CloudWorkerRuntimeProfile } from "./cloud-agent-execution";

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

/** Compatibility differences are explicit and machine-readable. Full native
 * provider parity cannot graduate while any restriction remains. */
export type ExecutionBoundaryRestriction =
  | "additional-directories-disabled"
  | "local-mcp-disabled"
  | "plugins-disabled"
  | "provider-bypass-mode-disabled"
  | "shadow-git-unavailable"
  | "local-services-unavailable"
  | "container-workflows-unavailable"
  | "user-mcp-disabled"
  | "mcp-oauth-unavailable"
  | "cursor-team-settings-unavailable"
  | "provider-native-extensions-restricted"
  | "native-session-fork-disabled"
  /** Retained for archived v1 wire compatibility. New cloud processes share
   * the engine identity; this value never asserts a new filesystem boundary. */
  | "additional-repository-git-read-only";

export const CLOUD_CORE_EXECUTION_PROFILE = "zeros-cloud-core-v1" as const;
export const CLOUD_NATIVE_EXECUTION_PROFILE = "zeros-cloud-native-v1" as const;
export type CloudCoreProvider = "claude" | "cursor" | "codex";
export type { CloudBrowserCapability } from "./cloud-agent-execution";

/** Stage 0: no currently shipped cloud runtime has a native browser binding.
 * This diagnostic neither changes v1 profile exclusions nor grants authority. */
export function cloudBrowserUnavailable(
  provider: CloudCoreProvider,
  credentialKind: CloudBrowserCapability["credentialKind"] = "unknown",
  reason: Extract<CloudBrowserCapability, { state: "unavailable" }>["reason"] =
    provider === "codex" ? "codex-runtime-unavailable" : provider === "claude" ? "claude-direct-login-required" : "provider-unsupported",
  runtimeProfile: CloudWorkerRuntimeProfile = "zeros-cloud-worker-v3",
): CloudBrowserCapability {
  return { version: 1, provider, runtimeProfile, credentialKind, state: "unavailable", reason };
}

/** Rolling upgrades: old/malformed diagnostics are unavailable. Only an exact
 * provider/runtime/credential report can describe disabled or qualified ready.
 * Consumers must still use separately admitted execution authority. */
export function resolveCloudBrowserCapability(
  provider: CloudCoreProvider,
  reported: unknown,
  credentialKind?: CloudBrowserCapability["credentialKind"],
): CloudBrowserCapability {
  const parsed = CloudBrowserCapabilitySchema.safeParse(reported);
  if (!parsed.success) return cloudBrowserUnavailable(provider, credentialKind, "not-reported");
  if (parsed.data.provider !== provider || (credentialKind !== undefined && parsed.data.credentialKind !== credentialKind))
    return cloudBrowserUnavailable(provider, credentialKind, "scope-mismatch");
  return parsed.data;
}
/** Versioned compatibility manifest, not a tool qualification or authority
 * grant. Changing these exclusions requires a new core profile. The detailed
 * native extension exclusions live in the cloud agent-tool contract. */
export const CLOUD_CORE_PROVIDER_RESTRICTIONS: Readonly<Record<CloudCoreProvider, readonly ExecutionBoundaryRestriction[]>> = {
  claude: ["additional-directories-disabled", "native-session-fork-disabled", "plugins-disabled", "provider-native-extensions-restricted", "user-mcp-disabled"],
  cursor: ["additional-directories-disabled", "native-session-fork-disabled", "provider-native-extensions-restricted", "user-mcp-disabled"],
  codex: ["additional-directories-disabled", "native-session-fork-disabled", "provider-native-extensions-restricted", "user-mcp-disabled"],
};
/** Native provider tools run against the real VM workspace. Account settings
 * and history remain scoped to the organization execution; host attachment
 * and conversation-fork workflows require their own cloud admission. */
export const CLOUD_NATIVE_PROVIDER_RESTRICTIONS: Readonly<Record<CloudCoreProvider, readonly ExecutionBoundaryRestriction[]>> = {
  claude: ["additional-directories-disabled", "mcp-oauth-unavailable", "native-session-fork-disabled", "plugins-disabled", "provider-native-extensions-restricted"],
  cursor: ["additional-directories-disabled", "cursor-team-settings-unavailable", "mcp-oauth-unavailable", "native-session-fork-disabled", "provider-native-extensions-restricted"],
  codex: ["additional-directories-disabled", "mcp-oauth-unavailable", "native-session-fork-disabled", "provider-native-extensions-restricted"],
};
/** Defaults describe an older/basic qualification. Feature support is reported
 * only after exact-image and credential-kind evidence admits it. Claude and
 * Cursor use explicit transcript handoff; neither claims a native binding fork. */
export function cloudNativeProviderRestrictions(provider: CloudCoreProvider, capabilities?: CloudNativeCapabilities | null): ExecutionBoundaryRestriction[] {
  return CLOUD_NATIVE_PROVIDER_RESTRICTIONS[provider].filter(restriction =>
    !(provider === "codex" && capabilities?.nativeFork && restriction === "native-session-fork-disabled"));
}

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
  /** Installed execution contract minted after private coordinator admission.
   * This does not certify tools or replace immutable runtime qualification.
   * Design API admission is distinct from filesystem Design protection. */
  cloudExecution?: {
    version: 1;
    profile: typeof CLOUD_CORE_EXECUTION_PROFILE | typeof CLOUD_NATIVE_EXECUTION_PROFILE;
    runtimeProfile: CloudWorkerRuntimeProfile;
    provider: CloudCoreProvider;
    capabilities?: CloudNativeCapabilities;
    designApi: "admitted" | "unavailable";
  };
  /** Optional additive diagnostic for cloud sessions. Older engines omit it;
   * newer clients must render unavailable, even when the agent itself is ready.
   * Local browser defaults and native qualification v1 are unchanged. */
  browser?: CloudBrowserCapability;
  /** Session-scoped service façades that were successfully established at
   * admission. Counts and stable categories only: endpoints, socket paths,
   * environment values, and broker identities never cross the bridge. */
  services?: ExecutionBoundaryServicesStatus;
  /** Legacy private-ChangeSet status retained for v1 wire compatibility.
   * Current native Code and API-only Design paths do not publish a ChangeSet;
   * ref names, object ids, paths, and error text remain engine-local. */
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

/** Redacted target for native HTTP/HMR admission. Only the trusted engine can
 * resolve these identities into listener coordinates; display ports are UI
 * metadata and never select the agent application's socket. */
export interface CloudAgentPreviewTarget {
  executionId: string;
  portId: string;
}

export function isCloudAgentPreviewTarget(value: unknown): value is CloudAgentPreviewTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return Object.keys(target).length === 2 &&
    typeof target.executionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(target.executionId) &&
    typeof target.portId === "string" && /^[A-Za-z0-9_-]{32}$/.test(target.portId);
}

export interface ExecutionBoundaryPortsSnapshot {
  version: typeof EXECUTION_BOUNDARY_PORTS_VERSION;
  discovery: {
    state: ExecutionBoundaryPortDiscoveryState;
    issue?: ExecutionBoundaryPortDiscoveryIssue;
  };
  ports: ExecutionBoundaryPortStatus[];
}

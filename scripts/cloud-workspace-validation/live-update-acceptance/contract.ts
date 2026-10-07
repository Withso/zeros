/** Proposed LU/HU test adapter boundary. No provider adapter ships here.
 * Implementations must use Alpha staff endpoints, honor AbortSignal, keep
 * credentials on private channels and emit no raw diagnostics. */
export type Operation = { version: 1; operationId: string; name: string };
export type Workspace = { organizationId: string; workspaceId: string };
export const TEST_NAME_PREFIXES = ["zeros-v2-test-lu", "zeros-v2-test-hu"] as const;
export type TestNamePrefix = typeof TEST_NAME_PREFIXES[number];
export type Identity = {
  version: 1; channel: "alpha"; staff: true; organizationId: string;
};
export type Preflight = Identity & {
  sourceRuntimeId: string; targetRuntimeId: string;
  capabilities: {
    residentHandoff: boolean; freshProofs: boolean; rollbackPair: boolean;
    heldTurn: boolean; inputAcknowledgements: boolean; healthFailureInjection: boolean;
    idempotentCreateAndCleanup: boolean;
  };
};
export type Observation = Workspace & {
  engine: { instanceId: string; generation: number; runtimeId: string;
    authorityEpoch: number; proofId: string; residentFence: number; hostId: string;
    allocationId: string; bootId: string; controllerRuntimeId: string; hostRuntimeId: string };
  workload: { terminalPid: number; serverPid: number; serverCounter: number; fileDigest: string;
    /** Extract only these synthetic markers from the actual terminal replay. */
    inputs: Array<{ operationId: string; applications: number }> };
  turn: { operationId: string; state: "running" | "completed"; executions: number; runtimeId: string };
  commands: Array<{ operationId: string; commandId: string; state: "queued" | "running" | "completed";
    starts: number; completions: number; runtimeId: string | null }>;
};
export interface Device {
  /** A dedicated synthetic shell, detached HTTP server, sentinel file and
   * ordinary provider turn held at a test gate. Never touch user resources. */
  startWorkload(input: { operationId: string; terminalId: string }, signal: AbortSignal): Promise<void>;
  /** Start a second ordinary provider turn at the same test gate. The supplied
   * identity is already journaled; retries must not launch duplicate turns. */
  holdTurn(operationId: string, signal: AbortSignal): Promise<void>;
  /** Authenticated round trip to the actual engine; identities/proof IDs must
   * come from server-verified enrollment, never desired state or cached UI. */
  observe(signal: AbortSignal): Promise<Observation>;
  /** Retry the same durable input identity across reconnect, exactly once. */
  input(operationId: string, signal: AbortSignal): Promise<{ operationId: string; applications: number }>;
  enqueue(operationId: string, signal: AbortSignal): Promise<{ commandId: string }>;
  releaseTurn(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface AlphaLiveUpdateAdapter {
  /** Read-only staff/org authority, independent of runtime qualification, so
   * cleanup remains available after an exact-pair qualification is revoked. */
  identity(signal: AbortSignal): Promise<Identity>;
  /** Read-only; must verify exact runtime-pair qualifications before creation. */
  preflight(signal: AbortSignal): Promise<Preflight>;
  /** Same operation ID must recover a lost reply, never create a second VM. */
  provision(operation: Operation, sourceRuntimeId: string, signal: AbortSignal): Promise<Workspace>;
  connect(workspace: Workspace, device: "a" | "b", signal: AbortSignal): Promise<Device>;
  stage(workspace: Workspace, targetRuntimeId: string, signal: AbortSignal): Promise<void>;
  /** Resolve only after server-verified target health or completed rollback.
   * Inject failure only into this named test workspace's candidate health. */
  handoff(input: { workspace: Workspace; operationId: string; targetRuntimeId: string; failTargetHealth: boolean },
    signal: AbortSignal): Promise<"updated" | "rolled_back">;
  /** Resolve the operation even if provision never returned. Delete and verify
   * all generations, allocations, snapshots/objects and pending deletion rows.
   * Retry idempotently; do not report complete from a DELETE acknowledgement. */
  cleanup(operation: Operation, signal: AbortSignal): Promise<{ complete: boolean; remainingResources: number }>;
}
export type Journal = Operation & { workspace?: Workspace;
  /** Preflight scope is durable before provision; older journals may instead
   * recover it from workspace. Never guess the org for an unscoped journal. */
  organizationId?: string;
  /** Retry IDs are absent only in journals from the earlier runner. */
  actions?: { input: string; prompt: string; update: string; rollback: string;
    retryTurn?: string; retryPrompt?: string };
  phase: "allocated" | "created" | "cleanup_required" | "cleaned" };
export type Report = { version: 1; operationId: string; workspaceId?: string;
  outcome: "passed" | "failed" | "blocked" | "cleanup_required"; code: string;
  updateGapMs?: number; rollbackGapMs?: number; cleaned: boolean };

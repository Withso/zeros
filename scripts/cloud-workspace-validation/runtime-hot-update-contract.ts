/** Slice-5 composition contract. Types only: the live runner is not enabled by
 * importing this module. HU owns lifecycle/cleanup; LU supplies workload probes. */
export interface RuntimeHotUpdateAcceptanceIdentity {
  organizationId: string;
  workspaceId: string;
  providerResourceId: string;
  bootId: string;
  generation: number;
  engineInstanceId: string;
  runtimeId: string;
  resumeProofEpoch: string;
}

/** HU supplies two independently admitted, reconnecting devices using the
 * CONNECTED-first protocol. No provider/client credentials are exposed here. */
export interface RuntimeHotUpdateAcceptanceDevice {
  readonly id: "first" | "second";
  request(message: Readonly<Record<string, unknown>>): Promise<unknown>;
  subscribe(listener: (message: Readonly<Record<string, unknown>>) => void): () => void;
}

export interface RuntimeHotUpdateAcceptanceContext {
  readonly source: Readonly<RuntimeHotUpdateAcceptanceIdentity>;
  readonly devices: readonly [RuntimeHotUpdateAcceptanceDevice, RuntimeHotUpdateAcceptanceDevice];
  readonly signal: AbortSignal;
  /** Register immediately, including during partially completed preparation.
   * Cleanup executes in reverse order before HU removes the disposable VM. */
  addCleanup(cleanup: () => Promise<void>): void;
}

export interface RuntimeHotUpdateAcceptanceEvidence {
  transitionId: string;
  outcome: "healthy" | "rolled_back";
  active: RuntimeHotUpdateAcceptanceIdentity;
  /** Measured by HU on one monotonic clock, through normal client admission,
   * ordered snapshot replay and a successful read from the enrolled engine. */
  reconnect: readonly {
    deviceId: RuntimeHotUpdateAcceptanceDevice["id"];
    lastSourceResponseAtMs: number;
    firstReplacementResponseAtMs: number;
    gapMs: number;
    probeIntervalMs: number;
  }[];
}

export interface RuntimeHotUpdateAcceptanceHooks<State> {
  /** Create PTYs/dev servers and capture baseline identities before activation.
   * Event subscriptions stay live throughout the swap; State is never logged. */
  prepare(context: RuntimeHotUpdateAcceptanceContext): Promise<State>;
  verify(context: RuntimeHotUpdateAcceptanceContext, state: State,
    evidence: RuntimeHotUpdateAcceptanceEvidence): Promise<void>;
}

export interface RuntimeHotUpdateAcceptanceOptions {
  envFile?: string;
  sourceRuntimeId: string;
  targetRuntimeId: string;
  path: "bootstrap-quiet" | "engine-quiet" | "engine-resident";
  scenario: "healthy" | "target-health-failure";
  outputDirectory: string;
}

export interface RuntimeHotUpdateAcceptanceResult {
  status: "passed" | "failed" | "cleanup_required";
  evidence: RuntimeHotUpdateAcceptanceEvidence | null;
  /** Closed codes and owned resource IDs only; no raw hook errors or output. */
  failure: "setup" | "activation" | "verification" | "cleanup" | null;
  resources: readonly { kind: "workspace" | "allocation" | "object"; id: string; cleanedUp: boolean }[];
}

export type RuntimeHotUpdateAcceptanceRunner = <State>(
  options: RuntimeHotUpdateAcceptanceOptions,
  hooks: RuntimeHotUpdateAcceptanceHooks<State>,
) => Promise<RuntimeHotUpdateAcceptanceResult>;

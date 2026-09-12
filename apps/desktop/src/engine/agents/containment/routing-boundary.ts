import type {
  AdmissionControl,
  BoundaryProbeResult,
  BoundaryRequest,
  ExecutionBoundary,
  ExecutionBoundaryRecoveryResult,
  PreparedBoundary,
  TerritoryGeneration,
} from "./types";

const EMPTY_RECOVERY: ExecutionBoundaryRecoveryResult = {
  discovered: 0,
  recovered: 0,
  active: 0,
  preserved: 0,
};
export interface RoutingExecutionBoundaryOptions {
  host: ExecutionBoundary;
  sandbox: ExecutionBoundary;
  /** Cloud images retain their qualified worker boundary regardless of a
   * desktop preference accidentally couriered into the environment. */
  forceSandbox?: boolean;
}

/** Chooses execution posture per request. The router itself advertises
 * `backend: none` because a static hint must never make providers assume every
 * future process is kernel-contained; each PreparedBoundary carries the exact
 * redacted status used by capability gates. */
export class RoutingExecutionBoundary implements ExecutionBoundary {
  readonly backend: ExecutionBoundary["backend"];

  constructor(private readonly options: RoutingExecutionBoundaryOptions) {
    this.backend = options.forceSandbox ? options.sandbox.backend : "none";
  }

  private async select(request: BoundaryRequest): Promise<ExecutionBoundary> {
    if (this.options.forceSandbox) return this.options.sandbox;
    // Local routing is actor-scoped, never workspace-shape-scoped. A damaged
    // or absent Design identity is repaired/reported by its owning subsystem;
    // it must not silently change the provider execution backend.
    // Conversely, a Design agent never falls back to the unrestricted host.
    if (request.actor === "design-agent") return this.options.sandbox;
    return this.options.host;
  }

  async recoverStaleProcesses(): Promise<ExecutionBoundaryRecoveryResult> {
    // Always drain both generations before local authority is published. A
    // user may switch in either direction after a crash: the legacy sandbox
    // may own a kernel process domain, while the native path may own an
    // unrestricted provider group. Attempt both even if one recovery fails so
    // independent stale authority is not needlessly left behind.
    const recoveries = await Promise.allSettled([
      this.options.host.recoverStaleProcesses?.() ??
        Promise.resolve(EMPTY_RECOVERY),
      this.options.sandbox.recoverStaleProcesses?.() ??
        Promise.resolve(EMPTY_RECOVERY),
    ]);
    const failures = recoveries.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "execution-boundary process recovery failed",
      );
    }
    return recoveries.reduce<ExecutionBoundaryRecoveryResult>(
      (total, result) => {
        if (result.status !== "fulfilled") return total;
        return {
          discovered: total.discovered + result.value.discovered,
          recovered: total.recovered + result.value.recovered,
          active: total.active + result.value.active,
          preserved: total.preserved + result.value.preserved,
        };
      },
      { ...EMPTY_RECOVERY },
    );
  }

  async recoverStaleMutableState(): Promise<ExecutionBoundaryRecoveryResult> {
    return (
      (await this.options.sandbox.recoverStaleMutableState?.()) ??
      EMPTY_RECOVERY
    );
  }

  async probe(request: BoundaryRequest): Promise<BoundaryProbeResult> {
    return (await this.select(request)).probe(request);
  }

  async prepare(
    request: BoundaryRequest,
    control?: AdmissionControl,
  ): Promise<PreparedBoundary> {
    return (await this.select(request)).prepare(request, control);
  }

  clearRetirementFailure(generation: TerritoryGeneration): void {
    this.options.host.clearRetirementFailure?.(generation);
    this.options.sandbox.clearRetirementFailure?.(generation);
  }
}

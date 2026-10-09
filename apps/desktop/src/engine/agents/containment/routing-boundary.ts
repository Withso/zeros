import type {
  AdmissionControl,
  BoundaryProbeResult,
  BoundaryRequest,
  ExecutionBoundary,
  ExecutionBoundaryRecoveryResult,
  PreparedBoundary,
  TerritoryGeneration,
} from "./types";
import { isCloudExecutionBoundary } from "./cloud-execution-boundary";
import { recoverLegacyExecutionProcesses, recoverLegacyMutableState } from "./legacy-execution-recovery";

const EMPTY_RECOVERY: ExecutionBoundaryRecoveryResult = {
  discovered: 0,
  recovered: 0,
  active: 0,
  preserved: 0,
};
export interface RoutingExecutionBoundaryOptions {
  host: ExecutionBoundary;
  /** Only an original cloud boundary selects cloud placement. */
  cloud?: ExecutionBoundary;
}

/** Chooses execution posture per request. The router itself advertises
 * `backend: none` because a static hint must never make providers assume every
 * future process is kernel-contained; each PreparedBoundary carries the exact
 * redacted status used by capability gates. */
export class RoutingExecutionBoundary implements ExecutionBoundary {
  readonly backend: ExecutionBoundary["backend"];
  private readonly failedPreparationOwners = new Map<string, ExecutionBoundary>();

  constructor(private readonly options: RoutingExecutionBoundaryOptions) {
    if (options.cloud && !isCloudExecutionBoundary(options.cloud))
      throw new Error("cloud routing requires the original cloud execution boundary");
    this.backend = options.cloud?.backend ?? "none";
  }

  private async select(_request: BoundaryRequest): Promise<ExecutionBoundary> {
    return this.options.cloud ?? this.options.host;
  }

  async recoverStaleProcesses(): Promise<ExecutionBoundaryRecoveryResult> {
    // Retain ambiguous old holds without invoking their removed helper.
    // Attempt independent Host recovery even when a legacy hold rejects.
    const recoveries = await Promise.allSettled([
      (this.options.cloud ?? this.options.host).recoverStaleProcesses?.() ??
        Promise.resolve(EMPTY_RECOVERY),
      recoverLegacyExecutionProcesses(),
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
    return recoverLegacyMutableState();
  }

  async probe(request: BoundaryRequest): Promise<BoundaryProbeResult> {
    return (await this.select(request)).probe(request);
  }

  async prepare(
    request: BoundaryRequest,
    control?: AdmissionControl,
  ): Promise<PreparedBoundary> {
    if (this.failedPreparationOwners.has(request.executionId)) {
      throw new Error("The prior preparation for this execution needs cleanup proof before readmission.");
    }
    const selected = await this.select(request);
    try {
      return await selected.prepare(request, control);
    } catch (error) {
      if (control?.retainFailedPreparationProof) this.failedPreparationOwners.set(request.executionId, selected);
      throw error;
    }
  }

  async proveFailedPreparationStopped(executionId: string): Promise<void> {
    const owner = this.failedPreparationOwners.get(executionId);
    if (!owner?.proveFailedPreparationStopped) {
      throw new Error("No exact rejected preparation cleanup proof is available.");
    }
    await owner.proveFailedPreparationStopped(executionId);
    if (this.failedPreparationOwners.get(executionId) === owner) {
      this.failedPreparationOwners.delete(executionId);
    }
  }

  clearRetirementFailure(generation: TerritoryGeneration): void {
    this.options.host.clearRetirementFailure?.(generation);
    this.options.cloud?.clearRetirementFailure?.(generation);
  }
}

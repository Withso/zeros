import { CloudOwnedWorkloadRegistry, assertCloudOwnedScopeLive, isCloudOwnedWorkloadRegistry,
  type CloudWorkloadKind, type CloudWorkloadRole } from "./cloud-owned-workloads";
import { isCloudWorkerConfiguration, type CloudWorkerConfiguration } from "./cloud-worker-config";
import { cloudWorkloadCustodyConfiguration } from "./cloud-workload-custody";
import { HostExecutionBoundary } from "./host-boundary";
import type { AdmissionControl, BoundaryRequest, ExecutionBoundary, PreparedBoundary } from "./types";

const originalBoundaries = new WeakSet<object>(), originalPrepared = new WeakSet<object>();
const originalRequests = new WeakMap<object, Readonly<Pick<BoundaryRequest, "executionId" | "cwd" | "workspaceRoot">>>();
export function cloudPreparedBoundaryRequest(boundary: PreparedBoundary) {
  const request = originalRequests.get(boundary);
  if (!request) throw new Error("cloud workload request requires its original boundary");
  return request;
}
export function isCloudExecutionBoundary(value: unknown): value is CloudExecutionBoundary {
  return typeof value === "object" && value !== null && originalBoundaries.has(value);
}
export function isCloudPreparedBoundary(value: unknown): value is PreparedBoundary {
  return typeof value === "object" && value !== null && originalPrepared.has(value);
}
export function assertCloudPreparedBoundaryLive(boundary: PreparedBoundary): void {
  if (!isCloudPreparedBoundary(boundary)) throw new Error("cloud execution requires its original prepared boundary");
  assertCloudOwnedScopeLive(boundary);
}
/** Cloud placement with Host-owned lifecycle. No in-VM agent sandbox. */
export class CloudExecutionBoundary implements ExecutionBoundary {
  readonly backend = "cloud-worker" as const;
  private readonly host: HostExecutionBoundary;
  readonly workloads: CloudOwnedWorkloadRegistry;
  constructor(options: { projectRoot?: string; configuration: CloudWorkerConfiguration; workloads: CloudOwnedWorkloadRegistry }) {
    if (!isCloudWorkerConfiguration(options.configuration) || !isCloudOwnedWorkloadRegistry(options.workloads) ||
      !options.workloads.custody || cloudWorkloadCustodyConfiguration(options.workloads.custody) !== options.configuration ||
      options.configuration.uid !== process.geteuid?.() || options.configuration.gid !== process.getegid?.())
      throw new Error("cloud execution requires the original engine deployment and workload registry");
    this.workloads = options.workloads;
    this.host = new HostExecutionBoundary({ projectRoot: options.projectRoot,
      supervisorRuntime: options.configuration.toolchain.node, supervisorScript: options.configuration.toolchain.supervisor,
      cloudWorkloadCustody: this.workloads.custody! });
    originalBoundaries.add(this);
  }
  async probe(request: BoundaryRequest) { return { ...await this.host.probe(request), backend: this.backend }; }
  prepare(request: BoundaryRequest, control?: AdmissionControl): Promise<PreparedBoundary> {
    return this.prepareOwned(request, { ...control, kind: request.actor === "repo-code-task" ? "repo-task" : "agent", role: "workload" });
  }
  async prepareOwned(request: BoundaryRequest, control: AdmissionControl & { kind: CloudWorkloadKind; role: CloudWorkloadRole; terminalIdle?: () => unknown }): Promise<PreparedBoundary> {
    if (control.role === "infrastructure" && control.kind !== "language-service" && control.kind !== "service")
      throw new Error("interactive cloud processes cannot be infrastructure");
    const prepared = await this.workloads.prepare(this.host, request, control, control);
    originalPrepared.add(prepared);
    originalRequests.set(prepared, Object.freeze({ executionId: request.executionId, cwd: request.cwd, workspaceRoot: request.workspaceRoot }));
    return prepared;
  }
  recoverStaleProcesses() { return this.host.recoverStaleProcesses(); }
  recoverStaleMutableState() { return this.host.recoverStaleMutableState(); }
  proveFailedPreparationStopped(executionId: string) { return this.workloads.proveFailedPreparationStopped(this.host, executionId); }
}

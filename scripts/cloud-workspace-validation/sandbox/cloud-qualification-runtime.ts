import assert from "node:assert/strict";
import { CloudExecutionBoundary } from "../../../apps/desktop/src/engine/agents/containment/cloud-execution-boundary";
import { CloudOwnedWorkloadRegistry } from "../../../apps/desktop/src/engine/agents/containment/cloud-owned-workloads";
import { loadCloudWorkerConfiguration } from "../../../apps/desktop/src/engine/agents/containment/cloud-worker-config";
import { createCloudWorkloadCustody } from "../../../apps/desktop/src/engine/agents/containment/cloud-workload-custody";
import { disposePtyHost } from "../../../apps/desktop/src/engine/pty/pty-host-client";

/** Run role checks in the root-projected engine controller. Role children
 * launch through its original prepared boundary, never mint controller births. */
export function createCloudQualificationRuntime() {
  const configuration = loadCloudWorkerConfiguration();
  assert(configuration && configuration.uid === 10003 && configuration.gid === 10003);
  const custody = createCloudWorkloadCustody(configuration);
  custody.assertLive();
  const workloads = new CloudOwnedWorkloadRegistry({ custody });
  const boundary = new CloudExecutionBoundary({ projectRoot: "/srv/zeros/workspace", configuration, workloads });
  // Role probes lazily start the engine's process-global PTY transport. The
  // engine ends it in stop(); this controller ends it after its final census.
  return Object.freeze({ configuration, custody, workloads, boundary, close: () => disposePtyHost() });
}
export type CloudQualificationRuntime = ReturnType<typeof createCloudQualificationRuntime>;

/** Unknown custody remains busy; original controller infrastructure may stay
 * alive while role workloads and pending original launches are observed. */
export async function inspectCloudQualificationWorkloads(context: CloudQualificationRuntime) {
  context.custody.assertLive();
  const inspection = await context.workloads.inspect();
  assert(inspection.complete && !inspection.failedRetirements);
  assert(Number.isSafeInteger(inspection.pendingLaunches) && inspection.pendingLaunches >= 0);
  assert(inspection.workloadPids.every(pid => Number.isSafeInteger(pid) && pid > 1 && pid <= 2147483647));
  context.custody.assertLive();
  return { pendingLaunches: inspection.pendingLaunches, workloadPids: [...inspection.workloadPids] };
}

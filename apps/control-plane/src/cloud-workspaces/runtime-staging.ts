import type pg from "pg";
import type { Config } from "../config.js";
import { workerPollingOptions } from "../worker-polling-config.js";
import { BoatApiClient } from "./boat-client.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";
import { DatabaseRuntimeStagingStore } from "./runtime-staging-store.js";
import { CloudRuntimeStagingWorker, type RuntimeStagingTransitions } from "./runtime-staging-worker.js";
import { runRuntimeUpdate, type RuntimeUpdateHandlers } from "./runtime-update-runner.js";

export function cloudRuntimeStagingEnabled(input: {
  deploymentChannel: string; enabled: boolean; provider: string; hosted: boolean; artifacts: boolean;
}): boolean {
  return input.deploymentChannel === "alpha" && input.enabled && input.provider === "boat" && input.hosted && input.artifacts;
}

// Stage/restore conversations cannot acquire a prepare session or enrollment
// grant. Only the explicit restoration check below can authorize any frame.
const denyActivation: RuntimeUpdateHandlers = {
  authorize: async () => false, authorizeRollback: async () => false,
  enroll: async () => null, health: async () => false,
};

export function createCloudRuntimeStagingWorker(config: Config, pool: pg.Pool, artifacts: RuntimeArtifactStore | null,
  transitions: RuntimeStagingTransitions): CloudRuntimeStagingWorker | null {
  const cloud = config.cloudWorkspaces;
  if (!cloudRuntimeStagingEnabled({ deploymentChannel: config.deploymentChannel,
    enabled: cloud?.runtime?.stagingEnabled === true, provider: cloud?.provider ?? "",
    hosted: !!cloud?.boat, artifacts: artifacts !== null })) return null;
  const client = new BoatApiClient({ apiKey: cloud!.apiKey, billingOrg: cloud!.boat!.billingOrg, timeoutMs: 45_000 });
  const store = new DatabaseRuntimeStagingStore({ pool, qualificationMode: cloud!.runtime!.qualificationMode,
    workosEnabled: config.auth.provider === "workos" });
  return new CloudRuntimeStagingWorker({
    ...workerPollingOptions(config.workerPollIntervalsMs, "runtimeStaging"),
    store,
    transitions, artifacts: artifacts!,
    run: (resourceId, input, signal, claim) => runRuntimeUpdate(resourceId, input, { ...denyActivation,
      authorizeRestore: async () => {
        if (signal.aborted || !input.restore) return false;
        const plan = await store.read(claim);
        return !signal.aborted && !!plan && plan.resourceId === resourceId && plan.input.restore?.retentionId === input.restore.retentionId &&
          plan.input.restore.deadline === input.restore.deadline && plan.input.restore.installerReceiptSha256 === input.restore.installerReceiptSha256 &&
          JSON.stringify(plan.input.source) === JSON.stringify(input.source) && JSON.stringify(plan.input.scope) === JSON.stringify(input.scope) &&
          Date.parse(input.expiresAt) <= plan.deadline;
      },
    }, { client, maxOutputBytes: 512 * 1024 }, signal),
  });
}

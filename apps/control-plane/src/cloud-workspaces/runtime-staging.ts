import type pg from "pg";
import type { Config } from "../config.js";
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

// Stage conversations have no callback frames. Deny every activation callback
// anyway: this factory cannot acquire a prepare session or enrollment grant.
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
  return new CloudRuntimeStagingWorker({
    store: new DatabaseRuntimeStagingStore({ pool, qualificationMode: cloud!.runtime!.qualificationMode,
      workosEnabled: config.auth.provider === "workos" }),
    transitions, artifacts: artifacts!,
    run: (resourceId, input, signal) => runRuntimeUpdate(resourceId, input, denyActivation, { client, maxOutputBytes: 512 * 1024 }, signal),
  });
}

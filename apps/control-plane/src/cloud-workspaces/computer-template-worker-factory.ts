import type pg from "pg";
import type { Config } from "../config.js";
import { BoatApiClient } from "./boat-client.js";
import { createComputerTemplateBoatAdapters } from "./computer-template-boat.js";
import { sanitizeComputerTemplateLog } from "./computer-template-logs.js";
import { ComputerTemplateWorker, type ComputerTemplateWorkerDependencies } from "./computer-template-worker.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";

/** Construction performs no provider I/O. The entrypoint owns start/stop and
 * the maintenance, migration and background-worker role guards. */
export function createComputerTemplateWorker(
  config: Config,
  pool: pg.Pool,
  artifacts: RuntimeArtifactStore | null,
  github: ComputerTemplateWorkerDependencies["github"],
  service?: DatabaseCloudComputerV2Service,
): ComputerTemplateWorker | null {
  const cloud = config.cloudWorkspaces;
  if (config.deploymentChannel !== "alpha" || cloud?.provider !== "boat" || !cloud.boat || !artifacts) return null;
  const { accountScope, billingOrg } = cloud.boat;
  return new ComputerTemplateWorker({
    pool,
    service: service ?? new DatabaseCloudComputerV2Service(pool, cloud, { sanitizeLog: sanitizeComputerTemplateLog }),
    ...createComputerTemplateBoatAdapters({
      pool,
      client: new BoatApiClient({ apiKey: cloud.apiKey, billingOrg, timeoutMs: 45_000 }),
      accountScope,
      billingOrg,
      qualificationMode: cloud.runtime?.qualificationMode ?? "full",
    }),
    github,
    artifacts,
    accountScope,
    billingOrg,
    maxConcurrentBuilds: cloud.computerMaxConcurrentBuilds ?? 2,
  });
}

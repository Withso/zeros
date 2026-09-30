import { WorkerIdentity, requireCheck, type PromotionConfig } from "./contracts";
import { createProviders } from "./providers";

export const WORKER_TUPLE_KEYS = ["CLOUD_WORKSPACE_PROVIDER", "BOAT_SNAPSHOT_ID", "BOAT_IMAGE_BUILD_SHA256", "ZEROS_CLOUD_SOURCE_COMMIT",
  "ZEROS_CLOUD_IMAGE_ARCHITECTURE", "CLOUD_WORKSPACE_STORAGE_MIB"] as const;
export function workerIdentityAdapter(config: PromotionConfig, env: NodeJS.ProcessEnv, providers = createProviders(config, env)) {
  const target = { projectId: config.projectId, environmentId: config.environmentId, serviceId: config.serviceId };
  const read = async () => {
    const response = await providers.railway(`query WorkerReceiptIdentity($projectId:String!,$environmentId:String!,$serviceId:String!) {
      variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)
    }`, target);
    requireCheck(response.variables?.ZEROS_DEPLOY_ENV === config.channel, "Worker Railway target does not belong to this channel");
    return Object.fromEntries(WORKER_TUPLE_KEYS.map(key => [key, response.variables?.[key]]));
  };
  return async (variables: Record<string, string>) => {
    requireCheck(Object.keys(variables).length === WORKER_TUPLE_KEYS.length && WORKER_TUPLE_KEYS.every(key => Object.hasOwn(variables, key)), "Worker identity update requires the complete tuple");
    const identity = WorkerIdentity.safeParse({ provider: variables.CLOUD_WORKSPACE_PROVIDER,
      imageRef: `boat:${variables.BOAT_SNAPSHOT_ID}@sha256:${variables.BOAT_IMAGE_BUILD_SHA256}`, sourceSha: variables.ZEROS_CLOUD_SOURCE_COMMIT,
      architecture: variables.ZEROS_CLOUD_IMAGE_ARCHITECTURE, storageMiB: Number(variables.CLOUD_WORKSPACE_STORAGE_MIB) });
    requireCheck(WORKER_TUPLE_KEYS.every(key => typeof variables[key] === "string") && identity.success && identity.data.provider === "boat" &&
      identity.data.sourceSha === config.sourceSha && identity.data.architecture === "linux/amd64" && Number.isSafeInteger(identity.data.storageMiB) &&
      String(identity.data.storageMiB) === variables.CLOUD_WORKSPACE_STORAGE_MIB, "Worker tuple must describe this exact committed Boat image");
    const matches = (value: Record<string, unknown>) => WORKER_TUPLE_KEYS.every(key => value[key] === variables[key]);
    if (matches(await read())) return;
    try { await providers.updateWorkerIdentity(variables); }
    catch { requireCheck(matches(await read()), "Worker tuple mutation was reconciled but is not confirmed; no receipt is authorized"); }
    requireCheck(matches(await read()), "Worker complete tuple final readback mismatch");
  };
}

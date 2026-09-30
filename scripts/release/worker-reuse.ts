import { ReleaseIdentity, requireCheck, type Channel } from "./contracts";
import { workerInputsSha256 } from "./source";

export async function reusableWorker(config: { channel: Channel; sourceSha: string; cloudRequired: boolean; provider?: string }, value: unknown, hash = workerInputsSha256) {
  const parsed = ReleaseIdentity.safeParse(value);
  requireCheck(parsed.success && parsed.data.channel === config.channel, "Current channel readiness is unavailable; complete the first-rollout worker ceremony");
  const identity = parsed.data;
  if (!identity.cloud.enabled && !config.cloudRequired) return undefined;
  requireCheck(identity.cloud.enabled && identity.cloud.state === "healthy" && identity.worker && identity.worker.provider === config.provider &&
    (!config.cloudRequired || identity.workerQualified === true), "Cloud worker qualification or identity is unavailable");
  requireCheck(await hash(identity.worker.sourceSha) === await hash(config.sourceSha), "Worker inputs changed; complete cloud-worker-promotion before hosted promotion");
  return identity.worker;
}

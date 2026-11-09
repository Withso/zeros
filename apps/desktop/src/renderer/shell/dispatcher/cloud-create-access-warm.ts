import { warmCloudV2RepositoryAccess } from "../../platform/cloud-v2";

/** The control plane reuses a GitHub verification for 30 s and renews one in
 * its last 15 s, so one warm per 10 s of intent keeps the selected repository
 * fresh for the create request. */
export const CLOUD_CREATE_ACCESS_WARM_MS = 10_000;
const MAX_KEYS = 32;
const warmed = new Map<string, number>();

/** Fire-and-forget: errors only mean the create checks access itself. */
export function warmCloudCreateAccess(
  organizationId: string | null | undefined,
  repository: string | null | undefined,
  now = Date.now(),
  send: typeof warmCloudV2RepositoryAccess = warmCloudV2RepositoryAccess,
): void {
  if (!organizationId || !repository) return;
  const key = JSON.stringify([organizationId, repository.toLowerCase()]);
  const previous = warmed.get(key);
  if (previous !== undefined && now >= previous && now - previous < CLOUD_CREATE_ACCESS_WARM_MS) return;
  warmed.delete(key);
  warmed.set(key, now);
  if (warmed.size > MAX_KEYS) warmed.delete(warmed.keys().next().value!);
  void send(organizationId, repository).catch(() => {});
}

export function forgetCloudCreateAccessWarmth(): void {
  warmed.clear();
}

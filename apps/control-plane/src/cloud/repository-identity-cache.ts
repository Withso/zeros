import type { CloudV2ComputerSourceResolver } from "./computer-provenance.js";
import type { CloudSourceTarget } from "./source-authority.js";

/** How long a resolved repository identity is reused. It matches the source
 * authority's admission window (CLOUD_SOURCE_ADMISSION_MS): every caller still
 * verifies access through the authority after resolving. */
export const REPOSITORY_IDENTITY_TTL_MS = 30_000;
const MAX_ENTRIES = 1_000;

/** A create resolves every Cloud Computer repository's identity (three GitHub
 * reads each), and the Create page's list does the same just before. Reuse a
 * resolution for the same user, repository ID and name for 30 s, and share one
 * in flight. Failures are never kept. */
export function cacheRepositoryIdentities(resolve: CloudV2ComputerSourceResolver, now: () => number = Date.now): CloudV2ComputerSourceResolver {
  const entries = new Map<string, { at: number; value: Promise<CloudSourceTarget> }>();
  return (organizationId, userId, target) => {
    const key = JSON.stringify([organizationId, userId, target.repositoryId ?? null, target.repository.toLowerCase()]);
    const cached = entries.get(key);
    if (cached && now() - cached.at < REPOSITORY_IDENTITY_TTL_MS) return cached.value;
    const value = resolve(organizationId, userId, target);
    entries.delete(key); entries.set(key, { at: now(), value });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
    return value;
  };
}

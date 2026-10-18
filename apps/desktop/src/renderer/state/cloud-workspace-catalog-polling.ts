import { cloudWorkspaceStreamCoverage, cloudWorkspaceStreamOrganizations, subscribeCloudWorkspaceStreamCoverage } from "./cloud-workspace-stream-coverage";
import { cloudCatalogStreamRolloutEnabled } from "./cloud-workspace-stream-rollout";

export const cloudWorkspaceLifecycleStreamCovered = (organizationId: string) =>
  cloudCatalogStreamRolloutEnabled() && cloudWorkspaceStreamCoverage(organizationId).deviceStream;
export const subscribeCloudWorkspacePollCoverage = (listener: () => void) =>
  cloudCatalogStreamRolloutEnabled() ? subscribeCloudWorkspaceStreamCoverage(listener) : () => {};

/** null retains the global fallback; [] needs no periodic catalog read.
 * Scoped list routes require membership, unlike the global guest-aware list. */
export function cloudCatalogFallbackOrganizations(
  memberOrganizationIds: readonly string[] | null, catalogOrganizationIds: readonly string[],
): readonly string[] | null {
  if (!cloudCatalogStreamRolloutEnabled() || memberOrganizationIds === null) return null;
  const coverage = cloudWorkspaceStreamOrganizations();
  if (!coverage || coverage.length >= 1_000 || memberOrganizationIds.length >= 1_000) return null;
  const members = new Set(memberOrganizationIds);
  const known = new Set([...members, ...catalogOrganizationIds, ...coverage.map(row => row.organizationId)]);
  if (!known.size || known.size >= 1_000) return null;
  const uncovered = [...known].filter(id => !cloudWorkspaceStreamCoverage(id).deviceStream).sort();
  // A large number of individual requests costs more than the existing
  // aggregate. Unknown/guest access also cannot use the member-only route.
  if (uncovered.length > 16 || uncovered.some(id => !members.has(id))) return null;
  return uncovered;
}

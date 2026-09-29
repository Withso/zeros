import { connectionProtection, assertDisposableConnectionTarget } from "./hosted-connections.mjs";
import { bindHostedProfile } from "./hosted-state.mjs";

/** Shared by manual Archive and GC, ahead of adapter-specific ownership proof.
 * Persistent infrastructure IDs can be added without giving hooks authority
 * to delete the registry, release resources, or the connections service. */
export function assertHostedCleanupTargets(state, profile) {
  if (profile.connections?.enabled || state.connectionProtection) {
    for(const protection of [state.connectionProtection,profile.connections?.enabled?connectionProtection(profile.connections):null].filter(Boolean)){
      assertDisposableConnectionTarget({projectId:profile.railway.projectId,id:state.resources.railway?.id,name:state.resources.railway?.name},protection);
      assertDisposableConnectionTarget({id:state.resources.railway?.serviceId},protection);
    }
  }
  bindHostedProfile(structuredClone(state), profile);
  const protectedResources = profile.protectedResources ?? {}, resources = state.resources;
  if (resources.railway && ([...(profile.railway.protectedEnvironmentIds ?? []), ...(protectedResources.railwayEnvironments ?? [])].includes(resources.railway.id) ||
      (protectedResources.railwayServices ?? []).includes(resources.railway.serviceId) || /^(alpha|beta|prod|production|main)$/i.test(resources.railway.name ?? ""))) throw new Error("Protected Railway resource");
  if (resources.planetscale && [profile.planetscale.protectedBranch, "alpha", "beta", "prod", "production", "main", ...(protectedResources.databaseBranches ?? [])].includes(resources.planetscale.name)) throw new Error("Protected database branch");
  const protectedImages = new Set([profile.boat?.baseSnapshot, ...(profile.boat?.protectedSnapshots ?? []), ...(protectedResources.snapshots ?? [])].filter(Boolean));
  if ((resources.images ?? []).some(image => protectedImages.has(image.snapshotId) || /^(?:alpha|beta|prod|production|release)(?:-|$)/i.test(image.snapshotId ?? ""))) throw new Error("Protected base or release snapshot");
  if (profile.storage.bucket === profile.registry.bucket || (protectedResources.buckets ?? []).includes(profile.storage.bucket)) throw new Error("Protected registry or service bucket");
}

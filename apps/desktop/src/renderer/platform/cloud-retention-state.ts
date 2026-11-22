// Whether an organization's server runs retention (Retention S3): the workspace list's `retention: true`, the
// same switch as the documents' retention fields, so an organization with no workspaces still knows. Read for
// every cloud organization the catalog lists, the Personal entry's cloud owner included.
import { useSyncExternalStore } from "react";
import { getOrganizationStoreGeneration } from "../features/team/team-store";

const retention = new Map<string, { generation: number; on: boolean }>();
const listeners = new Set<() => void>();
let version = 0;

export function cloudRetentionOrganization(organizationId: string | null | undefined): boolean {
  if (!organizationId) return false;
  const entry = retention.get(organizationId);
  return !!entry && entry.on && entry.generation === getOrganizationStoreGeneration();
}

export function recordOrganizationRetention(organizationId: string, on: boolean): void {
  const generation = getOrganizationStoreGeneration(), before = retention.get(organizationId);
  if (before && before.on === on && before.generation === generation) return;
  retention.set(organizationId, { generation, on }); version++;
  for (const listener of listeners) listener();
}

export function useCloudRetention(organizationId: string | null | undefined): boolean {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => version);
  return cloudRetentionOrganization(organizationId);
}

export function resetCloudRetentionStateForTests(): void { retention.clear(); version++; }

import type { CloudSdkStreamSnapshot } from "../../../shared/cloud-sdk-stream-contract";

type OrganizationCoverage = Readonly<CloudSdkStreamSnapshot["organizations"][number]>;
const NONE = Object.freeze({ deviceStream: false, presence: false });
let organizations: readonly OrganizationCoverage[] | null = null;
const listeners = new Set<() => void>();

export const subscribeCloudWorkspaceStreamCoverage = (listener: () => void) => {
  listeners.add(listener); return () => { listeners.delete(listener); };
};
/** Observation only. Poll replacement also requires its rollout gate. */
export const cloudWorkspaceStreamCoverage = (organizationId: string) =>
  organizations?.find(row => row.organizationId === organizationId) ?? NONE;
export const cloudWorkspaceStreamOrganizations = () => organizations;

/** Only the account-owned controller publishes a completed observation. */
export function setCloudWorkspaceStreamCoverage(next: CloudSdkStreamSnapshot | null): void {
  const rows = next?.leaseId && next.state === "open" && !next.catalogRequired ? next.organizations : null;
  if (JSON.stringify(organizations) === JSON.stringify(rows)) return;
  organizations = rows?.map(row => {
    const previous = organizations?.find(old => old.organizationId === row.organizationId);
    return previous?.deviceStream === row.deviceStream && previous.presence === row.presence
      ? previous : Object.freeze({ ...row });
  }) ?? null;
  for (const listener of listeners) listener();
}

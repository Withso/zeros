import { useSyncExternalStore } from "react";
import { getOrganizationStoreGeneration, getTeamStoreState, subscribeOrganizationSnapshots } from "../features/team/team-store";

/** Reuse negotiated organization sharing only within the same account generation. */
const sharing = new Map<string, { generation: number; on: boolean }>();
const listeners = new Set<() => void>();
let version = 0;

export function sharingOrganization(organizationId: string | null | undefined): boolean {
  if (!organizationId) return false;
  const entry = sharing.get(organizationId);
  return !!entry && entry.on && entry.generation === getOrganizationStoreGeneration();
}

export function recordOrganizationSharing(organizationId: string, on: boolean): { keepShared: boolean } {
  const generation = getOrganizationStoreGeneration();
  const before = sharing.get(organizationId);
  const wasOn = !!before && before.on && before.generation === generation;
  // An older replica's Creator-only reply cannot replace a confirmed shared set.
  if (wasOn && !on) return { keepShared: true };
  if (!before || before.on !== on || before.generation !== generation) {
    sharing.set(organizationId, { generation, on }); version++;
    for (const listener of listeners) listener();
  }
  return { keepShared: false };
}

export function useSharingOrganization(organizationId: string | null | undefined): boolean {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => version);
  return sharingOrganization(organizationId);
}

export const myUserId = (): string | null => getTeamStoreState().me?.user.id ?? null;
export function useMyUserId(): string | null {
  return useSyncExternalStore(subscribeOrganizationSnapshots, myUserId, myUserId);
}

export function resetTeamSharingStateForTests(): void { sharing.clear(); version++; }

export { registerSharingRoleLookup, reportWorkspaceReadOnly, sharingFor, subscribeWorkspaceReadOnly } from "./team-sharing-registry";

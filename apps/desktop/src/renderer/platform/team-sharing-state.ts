import { useSyncExternalStore } from "react";
import { getOrganizationStoreGeneration, getTeamStoreState, subscribeOrganizationSnapshots } from "../features/team/team-store";

/** Which organizations answered the last catalog read with teamSharing: 1, for
 * the current account generation. One predicate gates every sharing surface;
 * Local placements and Personal organizations never consult it. */
const sharing = new Map<string, { generation: number; on: boolean }>();
const listeners = new Set<() => void>();
let version = 0;

export function sharingOrganization(organizationId: string | null | undefined): boolean {
  if (!organizationId) return false;
  const entry = sharing.get(organizationId);
  return !!entry && entry.on && entry.generation === getOrganizationStoreGeneration();
}

/** Record a list reply; true when the reply cannot stand for the organization's
 * shared set (sharing was confirmed and this reply came without it: an N-1 replica). */
export function recordOrganizationSharing(organizationId: string, on: boolean): { keepShared: boolean } {
  const generation = getOrganizationStoreGeneration();
  const before = sharing.get(organizationId);
  const wasOn = !!before && before.on && before.generation === generation;
  // A creator-only reply never replaces a confirmed shared set; sharing stays on until a sharing reply says otherwise.
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

/** The signed-in account's user id (the viewer), or null before sign-in. */
export const myUserId = (): string | null => getTeamStoreState().me?.user.id ?? null;
export function useMyUserId(): string | null {
  return useSyncExternalStore(subscribeOrganizationSnapshots, myUserId, myUserId);
}

export function resetTeamSharingStateForTests(): void { sharing.clear(); version++; }

export { registerSharingRoleLookup, reportWorkspaceReadOnly, sharingFor, subscribeWorkspaceReadOnly } from "./team-sharing-registry";

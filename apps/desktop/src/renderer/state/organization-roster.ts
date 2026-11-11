import { useEffect, useSyncExternalStore } from "react";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { listOrganizationMembers, type OrganizationMember } from "../platform/team-sharing";

/** Team sharing: each organization's members (names, avatars) as one keyed
 * snapshot per account generation. A read shares its flight; the last
 * confirmed roster stays visible while it revalidates. */
const rosters = new Map<string, { generation: number; members: readonly OrganizationMember[] }>();
const flights = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { version++; for (const listener of listeners) listener(); };

export function organizationRosterSnapshot(organizationId: string | null | undefined): readonly OrganizationMember[] | null {
  if (!organizationId) return null;
  const entry = rosters.get(organizationId);
  return entry && entry.generation === getOrganizationStoreGeneration() ? entry.members : null;
}

export function loadOrganizationRoster(organizationId: string): Promise<void> {
  const generation = getOrganizationStoreGeneration(), flightKey = `${generation}:${organizationId}`;
  const existing = flights.get(flightKey);
  if (existing) return existing;
  const flight = listOrganizationMembers(organizationId).then(members => {
    if (generation !== getOrganizationStoreGeneration()) return;
    const before = rosters.get(organizationId);
    if (before?.generation === generation && JSON.stringify(before.members) === JSON.stringify(members)) return;
    rosters.set(organizationId, { generation, members });
    notify();
  }).finally(() => { flights.delete(flightKey); });
  flights.set(flightKey, flight);
  return flight;
}

/** The roster while `active`; loads once per organization and account. */
export function useOrganizationRoster(organizationId: string | null | undefined, active: boolean): readonly OrganizationMember[] | null {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => version);
  useEffect(() => {
    if (active && organizationId && !organizationRosterSnapshot(organizationId)) void loadOrganizationRoster(organizationId).catch(() => {});
  }, [active, organizationId]);
  return organizationRosterSnapshot(organizationId);
}

export function memberName(roster: readonly OrganizationMember[] | null, userId: string | null | undefined): string {
  return (userId && roster?.find(member => member.id === userId)?.name) || "A teammate";
}

export function resetOrganizationRostersForTests(): void { rosters.clear(); flights.clear(); notify(); }

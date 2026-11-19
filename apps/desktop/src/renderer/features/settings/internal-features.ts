import {
  readPreferenceCache,
  writePreferenceCache,
  subscribePreferenceCache,
} from "../../platform/personal-preferences";

import { useCallback, useSyncExternalStore } from "react";
import { isLocalDevelopment } from "../../platform/runtime";
import {
  AGENT_CONTROL_FEATURES,
  type AgentControlFeature,
} from "@zeros/protocol/agent-control-rollout";

import { getTeamStoreState, useTeams } from "../team/team-store";

// Use the database-backed /v1/me role, not a JWT claim; unresolved accounts fail closed.
// support_admin is a serialized legacy role, not engineering access.
export function isInternalUser(): boolean {
  if (isLocalDevelopment()) return true;
  const role = getTeamStoreState().me?.user.staffRole;
  return role === "developer" || role === "platform_owner";
}

export function useIsInternalUser(): boolean {
  const { me } = useTeams();
  return (
    isLocalDevelopment() ||
    me?.user.staffRole === "developer" ||
    me?.user.staffRole === "platform_owner"
  );
}

export type InternalFeature =
  // Copy Logs may expose only the same scrubbed log tail used by feedback.
  | "copyLogs"
  | "resourceSummary"
  | "designGpuCanvas"
  | "releaseCandidates"
  | AgentControlFeature;

// This persisted key also identifies the preference in the shared cache.
const STORAGE_KEY = "zeros.internalFeatures";

// A stored retired key must never read as on.
const KNOWN: ReadonlySet<string> = new Set<InternalFeature>([
  "copyLogs",
  "resourceSummary",
  "designGpuCanvas",
  "releaseCandidates",
  ...AGENT_CONTROL_FEATURES,
]);
const ON_BY_DEFAULT: ReadonlySet<string> = new Set<InternalFeature>([
  "copyLogs",
  "resourceSummary",
  ...AGENT_CONTROL_FEATURES,
]);

function flagOn(persisted: PersistedShape, feature: InternalFeature): boolean {
  if (!KNOWN.has(feature)) return false;
  const value = persisted[feature];
  return value === true || (value === undefined && ON_BY_DEFAULT.has(feature));
}

// Read the retired key for serialized compatibility; it grants no access.
type PersistedShape = Partial<Record<InternalFeature | "cloudComputerV2", boolean>>;

function readPersisted(): PersistedShape {
  try {
    const raw = readPreferenceCache(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as PersistedShape)
      : {};
  } catch {
    return {};
  }
}

function writePersisted(next: PersistedShape): void {
  try {
    writePreferenceCache(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage quota / private mode — non-fatal */
  }
}

let current: PersistedShape = readPersisted();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): PersistedShape {
  return current;
}

/** The stored flag is editable locally; use the effective gate for runtime access. */
export function isInternalFeatureEnabled(feature: InternalFeature): boolean {
  return flagOn(current, feature);
}

export function setInternalFeatureEnabled(
  feature: InternalFeature,
  on: boolean,
): void {
  current = { ...current, [feature]: on };
  writePersisted(current);
  emit();
}

// Read the current role here so callers cannot supply a stale account.
export function isInternalFeatureActive(feature: InternalFeature): boolean {
  return isInternalUser() && isInternalFeatureEnabled(feature);
}

// Windows share persisted flags but not in-memory snapshots.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    current = readPersisted();
    emit();
  });
}

/** Bind the switch here; runtime consumers must use the effective gate. */
export function useInternalFeature(
  feature: InternalFeature,
): [boolean, (on: boolean) => void] {
  const persisted = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const on = flagOn(persisted, feature);
  const set = useCallback(
    (next: boolean) => setInternalFeatureEnabled(feature, next),
    [feature],
  );
  return [on, set];
}

// Gate discoverability and execution here; privileged endpoints must still require staff.
export function useInternalFeatureActive(feature: InternalFeature): boolean {
  const internalUser = useIsInternalUser();
  const [on] = useInternalFeature(feature);
  return internalUser && on;
}

subscribePreferenceCache(STORAGE_KEY, () => {
  current = readPersisted();
  emit();
});

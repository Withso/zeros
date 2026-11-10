import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { cloudAccountRequest } from "../../platform/cloud-workspaces";
import { getOrganizationStoreGeneration } from "../team/team-store";

const Reply = z.object({ workspaceApiAccess: z.boolean() });
const MAX_ORGANIZATIONS = 64;

export interface WorkspaceApiAccessState { value: boolean | undefined; saving: boolean; failed: boolean }
interface Entry extends WorkspaceApiAccessState { reading?: Promise<boolean>; writes: number }

// Keyed by account generation and organization: a value never crosses
// accounts, and each organization keeps its own confirmed snapshot.
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const EMPTY: WorkspaceApiAccessState = Object.freeze({ value: undefined, saving: false, failed: false });
const views = new Map<string, WorkspaceApiAccessState>();

const keyFor = (organizationId: string) => `${getOrganizationStoreGeneration()}:${organizationId}`;
function entry(key: string): Entry {
  let found = entries.get(key);
  if (!found) {
    found = { value: undefined, saving: false, failed: false, writes: 0 };
    entries.set(key, found);
    while (entries.size > MAX_ORGANIZATIONS) { const oldest = entries.keys().next().value!; entries.delete(oldest); views.delete(oldest); }
  }
  return found;
}
const view = (current: Entry): WorkspaceApiAccessState => Object.freeze({ value: current.value, saving: current.saving, failed: current.failed });
function changed(key: string): void {
  const current = entries.get(key);
  if (current) views.set(key, view(current));
  for (const listener of listeners) listener();
}
const path = (organizationId: string) => `/v1/cloud-v2/organizations/${encodeURIComponent(organizationId)}/api-access`;

export function workspaceApiAccessSnapshot(organizationId: string): WorkspaceApiAccessState {
  const key = keyFor(organizationId), current = entries.get(key);
  if (!current) return EMPTY;
  // Read during render: build the stable view without notifying anyone.
  if (!views.has(key)) views.set(key, view(current));
  return views.get(key)!;
}

/** One read per organization at a time; a write started meanwhile wins. */
export function loadWorkspaceApiAccess(organizationId: string): Promise<boolean> {
  const key = keyFor(organizationId), current = entry(key);
  if (current.reading) return current.reading;
  const writes = current.writes;
  const reading = cloudAccountRequest(path(organizationId), Reply).then(reply => {
    if (entries.get(key) === current && current.writes === writes && !current.saving) {
      current.value = reply.workspaceApiAccess; current.failed = false; changed(key);
    }
    return reply.workspaceApiAccess;
  }, error => {
    if (entries.get(key) === current && current.value === undefined) { current.failed = true; changed(key); }
    throw error;
  }).finally(() => { if (current.reading === reading) current.reading = undefined; });
  current.reading = reading;
  return reading;
}

/** Shown at once; reverted to the last confirmed value if the server refuses. */
export async function saveWorkspaceApiAccess(organizationId: string, value: boolean): Promise<void> {
  const key = keyFor(organizationId), current = entry(key), previous = current.value, write = ++current.writes;
  current.value = value; current.saving = true; changed(key);
  try {
    const reply = await cloudAccountRequest(path(organizationId), Reply, { body: { workspaceApiAccess: value }, idempotencyKey: crypto.randomUUID(), method: "PUT" });
    if (entries.get(key) === current && current.writes === write) current.value = reply.workspaceApiAccess;
  } catch (error) {
    if (entries.get(key) === current && current.writes === write) current.value = previous;
    throw error;
  } finally {
    if (entries.get(key) === current && current.writes === write) { current.saving = false; changed(key); }
  }
}

export function clearWorkspaceApiAccess(): void { entries.clear(); views.clear(); for (const listener of listeners) listener(); }

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Revalidates while the settings surface is active; inactive, it only reads the snapshot. */
export function useWorkspaceApiAccess(organizationId: string, active: boolean): WorkspaceApiAccessState {
  const snapshot = () => workspaceApiAccessSnapshot(organizationId);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (active) void loadWorkspaceApiAccess(organizationId).catch(() => {});
  }, [organizationId, active]);
  return state;
}

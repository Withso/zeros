import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { cloudCatalogGeneration } from "./cloud-workspace-catalog";

export type CloudWorkspaceRestartPhase = "stopping" | "stopped" | "waking" | "connecting";
// Only live actions are retained. Nothing is persisted or resumed on app launch.
const phases = new Map<string, { account: number; phase: CloudWorkspaceRestartPhase }>();
const listeners = new Set<() => void>();

export function cloudWorkspaceRestartPhase(folder: string): CloudWorkspaceRestartPhase | null {
  const target = parseCloudWorkspaceKey(folder);
  const entry = target ? phases.get(cloudWorkspaceKey(target)) : undefined;
  return entry?.account === cloudCatalogGeneration() ? entry.phase : null;
}

export function publishCloudWorkspaceRestartPhase(folder: string, account: number, phase: CloudWorkspaceRestartPhase | null): void {
  if (phase) phases.set(folder, { account, phase });
  else if (phases.get(folder)?.account === account) phases.delete(folder);
  for (const listener of listeners) listener();
}

export function subscribeCloudWorkspaceRestarts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

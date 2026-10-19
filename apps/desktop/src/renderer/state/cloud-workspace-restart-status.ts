import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { cloudCatalogGeneration, cloudWorkspaceDocument, getCloudWorkspaceDocuments, subscribeCloudWorkspaces } from "./cloud-workspace-catalog";

export type CloudWorkspaceRestartPhase = "stopping" | "stopped" | "waking" | "connecting";
// Only live foreground phases are retained here. The shared catalog owns
// accepted background status, including after app reload.
const phases = new Map<string, { account: number; phase: CloudWorkspaceRestartPhase }>();
const listeners = new Set<() => void>();

export function cloudWorkspaceRestartPhase(folder: string): CloudWorkspaceRestartPhase | null {
  const target = parseCloudWorkspaceKey(folder);
  const entry = target ? phases.get(cloudWorkspaceKey(target)) : undefined;
  if (entry?.account === cloudCatalogGeneration()) return entry.phase;
  const operation = target ? cloudWorkspaceDocument(target)?.acceptedOperation : undefined;
  return operation?.kind === "restart" && operation.state === "pending"
    ? operation.phase === "starting" ? "waking" : "stopping" : null;
}

export function publishCloudWorkspaceRestartPhase(folder: string, account: number, phase: CloudWorkspaceRestartPhase | null): void {
  if (phase) phases.set(folder, { account, phase });
  else if (phases.get(folder)?.account === account) phases.delete(folder);
  for (const listener of listeners) listener();
}

export function subscribeCloudWorkspaceRestarts(listener: () => void, options: { observeCatalog?: boolean } = {}): () => void {
  listeners.add(listener);
  // Workbench availability already observes the catalog for this exact owner.
  if (options.observeCatalog === false) return () => { listeners.delete(listener); };
  const projection = () => JSON.stringify([cloudCatalogGeneration(), getCloudWorkspaceDocuments()
    .filter(doc => doc.acceptedOperation?.kind === "restart")
    .map(doc => [doc.id, doc.acceptedOperation?.id, doc.acceptedOperation?.phase, doc.acceptedOperation?.state])]);
  let previous = projection();
  const off = subscribeCloudWorkspaces(() => {
    const current = projection();
    if (current !== previous) { previous = current; listener(); }
  });
  return () => { listeners.delete(listener); off(); };
}

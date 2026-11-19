import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";

/** Publish the request here so shared workspace UI need not import the feature that renders the dialog. */
let openTarget: CloudWorkspaceTarget | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function openReassignDialog(target: CloudWorkspaceTarget): void { openTarget = target; emit(); }
export function closeReassignDialog(): void { if (openTarget) { openTarget = null; emit(); } }
export function subscribeReassignDialog(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function readReassignDialog(): CloudWorkspaceTarget | null { return openTarget; }

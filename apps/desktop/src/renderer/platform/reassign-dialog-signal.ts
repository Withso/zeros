import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";

/** Team sharing 3B: which workspace's Reassign dialog is open (one for the app). Platform-level, so shared UI (a row's
 * context menu) can ask for it without importing the feature that renders it (features/team/reassign-dialog.tsx). */
let openTarget: CloudWorkspaceTarget | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function openReassignDialog(target: CloudWorkspaceTarget): void { openTarget = target; emit(); }
export function closeReassignDialog(): void { if (openTarget) { openTarget = null; emit(); } }
export function subscribeReassignDialog(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function readReassignDialog(): CloudWorkspaceTarget | null { return openTarget; }

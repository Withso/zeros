import { getOrganizationStoreGeneration } from "../features/team/team-store";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
type Erasure = CloudWorkspaceTarget & { chatId?: string };
const listeners = new Set<(owner: Erasure) => void>();
/** Published only after an explicit cloud deletion commits. Closing a tab or
 * signing out never erases a saved prompt or silently cancels its delivery. */
export const subscribeCloudPromptErasure = (listener: (owner: Erasure) => void) => {
  listeners.add(listener); return () => { listeners.delete(listener); };
};
export const eraseCloudPrompts = (owner: Erasure) => { for (const listener of listeners) listener(owner); };

/** Capture before the deletion request: an old account's late acknowledgement
 * cannot erase a replacement account's private journal. */
export function prepareCloudPromptErasure(owner: Erasure): () => void {
  const generation = getOrganizationStoreGeneration();
  return () => { if (generation === getOrganizationStoreGeneration()) eraseCloudPrompts(owner); };
}

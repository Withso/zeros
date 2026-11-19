import { getOrganizationStoreGeneration } from "../features/team/team-store";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
type Erasure = CloudWorkspaceTarget & { chatId?: string };
const listeners = new Set<(owner: Erasure) => void>();
// Publish only after explicit cloud deletion commits; closing or signing out leaves queued prompts to resume.
export const subscribeCloudPromptErasure = (listener: (owner: Erasure) => void) => {
  listeners.add(listener); return () => { listeners.delete(listener); };
};
export const eraseCloudPrompts = (owner: Erasure) => { for (const listener of listeners) listener(owner); };

// Capture the account generation before deletion so a late acknowledgment cannot erase another account's journal.
export function prepareCloudPromptErasure(owner: Erasure): () => void {
  const generation = getOrganizationStoreGeneration();
  return () => { if (generation === getOrganizationStoreGeneration()) eraseCloudPrompts(owner); };
}

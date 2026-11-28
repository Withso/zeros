export interface DesignAgentPageFollowMemory {
  directoryId: string;
  pageIds: readonly string[];
  navigationEvent: number;
  turnActive: boolean;
}

export interface DesignAgentPageFollowInput {
  /** The focused, visible Design surface. Hidden workspaces never follow. */
  active: boolean;
  /** Any agent chat for this exact workspace folder has an active turn. */
  turnActive: boolean;
  directoryId?: string;
  activePageId?: string;
  pages: readonly { id: string }[];
  /** Explicit user page navigation counter for the same workspace. */
  navigationEvent: number;
}

/** Track the confirmed catalog continuously, then follow only a page that is
 * added after the focused workspace's turn baseline. The original navigation
 * event is retained for the whole turn: once the user chooses a page, later
 * agent-created pages do not pull the canvas away. */
export function updateDesignAgentPageFollow(
  memory: DesignAgentPageFollowMemory | null,
  input: DesignAgentPageFollowInput,
): { memory: DesignAgentPageFollowMemory | null; switchToPageId?: string } {
  const pageIds = input.pages.map((page) => page.id);
  if (!input.active || !input.directoryId || pageIds.length === 0) return { memory: null };
  if (!memory || memory.directoryId !== input.directoryId) {
    return { memory: { directoryId: input.directoryId, pageIds, navigationEvent: input.navigationEvent, turnActive: input.turnActive } };
  }
  if (!input.turnActive) {
    return { memory: { ...memory, pageIds, navigationEvent: input.navigationEvent, turnActive: false } };
  }
  if (!memory.turnActive) {
    return { memory: { ...memory, pageIds, navigationEvent: input.navigationEvent, turnActive: true } };
  }
  const known = new Set(memory.pageIds);
  const added = pageIds.filter((id) => !known.has(id));
  const next = { ...memory, pageIds, turnActive: true };
  if (!added.length || memory.navigationEvent !== input.navigationEvent) return { memory: next };
  const switchToPageId = [...added].reverse().find((id) => id !== input.activePageId);
  return { memory: next, ...(switchToPageId ? { switchToPageId } : {}) };
}

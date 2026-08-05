export interface InlineTextCommitGuard<Edit extends object> {
  /** Exact edit abandoned by Escape; its following blur must be ignored. */
  cancelledEdit: Edit | null;
  /** Exact semantic edit key already committing through the bridge. */
  activeKey: string | null;
}

/** Create one component-owned guard for Escape/blur and Enter/blur ordering. */
export function createInlineTextCommitGuard<
  Edit extends object,
>(): InlineTextCommitGuard<Edit> {
  return { cancelledEdit: null, activeKey: null };
}

/** Mark an edit cancelled before unmount can dispatch its blur handler. */
export function cancelInlineTextCommit<Edit extends object>(
  guard: InlineTextCommitGuard<Edit>,
  edit: Edit,
): void {
  guard.cancelledEdit = edit;
}

/** Claim one commit unless this is a cancelled blur or duplicate event. */
export function beginInlineTextCommit<Edit extends object>(
  guard: InlineTextCommitGuard<Edit>,
  edit: Edit,
  key: string,
): boolean {
  if (guard.cancelledEdit === edit) {
    guard.cancelledEdit = null;
    return false;
  }
  if (guard.activeKey === key) return false;
  guard.activeKey = key;
  return true;
}

/** Release only the commit that still owns this exact semantic key. */
export function finishInlineTextCommit<Edit extends object>(
  guard: InlineTextCommitGuard<Edit>,
  key: string,
): void {
  if (guard.activeKey === key) guard.activeKey = null;
}

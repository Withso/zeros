// Lets a surface inside Workbench ask the shell to hide the column. The shell
// router owns the persisted collapse preference, and its callers span trees
// that share no context (a Browser tab, the float stack), so this is a
// module-level pub/sub like feedback-controller.ts.

type Listener = () => void;
const collapseListeners = new Set<Listener>();

/** Ask the shell to collapse Workbench. No-op while no shell is mounted or
 * when workspace tools are unavailable (the shell decides). */
export function requestWorkbenchCollapse(): void {
  for (const listener of [...collapseListeners]) listener();
}

/** Shell-side subscription. Returns an unsubscribe. */
export function onWorkbenchCollapseRequest(listener: Listener): () => void {
  collapseListeners.add(listener);
  return () => {
    collapseListeners.delete(listener);
  };
}

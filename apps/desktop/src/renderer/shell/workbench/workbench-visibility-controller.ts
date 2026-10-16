// Lets a surface inside Workbench ask the shell to hide the column. The shell
// router owns the persisted collapse preference, and its callers span trees
// that share no context (a Browser tab, the float stack), so this is a
// module-level pub/sub like feedback-controller.ts.

type Listener = () => void;
const collapseListeners = new Set<Listener>();
const restoreListeners = new Set<Listener>();

/** Ask the shell to hide Workbench while a Browser float covers the chat.
 * No-op while no shell is mounted or when workspace tools are unavailable
 * (the shell decides). */
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

/** Tell the shell the last float closed. It shows the column again only if
 * a float hid it and the user has not shown or hidden it since. */
export function requestWorkbenchRestore(): void {
  for (const listener of [...restoreListeners]) listener();
}

/** Shell-side subscription. Returns an unsubscribe. */
export function onWorkbenchRestoreRequest(listener: Listener): () => void {
  restoreListeners.add(listener);
  return () => {
    restoreListeners.delete(listener);
  };
}

/** The Workbench column as the shell holds it. `hiddenByFloat` is set only
 * while `collapsed` is, when a float hid an open column. */
export interface WorkbenchColumnState {
  collapsed: boolean;
  hiddenByFloat: boolean;
}

export type WorkbenchColumnEvent =
  /** ⌥⌘B or the panel button. */
  | "toggle"
  /** A surface needs the column, such as Open in right panel. */
  | "reveal"
  /** A Browser tab started floating. */
  | "float"
  /** Close ended the last float of the scope. */
  | "floats-closed";

export function nextWorkbenchColumnState(
  state: WorkbenchColumnState,
  event: WorkbenchColumnEvent,
): WorkbenchColumnState {
  switch (event) {
    case "toggle":
      return { collapsed: !state.collapsed, hiddenByFloat: false };
    case "reveal":
      return state.collapsed ? { collapsed: false, hiddenByFloat: false } : state;
    case "float":
      return state.collapsed ? state : { collapsed: true, hiddenByFloat: true };
    case "floats-closed":
      return state.hiddenByFloat ? { collapsed: false, hiddenByFloat: false } : state;
  }
}

/** The preference the shell persists. Floats last only for the renderer
 * session, so a float's hide is never saved; a reload shows the column the
 * user chose. */
export function persistedWorkbenchCollapsed(state: WorkbenchColumnState): boolean {
  return state.collapsed && !state.hiddenByFloat;
}

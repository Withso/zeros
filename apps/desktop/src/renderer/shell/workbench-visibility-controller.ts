// Module-level request channel for revealing the single app-owned Workbench.
// Browser/file link handlers live deep in retained chat trees, while the
// collapsed preference is owned by ShellRouter. Keeping this one-way avoids a
// second collapse state or a route repair effect.

type Listener = () => void;
const listeners = new Set<Listener>();

export function requestWorkbenchVisible(): void {
  for (const listener of listeners) listener();
}

export function onWorkbenchVisibleRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

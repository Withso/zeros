export type DesignWorkspaceShortcut = "stage" | "undo" | "redo";

export interface DesignWorkspaceShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}

interface DispatchableDesignWorkspaceShortcutEvent extends DesignWorkspaceShortcutEvent {
  preventDefault(): void;
}

type DesignWorkspaceShortcutActions = Record<
  DesignWorkspaceShortcut,
  () => void
>;

/** Resolve only the document-editing chords owned by an active Design surface.
 * A focused text field keeps its native undo stack, while staging remains global
 * so Command/Ctrl+S can first blur and publish that field's current draft. */
export function resolveDesignWorkspaceShortcut(
  event: DesignWorkspaceShortcutEvent,
  editableTarget: boolean,
): DesignWorkspaceShortcut | null {
  if (event.isComposing || event.altKey || (!event.metaKey && !event.ctrlKey)) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === "s") return event.shiftKey ? null : "stage";
  if (key !== "z" || editableTarget) return null;
  return event.shiftKey ? "redo" : "undo";
}

/** Dispatch synchronously. The cache's per-workspace mutation lane serializes
 * the resulting async writes, so repeated shortcuts retain every keypress and
 * preserve their exact order instead of being dropped while one is in flight. */
export function dispatchDesignWorkspaceShortcut(
  event: DispatchableDesignWorkspaceShortcutEvent,
  editableTarget: boolean,
  actions: DesignWorkspaceShortcutActions,
): boolean {
  const shortcut = resolveDesignWorkspaceShortcut(event, editableTarget);
  if (!shortcut) return false;
  event.preventDefault();
  actions[shortcut]();
  return true;
}

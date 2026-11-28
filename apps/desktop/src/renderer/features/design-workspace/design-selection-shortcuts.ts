export type DesignSelectionShortcut = "copy" | "duplicate" | "delete";

export interface DesignSelectionShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
}

/** Resolve commands owned by the current Design selection. Native editing and
 * clipboard behavior always wins while a text or numeric field has focus. */
export function resolveDesignSelectionShortcut(
  event: DesignSelectionShortcutEvent,
  editableTarget: boolean,
  hasFocusedSelection: boolean,
): DesignSelectionShortcut | null {
  if (
    !hasFocusedSelection ||
    editableTarget ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.altKey ||
    event.shiftKey
  ) {
    return null;
  }

  const key = event.key.toLocaleLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === "c") return "copy";
  if ((event.metaKey || event.ctrlKey) && key === "d") return "duplicate";
  if (
    !event.metaKey &&
    !event.ctrlKey &&
    (event.key === "Backspace" || event.key === "Delete")
  ) {
    return "delete";
  }
  return null;
}

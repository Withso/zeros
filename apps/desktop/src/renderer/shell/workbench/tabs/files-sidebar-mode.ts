export type FilesSidebarMode = "tree" | "search" | "directories" | null;
export type FilesSidebarKind = Exclude<FilesSidebarMode, null>;

export interface FilesSidebarSelection {
  hasFile: boolean;
  mode: FilesSidebarMode;
}

/** Keep ephemeral sidebar ownership aligned with the mounted tab's shape.
 * Closing the fixed File tab preserves its id, so the component does not
 * remount; that filled -> blank transition must still synchronously restore
 * Tree. The following blank -> filled transition then carries Tree forward. */
export function reconcileFilesSidebarSelection(
  selection: FilesSidebarSelection,
  hasFile: boolean,
): FilesSidebarSelection {
  if (selection.hasFile === hasFile) return selection;
  return {
    hasFile,
    mode: hasFile ? selection.mode : "tree",
  };
}

/** One Files action owns the shared right sidebar at a time. Re-clicking the
 * active action closes a filled tab's sidebar; a blank File tab falls back to
 * its tree so it always retains a way to choose the first file. */
export function nextFilesSidebarMode(
  current: FilesSidebarMode,
  requested: FilesSidebarKind,
  hasFile: boolean,
): FilesSidebarMode {
  if (current !== requested) return requested;
  return hasFile ? null : "tree";
}

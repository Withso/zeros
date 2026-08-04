// Frame-level design selection shared by the renderer and first-party MCP.
//
// Phase 1 selects whole frames. The shape intentionally already carries the
// element-level fields Phase 2 will populate, so the MCP contract does not need
// a breaking redesign when node selection lands.

export interface DesignSelection {
  frame: string;
  filePath: string;
  sourceVersion: string;
  nodeIds: string[];
  breadcrumb: string[];
  rects: Array<{ x: number; y: number; width: number; height: number }>;
  keyComputedStyles: Record<string, string>;
  updatedAt: number;
}

interface DesignSelectionEntry {
  version: number;
  selection: DesignSelection | null;
}

const selections = new Map<string, DesignSelectionEntry>();
const MAX_SELECTIONS = 128;

export function setDesignSelection(
  workspaceId: string,
  selection: DesignSelection | null,
  version = selection?.updatedAt ?? Date.now(),
): void {
  const current = selections.get(workspaceId);
  if (current && current.version > version) return;
  selections.delete(workspaceId);
  selections.set(workspaceId, { version, selection });
  while (selections.size > MAX_SELECTIONS) {
    const oldest = selections.keys().next().value as string | undefined;
    if (!oldest) break;
    selections.delete(oldest);
  }
}

export function getDesignSelection(
  workspaceId: string,
): DesignSelection | null {
  const entry = selections.get(workspaceId);
  if (!entry) return null;
  // Touch for bounded LRU behavior without rematerializing the value.
  selections.delete(workspaceId);
  selections.set(workspaceId, entry);
  return entry.selection;
}

export function forgetDesignSelection(workspaceId: string): void {
  selections.delete(workspaceId);
}

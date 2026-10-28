import { create } from "zustand";
import type { DesignFrameGeometryWire, DesignWorkspaceSnapshotWire } from "../../../platform/git";
import type { DesignRuntimeNodeDetails, DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import { useDesignWorkspaceUiStore } from "./design-workspace-ui";
import type { DesignHistorySelectionHint } from "./design-history-preview";
import type { DesignSelectionTarget } from "../design-selected-targets";

export interface DesignHistoryGeometryPreview {
  directoryId: string;
  frames: ReadonlyMap<string, DesignFrameGeometryWire>;
}
export interface DesignHistorySelectionPreview {
  activePageId?: string;
  selectedFrame: string | null;
  selectedNodeId: null;
  selectedNodeIds: readonly string[];
  selectedTargets: readonly DesignSelectionTarget[];
  frameSelected: boolean;
}
interface SelectionOwner { ownerRevision?: number; selectionEvent?: number }
export interface DesignHistoryPresentation {
  token: object;
  identity: string;
  directoryId: string;
  directoryRevision: number;
  geometry: DesignHistoryGeometryPreview | null;
  // History never pins another copy of a prepared document outside its cache
  // budget. A collected catalog simply falls back to confirmed presentation.
  catalog: WeakRef<DesignWorkspaceSnapshotWire> | null;
  selection: { owner: SelectionOwner; value: DesignHistorySelectionPreview } | null;
  runtime: ReadonlyMap<string, { sourceVersion: string; frame: DesignRuntimeNodeDetails; details: ReadonlyMap<string, DesignRuntimeNodeDetails>; tree?: readonly DesignRuntimeTreeNode[] }>;
}
const store = create<{ byWorkspace: ReadonlyMap<string, DesignHistoryPresentation> }>(() => ({ byWorkspace: new Map() }));
const MAX_PRESENTATION_BYTES = 1024 * 1024;
let readOwner: (workspaceId: string) => string = () => "";
/** The cache supplies exact folder/capability identity without a module cycle. */
export function setDesignHistoryPresentationOwnerReader(reader: typeof readOwner): void { readOwner = reader; }

// One transient presentation is retained, never a stack of inspector trees.
// Count every retained string/container, including a token's target metadata;
// weak catalog references do not own the underlying prepared source.
function retainedBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") return value.length * 2;
  if (!value || typeof value !== "object") return 16;
  if (value instanceof WeakRef || seen.has(value)) return 16;
  seen.add(value);
  let bytes = 64;
  const entries = value instanceof Map ? value.entries() : Object.entries(value);
  for (const [key, item] of entries) {
    bytes += retainedBytes(key, seen) + retainedBytes(item, seen);
    if (bytes > MAX_PRESENTATION_BYTES) break;
  }
  return bytes;
}
function publish(byWorkspace: Map<string, DesignHistoryPresentation>): void {
  let bytes = retainedBytes(byWorkspace);
  while (byWorkspace.size > 16 || bytes > MAX_PRESENTATION_BYTES) {
    byWorkspace.delete(byWorkspace.keys().next().value!);
    bytes = retainedBytes(byWorkspace);
  }
  store.setState({ byWorkspace });
}

export function designHistoryPresentation(workspaceId: string): DesignHistoryPresentation | null {
  return current(workspaceId, store.getState().byWorkspace.get(workspaceId));
}
function current(workspaceId: string, value: DesignHistoryPresentation | undefined): DesignHistoryPresentation | null {
  if (!value) return null;
  const owner = useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId];
  return readOwner(workspaceId) === value.identity && (owner?.directoryId ?? "") === value.directoryId &&
    (owner?.directoryRevision ?? 0) === value.directoryRevision ? value : null;
}
export function presentDesignHistory(workspaceId: string, token: object, target: {
  geometry?: ReadonlyMap<string, DesignFrameGeometryWire>;
  catalog?: WeakRef<DesignWorkspaceSnapshotWire>;
  selection?: DesignHistorySelectionHint;
  selectionOwner?: SelectionOwner;
}): void {
  const owner = useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId];
  const directoryId = owner?.directoryId ?? "";
  const byWorkspace = new Map(store.getState().byWorkspace);
  const previous = designHistoryPresentation(workspaceId);
  byWorkspace.delete(workspaceId);
  byWorkspace.set(workspaceId, {
    token, identity: readOwner(workspaceId), directoryId, directoryRevision: owner?.directoryRevision ?? 0,
    geometry: target.geometry ? { directoryId, frames: target.geometry } : null,
    catalog: target.catalog ?? null, runtime: previous?.runtime ?? new Map(),
    selection: target.selection ? {
      owner: target.selectionOwner ?? { ownerRevision: owner?.ownerRevision, selectionEvent: owner?.selectionEvent },
      value: { activePageId: target.selection.pageId, selectedFrame: target.selection.frame, selectedNodeId: null,
        selectedNodeIds: [], selectedTargets: target.selection.frame && target.selection.frameSelected ? [{ frame: target.selection.frame }] : [],
        frameSelected: target.selection.frame !== null && target.selection.frameSelected },
    } : null,
  });
  publish(byWorkspace);
}
export function presentDesignHistoryRuntime(workspaceId: string, token: object, frame: string, value: {
  sourceVersion: string;
  snapshot: { frame: DesignRuntimeNodeDetails; tree?: readonly DesignRuntimeTreeNode[] };
  details: readonly DesignRuntimeNodeDetails[];
  treeUnchanged?: boolean;
}): void {
  const previous = designHistoryPresentation(workspaceId);
  if (!previous || previous.token !== token) return;
  const runtime = new Map(previous.runtime);
  const tree = value.treeUnchanged === true ? runtime.get(frame)?.tree : value.snapshot.tree;
  runtime.delete(frame);
  const projected = { sourceVersion: value.sourceVersion, frame: value.snapshot.frame,
    details: new Map(value.details.slice(0, 32).map(detail => [detail.oid, detail])), ...(tree ? { tree } : {}) };
  if (retainedBytes(projected) <= MAX_PRESENTATION_BYTES) runtime.set(frame, projected);
  while (runtime.size > 8) runtime.delete(runtime.keys().next().value!);
  const byWorkspace = new Map(store.getState().byWorkspace);
  byWorkspace.set(workspaceId, { ...previous, runtime });
  publish(byWorkspace);
}
export function clearDesignHistoryPresentation(workspaceId?: string, token?: object): void {
  if (!workspaceId) { store.setState({ byWorkspace: new Map() }); return; }
  const previous = store.getState().byWorkspace.get(workspaceId);
  if (!previous || (token && previous.token !== token)) return;
  const byWorkspace = new Map(store.getState().byWorkspace);
  byWorkspace.delete(workspaceId); store.setState({ byWorkspace });
}
export function useDesignHistoryPresentation(workspaceId: string | null | undefined): DesignHistoryPresentation | null {
  return store(state => workspaceId ? current(workspaceId, state.byWorkspace.get(workspaceId)) : null);
}
export function useDesignHistoryGeometryPreview(workspaceId: string): DesignHistoryGeometryPreview | null {
  return useDesignHistoryPresentation(workspaceId)?.geometry ?? null;
}

function selectionForOwner(selection: DesignHistoryPresentation["selection"], owner: SelectionOwner | undefined): DesignHistorySelectionPreview | null {
  return selection && (selection.owner.ownerRevision ?? 0) === (owner?.ownerRevision ?? 0) &&
    selection.owner.selectionEvent === owner?.selectionEvent ? selection.value : null;
}
export function designHistorySelection(workspaceId: string): DesignHistorySelectionPreview | null {
  return selectionForOwner(designHistoryPresentation(workspaceId)?.selection ?? null, useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]);
}
/** Paint-only navigation. A later page or explicit selection always wins;
 * neither persisted view state nor mutation ownership is changed. */
export function useDesignHistorySelection(workspaceId: string | null | undefined): DesignHistorySelectionPreview | null {
  const presentation = useDesignHistoryPresentation(workspaceId);
  const ownerRevision = useDesignWorkspaceUiStore(state => workspaceId ? state.byWorkspace[workspaceId]?.ownerRevision : undefined);
  const selectionEvent = useDesignWorkspaceUiStore(state => workspaceId ? state.byWorkspace[workspaceId]?.selectionEvent : undefined);
  return selectionForOwner(presentation?.selection ?? null, { ownerRevision, selectionEvent });
}

import type {
  DesignRuntimeRect,
  DesignRuntimeTreeNode,
} from "@zeros/protocol/design-runtime";

export interface FlatDesignLayer {
  node: DesignRuntimeTreeNode;
  depth: number;
  parentOid: string | null;
  hasChildren: boolean;
  /** True when any ancestor is hidden, so the whole subtree can fade. */
  hiddenByAncestor: boolean;
}

export interface DesignLayerWindow {
  start: number;
  end: number;
}

/** Fixed-row virtualization window for very large authored trees. Small trees
 * stay whole for simpler accessibility; large trees retain an overscan buffer
 * so wheel and keyboard travel never reveal an unpainted seam. */
export function designLayerVirtualWindow(input: {
  count: number;
  visibleTop: number;
  viewportHeight: number;
  rowHeight?: number;
  overscan?: number;
}): DesignLayerWindow {
  const count = Math.max(0, Math.floor(input.count));
  if (count <= 400) return { start: 0, end: count };
  const rowHeight = Math.max(1, input.rowHeight ?? 28);
  const overscan = Math.max(0, Math.floor(input.overscan ?? 12));
  const visibleTop = Math.max(0, input.visibleTop);
  const viewportHeight = Math.max(rowHeight, input.viewportHeight);
  const start = Math.max(0, Math.floor(visibleTop / rowHeight) - overscan);
  const end = Math.min(
    count,
    Math.ceil((visibleTop + viewportHeight) / rowHeight) + overscan,
  );
  return { start, end: Math.max(start, end) };
}

/** Reveal a keyboard target without accidentally collapsing an already-correct
 * window to the height of one row. The caller supplies the measured viewport;
 * targets that are already mounted preserve the current window verbatim. */
export function designLayerRevealWindow(input: {
  count: number;
  index: number;
  viewportHeight: number;
  current: DesignLayerWindow;
  rowHeight?: number;
  overscan?: number;
}): DesignLayerWindow {
  const count = Math.max(0, Math.floor(input.count));
  if (count <= 400) return { start: 0, end: count };
  const index = Math.min(count - 1, Math.max(0, Math.floor(input.index)));
  if (index >= input.current.start && index < input.current.end) {
    return input.current;
  }
  const rowHeight = Math.max(1, input.rowHeight ?? 28);
  return designLayerVirtualWindow({
    count,
    visibleTop: index * rowHeight,
    viewportHeight: input.viewportHeight,
    rowHeight,
    overscan: input.overscan,
  });
}

/** Keep the composite tree's sole tab stop on a mounted row. Rows are addressed
 * by panel key, so a frame row can hold the tab stop just like a layer row. */
export function designLayerRovingTabStop(
  renderedRowKeys: readonly string[],
  selectedRowKey: string | null | undefined,
): string | null {
  if (selectedRowKey && renderedRowKeys.includes(selectedRowKey)) {
    return selectedRowKey;
  }
  return renderedRowKeys[0] ?? null;
}

interface FlattenDesignLayerTreeOptions {
  /** Parent ids whose children join the row list. Every other container stays
   * folded, so an unopened document costs one row per root. Omit the option
   * entirely to flatten the complete tree. */
  expandedNodeIds?: ReadonlySet<string>;
}

export type DesignLayerHitMode =
  | "top-level"
  | "deepest"
  | "preserve"
  | "descend";

export function designLayerPathIds(
  nodes: readonly DesignRuntimeTreeNode[],
  nodeId: string,
): string[] {
  const visit = (
    node: DesignRuntimeTreeNode,
    ancestors: readonly string[],
  ): string[] | null => {
    const path = [...ancestors, node.oid];
    if (node.oid === nodeId) return path;
    for (const child of node.children) {
      const found = visit(child, path);
      if (found) return found;
    }
    return null;
  };
  for (const node of nodes) {
    const found = visit(node, []);
    if (found) return found;
  }
  return [];
}

/** Convert the deepest browser hit into predictable design-tool selection.
 * A normal click enters the top-level container, a repeated/double click
 * descends one level, and the platform modifier selects the deepest node. */
export function resolveDesignLayerHit(
  nodes: readonly DesignRuntimeTreeNode[],
  deepestNodeId: string,
  selectedNodeId: string | null | undefined,
  mode: DesignLayerHitMode,
): string | null {
  const path = designLayerPathIds(nodes, deepestNodeId);
  if (path.length === 0) return null;
  if (mode === "deepest") return path.at(-1) ?? null;
  if (mode === "top-level") return path[0] ?? null;
  const selectedIndex = selectedNodeId ? path.indexOf(selectedNodeId) : -1;
  if (mode === "preserve") {
    if (selectedIndex >= 0) return path[selectedIndex]!;
    const selectedPath = selectedNodeId
      ? designLayerPathIds(nodes, selectedNodeId)
      : [];
    if (selectedPath.length === 0) return path[0]!;
    return path[Math.min(selectedPath.length - 1, path.length - 1)]!;
  }
  if (selectedIndex >= 0) {
    return path[Math.min(selectedIndex + 1, path.length - 1)]!;
  }
  const selectedPath = selectedNodeId
    ? designLayerPathIds(nodes, selectedNodeId)
    : [];
  if (selectedPath.length === 0) return path[0]!;
  return path[Math.min(selectedPath.length, path.length - 1)]!;
}

export type DesignFrameBodyIntent = "plain" | "descend" | "deepest";

export type DesignFrameBodyTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "clear" }
  | { kind: "unresolved" };

/** A root that starts at the frame origin and spans it edge to edge is the
 * frame's body, not an element the pointer can mean. */
export function designFrameBodyRootCoverage(
  rect: DesignRuntimeRect,
  frameSize: { width: number; height: number },
): boolean {
  return (
    rect.x <= 1 &&
    rect.y <= 1 &&
    rect.width >= frameSize.width - 2 &&
    rect.height >= frameSize.height - 2
  );
}

/** Resolve a frame-body click from the deepest runtime hit, paper.design
 * style: the frame itself is never selected from its body — a body-like root
 * counts as empty canvas (clears the selection), plain clicks enter at the
 * root's children, repeated clicks descend, and the platform modifier reaches
 * the deepest node. Text frames have no label, so their root stays clickable.
 * An empty path means the local tree is stale; callers fall back to the
 * runtime's own hit modes. */
export function resolveDesignFrameBodyTarget(input: {
  nodes: readonly DesignRuntimeTreeNode[];
  deepestNodeId: string;
  deepestRect: DesignRuntimeRect;
  selectedNodeId: string | null | undefined;
  intent: DesignFrameBodyIntent;
  frameSize: { width: number; height: number };
  /** Fresh root rect when one is cached; used only for deeper hits. */
  rootRect?: DesignRuntimeRect | null;
  /** False for text frames, whose root is the content itself. */
  labeledFrame: boolean;
}): DesignFrameBodyTarget {
  const path = designLayerPathIds(input.nodes, input.deepestNodeId);
  if (path.length === 0) return { kind: "unresolved" };
  if (input.intent === "deepest") {
    return { kind: "node", nodeId: path.at(-1)! };
  }
  const singleRoot = input.nodes.length === 1;
  const rootIsFrameBody =
    input.labeledFrame &&
    singleRoot &&
    (path.length === 1
      ? designFrameBodyRootCoverage(input.deepestRect, input.frameSize)
      : input.rootRect
        ? designFrameBodyRootCoverage(input.rootRect, input.frameSize)
        : true);
  if (path.length === 1) {
    return rootIsFrameBody
      ? { kind: "clear" }
      : { kind: "node", nodeId: path[0]! };
  }
  const floor = rootIsFrameBody ? 1 : 0;
  const selectedIndex = input.selectedNodeId
    ? path.indexOf(input.selectedNodeId)
    : -1;
  const selectedPath =
    selectedIndex < 0 && input.selectedNodeId
      ? designLayerPathIds(input.nodes, input.selectedNodeId)
      : [];
  const clamp = (index: number) =>
    path[Math.max(floor, Math.min(index, path.length - 1))]!;
  if (input.intent === "descend") {
    const base =
      selectedIndex >= 0
        ? selectedIndex + 1
        : selectedPath.length === 0
          ? floor
          : selectedPath.length;
    return { kind: "node", nodeId: clamp(base) };
  }
  if (selectedIndex >= 0) {
    return { kind: "node", nodeId: clamp(selectedIndex) };
  }
  const depthIndex =
    selectedPath.length === 0
      ? floor
      : Math.min(selectedPath.length - 1, path.length - 1);
  return { kind: "node", nodeId: clamp(depthIndex) };
}

export function flattenDesignLayerTree(
  nodes: readonly DesignRuntimeTreeNode[],
  options: FlattenDesignLayerTreeOptions = {},
): FlatDesignLayer[] {
  const flattened: FlatDesignLayer[] = [];
  const expandedNodeIds = options.expandedNodeIds;

  const row = (
    node: DesignRuntimeTreeNode,
    depth: number,
    parentOid: string | null,
    hiddenByAncestor: boolean,
  ): FlatDesignLayer => ({
    node,
    depth,
    parentOid,
    hasChildren: node.children.length > 0,
    hiddenByAncestor,
  });

  const visitVisible = (
    node: DesignRuntimeTreeNode,
    depth: number,
    parentOid: string | null,
    hiddenByAncestor: boolean,
  ) => {
    flattened.push(row(node, depth, parentOid, hiddenByAncestor));
    if (expandedNodeIds && !expandedNodeIds.has(node.oid)) return;
    for (const child of node.children) {
      visitVisible(
        child,
        depth + 1,
        node.oid,
        hiddenByAncestor || !node.visible,
      );
    }
  };

  for (const node of nodes) visitVisible(node, 0, null, false);
  return flattened;
}

/** Every descendant of any selected node, excluding the selected nodes
 * themselves. The Layers panel tints these rows so selecting a container
 * visibly selects everything it owns, exactly like Figma. */
export function designLayerSelectionSubtreeIds(
  nodes: readonly DesignRuntimeTreeNode[],
  selectedNodeIds: readonly string[],
): Set<string> {
  const subtree = new Set<string>();
  if (selectedNodeIds.length === 0) return subtree;
  const selected = new Set(selectedNodeIds);
  const visit = (node: DesignRuntimeTreeNode, insideSelection: boolean) => {
    if (insideSelection && !selected.has(node.oid)) subtree.add(node.oid);
    const nextInside = insideSelection || selected.has(node.oid);
    for (const child of node.children) visit(child, nextInside);
  };
  for (const node of nodes) visit(node, false);
  return subtree;
}

/** Where one row sits inside a run of consecutive selection-owned rows. */
export type DesignLayerBlockEdge = "single" | "top" | "middle" | "bottom";

/** Everything the selection owns paints as one rounded container, Figma-style:
 * the first row of a consecutive run rounds its top, the last rounds its
 * bottom, and the rows between stay square so the fill reads as a single block.
 * A selected frame leads its own run; a lone selected leaf stays fully rounded.
 * Membership arrives as one flag per panel row — frame rows included — so a run
 * can start on a frame and end on the last layer it owns. */
export function designLayerBlockEdges(
  members: readonly boolean[],
): (DesignLayerBlockEdge | null)[] {
  return members.map((member, index) => {
    if (!member) return null;
    const previous = members[index - 1] === true;
    const next = members[index + 1] === true;
    if (!previous && !next) return "single";
    if (!previous) return "top";
    if (!next) return "bottom";
    return "middle";
  });
}

/** All expandable node ids, used by the panel's bounded Collapse all action. */
export function collectDesignLayerParentIds(
  nodes: readonly DesignRuntimeTreeNode[],
): Set<string> {
  const ids = new Set<string>();
  const visit = (node: DesignRuntimeTreeNode) => {
    if (node.children.length > 0) ids.add(node.oid);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return ids;
}

/** Root-to-parent identity path for synchronously revealing canvas selection. */
export function designLayerAncestorIds(
  nodes: readonly DesignRuntimeTreeNode[],
  nodeId: string | null | undefined,
): string[] {
  if (!nodeId) return [];
  const visit = (
    node: DesignRuntimeTreeNode,
    ancestors: readonly string[],
  ): string[] | null => {
    if (node.oid === nodeId) return [...ancestors];
    const nextAncestors = [...ancestors, node.oid];
    for (const child of node.children) {
      const found = visit(child, nextAncestors);
      if (found) return found;
    }
    return null;
  };
  for (const node of nodes) {
    const found = visit(node, []);
    if (found) return found;
  }
  return [];
}

/** Union of the root-to-parent paths of several nodes in one walk, in document
 * order. Group selections reveal their Layers paths from a single tree pass
 * instead of one pass per member. */
export function designLayerAncestorIdsFor(
  nodes: readonly DesignRuntimeTreeNode[],
  nodeIds: readonly string[],
): string[] {
  const targets = new Set(nodeIds);
  if (targets.size === 0) return [];
  const ancestors: string[] = [];
  const seen = new Set<string>();
  const visit = (node: DesignRuntimeTreeNode, path: readonly string[]) => {
    if (targets.has(node.oid)) {
      for (const ancestorId of path) {
        if (seen.has(ancestorId)) continue;
        seen.add(ancestorId);
        ancestors.push(ancestorId);
      }
    }
    if (node.children.length === 0) return;
    const nextPath = [...path, node.oid];
    for (const child of node.children) visit(child, nextPath);
  };
  for (const node of nodes) visit(node, []);
  return ancestors;
}

function designLayerLocation(
  nodes: readonly DesignRuntimeTreeNode[],
  nodeId: string,
): {
  node: DesignRuntimeTreeNode;
  parentOid: string | null;
  siblings: readonly DesignRuntimeTreeNode[];
  index: number;
} | null {
  const visit = (
    siblings: readonly DesignRuntimeTreeNode[],
    parentOid: string | null,
  ): ReturnType<typeof designLayerLocation> => {
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index]!;
      if (node.oid === nodeId) return { node, parentOid, siblings, index };
      const found = visit(node.children, node.oid);
      if (found) return found;
    }
    return null;
  };
  return visit(nodes, null);
}

export function designLayerParentId(
  nodes: readonly DesignRuntimeTreeNode[],
  nodeId: string,
): string | null {
  return designLayerLocation(nodes, nodeId)?.parentOid ?? null;
}

export function designLayerChildId(
  nodes: readonly DesignRuntimeTreeNode[],
  nodeId: string,
): string | null {
  return designLayerLocation(nodes, nodeId)?.node.children[0]?.oid ?? null;
}

export function designLayerSiblingId(
  nodes: readonly DesignRuntimeTreeNode[],
  nodeId: string,
  direction: -1 | 1,
): string | null {
  const location = designLayerLocation(nodes, nodeId);
  if (!location || location.siblings.length === 0) return null;
  const nextIndex =
    (location.index + direction + location.siblings.length) %
    location.siblings.length;
  return location.siblings[nextIndex]?.oid ?? null;
}

/** Stable sibling identities used by snapping and Option-distance overlays.
 * The selected layer itself is deliberately omitted; root layers are peers in
 * exactly the same way as children owned by a nested container. */
export function designLayerPeerIds(
  nodes: readonly DesignRuntimeTreeNode[],
  nodeId: string,
): string[] {
  const location = designLayerLocation(nodes, nodeId);
  if (!location) return [];
  return location.siblings
    .filter((node) => node.oid !== nodeId && node.visible)
    .map((node) => node.oid);
}

/** Group mutations must not apply twice when both a container and one of its
 * descendants are selected. Preserve caller order while retaining only the
 * highest selected owner in each branch. */
export function designLayerTopLevelSelectionIds(
  nodes: readonly DesignRuntimeTreeNode[],
  nodeIds: readonly string[],
): string[] {
  const selected = new Set(nodeIds);
  return [...new Set(nodeIds)].filter((nodeId) => {
    const path = designLayerPathIds(nodes, nodeId);
    return !path.slice(0, -1).some((ancestorId) => selected.has(ancestorId));
  });
}

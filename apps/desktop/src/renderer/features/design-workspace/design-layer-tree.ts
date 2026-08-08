import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";

export interface FlatDesignLayer {
  node: DesignRuntimeTreeNode;
  depth: number;
  parentOid: string | null;
  hasChildren: boolean;
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

interface FlattenDesignLayerTreeOptions {
  /** Parent ids whose descendants are omitted outside an active search. */
  collapsedNodeIds?: ReadonlySet<string>;
  /** Case-insensitive match across the human label, element type, and text. */
  query?: string;
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

export function flattenDesignLayerTree(
  nodes: readonly DesignRuntimeTreeNode[],
  options: FlattenDesignLayerTreeOptions = {},
): FlatDesignLayer[] {
  const flattened: FlatDesignLayer[] = [];
  const collapsedNodeIds = options.collapsedNodeIds ?? new Set<string>();
  const query = options.query?.trim().toLocaleLowerCase() ?? "";

  const row = (
    node: DesignRuntimeTreeNode,
    depth: number,
    parentOid: string | null,
  ): FlatDesignLayer => ({
    node,
    depth,
    parentOid,
    hasChildren: node.children.length > 0,
  });

  const visitVisible = (
    node: DesignRuntimeTreeNode,
    depth: number,
    parentOid: string | null,
  ) => {
    flattened.push(row(node, depth, parentOid));
    if (collapsedNodeIds.has(node.oid)) return;
    for (const child of node.children) {
      visitVisible(child, depth + 1, node.oid);
    }
  };

  /** Search ignores collapsed state and keeps the ancestry of every hit. */
  const matchingBranch = (
    node: DesignRuntimeTreeNode,
    depth: number,
    parentOid: string | null,
  ): FlatDesignLayer[] => {
    const children = node.children.flatMap((child) =>
      matchingBranch(child, depth + 1, node.oid),
    );
    const matches = [node.name, node.tag, node.text ?? ""].some((value) =>
      value.toLocaleLowerCase().includes(query),
    );
    return matches || children.length > 0
      ? [row(node, depth, parentOid), ...children]
      : [];
  };

  if (query) {
    for (const node of nodes) flattened.push(...matchingBranch(node, 0, null));
  } else {
    for (const node of nodes) visitVisible(node, 0, null);
  }
  return flattened;
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

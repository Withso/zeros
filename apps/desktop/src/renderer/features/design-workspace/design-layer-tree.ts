import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";

export interface FlatDesignLayer {
  node: DesignRuntimeTreeNode;
  depth: number;
  parentOid: string | null;
  hasChildren: boolean;
}

interface FlattenDesignLayerTreeOptions {
  /** Parent ids whose descendants are omitted outside an active search. */
  collapsedNodeIds?: ReadonlySet<string>;
  /** Case-insensitive match across the human label, element type, and text. */
  query?: string;
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

import type { DesignRuntimeTreeNode } from "@zeros/core/design-runtime";

export interface FlatDesignLayer {
  node: DesignRuntimeTreeNode;
  depth: number;
  parentOid: string | null;
}

export function flattenDesignLayerTree(
  nodes: readonly DesignRuntimeTreeNode[],
): FlatDesignLayer[] {
  const flattened: FlatDesignLayer[] = [];
  const visit = (
    node: DesignRuntimeTreeNode,
    depth: number,
    parentOid: string | null,
  ) => {
    flattened.push({ node, depth, parentOid });
    for (const child of node.children) visit(child, depth + 1, node.oid);
  };
  for (const node of nodes) visit(node, 0, null);
  return flattened;
}

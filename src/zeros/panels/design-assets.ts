export const DESIGN_ASSET_DRAG_TYPE = "application/x-zeros-design-asset";

export function hasDesignAssetDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(DESIGN_ASSET_DRAG_TYPE);
}

export function readDesignAssetDrag(dataTransfer: DataTransfer): string | null {
  const path = dataTransfer.getData(DESIGN_ASSET_DRAG_TYPE).trim();
  return path.startsWith("assets/") ? path : null;
}

export const MAX_INLINE_ASSET_BYTES_PER_FRAME = 12 * 1024 * 1024;
export const MAX_STYLESHEETS_PER_FRAME = 128;
export const MAX_SANITIZED_RENDER_BYTES = 15 * 1024 * 1024;
export const MAX_COMPOSED_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_DESIGN_TEXT_BYTES = 2 * 1024 * 1024;

export class DesignRenderBudgetError extends Error {
  readonly code = "DESIGN_RENDER_BUDGET_EXCEEDED";

  constructor(message: string) {
    super(message);
    this.name = "DesignRenderBudgetError";
  }
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function assertRenderByteLimit(
  value: string,
  maximum: number,
  message: string,
): void {
  if (utf8Bytes(value) > maximum) {
    throw new DesignRenderBudgetError(message);
  }
}

export interface DesignTextInsertionMarkup {
  nodeId: string;
  text: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Flow is the default inside flex/grid parents; absolute placement is an
   * explicit opt-out equivalent to Figma's Ignore auto layout. */
  placement?: "absolute" | "flow";
}

const DESIGN_TEXT_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function finiteCoordinate(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Design text ${name} must be finite.`);
  }
  return Math.round(value * 100) / 100;
}

function escapeDesignText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build the only markup emitted by the canvas Text tool. Values are bounded
 * before the engine's semantic HTML operation performs its own validation. */
export function createDesignTextMarkup(
  input: DesignTextInsertionMarkup,
): string {
  if (!DESIGN_TEXT_NODE_ID.test(input.nodeId)) {
    throw new Error("Design text node id is invalid.");
  }
  if (input.text.length > 10_000) {
    throw new Error("Design text is too long.");
  }
  const x = finiteCoordinate(input.x, "x");
  const y = finiteCoordinate(input.y, "y");
  const placement =
    input.placement === "flow"
      ? ""
      : `position:absolute;left:${x}px;top:${y}px;`;
  const size =
    input.width === undefined
      ? "width:max-content;"
      : `width:${Math.max(1, finiteCoordinate(input.width, "width"))}px;min-height:${Math.max(
          1,
          finiteCoordinate(input.height ?? 1, "height"),
        )}px;`;
  return `<div data-oid="${input.nodeId}" style="${placement}${size}margin:0;white-space:pre-wrap;overflow-wrap:anywhere;">${escapeDesignText(input.text)}</div>`;
}

export function createDesignTextNodeId(): string {
  return `text-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

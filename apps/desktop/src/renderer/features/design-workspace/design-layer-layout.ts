export type DesignFrameLayoutIconKind =
  | "frame"
  | "flex-vertical"
  | "flex-horizontal"
  | "grid";

/** Designer-facing layout identity for any layer represented as a Frame.
 * Reverse flex directions keep the same axis icon; ordering belongs to the
 * Style controls, while the Layers icon communicates the container model. */
export function designFrameLayoutIconKind(input: {
  display?: string;
  flexDirection?: string;
}): DesignFrameLayoutIconKind {
  const display = input.display?.trim().toLocaleLowerCase();
  if (display === "grid" || display === "inline-grid") return "grid";
  if (display !== "flex" && display !== "inline-flex") return "frame";
  const direction = input.flexDirection?.trim().toLocaleLowerCase();
  return direction === "column" || direction === "column-reverse"
    ? "flex-vertical"
    : "flex-horizontal";
}

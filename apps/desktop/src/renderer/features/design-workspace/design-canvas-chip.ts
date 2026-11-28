// The one canvas readout chip: selection and creation size, rotation, an
// agent's draft status and spacing values share one geometry, 16px tall with
// 11px medium text, 4px sides, 4px corners and no edge. Its tone says what it
// reads out; a readout that scales with the canvas sets the same geometry
// from DESIGN_CANVAS_CHIP_PX instead.

export const DESIGN_CANVAS_CHIP_CLS =
  "text-2xxs inline-flex h-4 items-center gap-1 rounded-sm px-1 leading-4 font-medium whitespace-nowrap tabular-nums";

export const DESIGN_CANVAS_CHIP_PX = {
  height: 16,
  paddingInline: 4,
  radius: 4,
  fontSize: 11,
} as const;

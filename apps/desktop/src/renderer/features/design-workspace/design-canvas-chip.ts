// The one canvas readout chip: selection and creation size, rotation, an
// agent's draft status and spacing values share one geometry, 18px tall with
// 11px medium text, 6px sides, 4px corners and no edge. Its tone says what it
// reads out; a readout that scales with the canvas sets the same geometry
// from DESIGN_CANVAS_CHIP_PX instead.

export const DESIGN_CANVAS_CHIP_CLS =
  "text-2xxs inline-flex h-4.5 items-center gap-1 rounded-sm px-1.5 leading-4.5 font-medium whitespace-nowrap tabular-nums";

export const DESIGN_CANVAS_CHIP_PX = {
  height: 18,
  paddingInline: 6,
  radius: 4,
  fontSize: 11,
} as const;

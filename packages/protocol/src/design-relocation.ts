import { z } from "zod";
import { DESIGN_MAX_FRAMES_PER_PAGE } from "./design-pages";
import { isDesignComponentVariantName } from "./design-path";

/** Never send a copy to an older engine as a move that would remove its source. */
export const DESIGN_COPY_PLACEMENT_CAPABILITY = "design.copy-placement.v1";
export const DESIGN_LINKED_COMPONENT_COPY_CAPABILITY = "design.linked-component-copy.v1";

export const designComponentCopySchema = z.object({
  variant: z.string().nullable().refine((value) => value === null || isDesignComponentVariantName(value)),
}).strict();

export type DesignComponentCopy = z.infer<typeof designComponentCopySchema>;

export const DESIGN_RELOCATION_INHERITED_PROPERTIES = [
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "font-kerning",
  "font-feature-settings",
  "font-variation-settings",
  "font-optical-sizing",
  "font-size-adjust",
  "font-synthesis",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "text-align",
  "text-transform",
  "text-shadow",
  "text-rendering",
  "text-orientation",
  "text-combine-upright",
  "white-space",
  "word-break",
  "overflow-wrap",
  "writing-mode",
  "direction",
  "hyphens",
  "tab-size",
  "visibility",
  "cursor",
  "list-style-type",
  "list-style-position",
  "list-style-image",
  "quotes",
  "orphans",
  "widows",
  "color-scheme",
  "border-collapse",
  "border-spacing",
  "caption-side",
  "empty-cells",
  "-webkit-text-fill-color",
  "-webkit-text-stroke-color",
  "-webkit-text-stroke-width",
] as const;

export const DESIGN_RELOCATION_MAX_STYLES = 64;

const relocationDefaults = {
  position: "absolute",
  inset: "0 auto auto 0",
  left: "0px",
  top: "0px",
  margin: "0",
  width: "0px",
  height: "0px",
  "box-sizing": "border-box",
  "min-width": "0",
  "min-height": "0",
  "max-width": "none",
  "max-height": "none",
  transform: "none",
  "transform-origin": "0 0",
  rotate: "none",
  scale: "none",
  translate: "none",
};

export const DESIGN_RELOCATION_MAX_INHERITED_STYLES =
  DESIGN_RELOCATION_MAX_STYLES - Object.keys(relocationDefaults).length;

const inherited = new Set<string>(DESIGN_RELOCATION_INHERITED_PROPERTIES);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
export const designRelocationSchema = z
  .object({
    width: z.number().finite().positive().max(16_384),
    height: z.number().finite().positive().max(16_384),
    matrix: z
      .tuple([
        coordinate,
        coordinate,
        coordinate,
        coordinate,
        coordinate,
        coordinate,
      ])
      .refine(
        ([a, b, c, d]) => Math.abs(a * d - b * c) >= 0.000001,
        "The relocation transform must be invertible.",
      ),
    inheritedStyles: z
      .record(z.string(), z.string().max(2048))
      .refine(
        (styles) =>
          Object.keys({ ...styles, ...relocationDefaults }).length <= DESIGN_RELOCATION_MAX_STYLES &&
          Object.keys(styles).every(
            (key) => inherited.has(key) || /^--[A-Za-z0-9_-]{1,126}$/.test(key),
          ),
        "Only bounded inherited appearance can accompany a relocation.",
      ),
  })
  .strict();

export type DesignRelocation = z.infer<typeof designRelocationSchema>;

const relocationPixels = (value: number) =>
  `${Math.round(value * 100_000_000) / 100_000_000 || 0}px`;

/** Store offsets in left and top so the inspector sees them and they do not become stray shifts in a flow. */
function relocationPose([a, b, c, d]: DesignRelocation["matrix"]): string {
  const near = (value: number, target: number) => Math.abs(value - target) < 1e-12;
  return near(a, 1) && near(b, 0) && near(c, 0) && near(d, 1)
    ? "none"
    : `matrix(${[a, b, c, d, 0, 0].join(",")})`;
}

export function designIntrinsicPlacementStyles(size?: { width?: string | null; height?: string | null }): Record<string, string> {
  const styles: Record<string, string> = {};
  if (size?.width && ["auto", "min-content", "max-content", "fit-content"].includes(size.width)) styles.width = size.width;
  if (size?.height && ["auto", "min-content", "max-content", "fit-content"].includes(size.height)) styles.height = size.height;
  return styles;
}

export function designRelocationStyles(
  relocation: DesignRelocation,
  sizing?: Readonly<Record<string, string | null | undefined>>,
): Record<string, string> {
  const styles = {
    ...relocation.inheritedStyles,
    ...relocationDefaults,
    left: relocationPixels(relocation.matrix[4]),
    top: relocationPixels(relocation.matrix[5]),
    width: `${relocation.width}px`,
    height: `${relocation.height}px`,
    ...designIntrinsicPlacementStyles(sizing),
    transform: relocationPose(relocation.matrix),
  };
  if (Object.keys(styles).length > DESIGN_RELOCATION_MAX_STYLES)
    throw new Error(`The complete relocation styles must contain at most ${DESIGN_RELOCATION_MAX_STYLES} properties.`);
  return styles;
}

const relocationFlowProperties = [
  "order",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-self",
  "justify-self",
  "grid-column",
  "grid-row",
] as const;

/** Flow keeps the layer's appearance, size and pose but drops absolute position; inherited values are considered in their original order. */
export function designRelocationFlowStyles(
  relocation: DesignRelocation,
  flow: Readonly<Record<string, string | null | undefined>>,
): Record<string, string> {
  if (flow.position !== "relative" && flow.position !== "static")
    throw new Error("A relocation joins a flow slot only with relative positioning.");
  const placement: Record<string, string> = {
    position: "relative",
    inset: "auto",
    margin: "0",
    width: `${relocation.width}px`,
    height: `${relocation.height}px`,
    ...designIntrinsicPlacementStyles(flow),
    "box-sizing": "border-box",
    "min-width": "0",
    "min-height": "0",
    "max-width": "none",
    "max-height": "none",
    transform: relocationPose(relocation.matrix),
    "transform-origin": "0 0",
    rotate: "none",
    scale: "none",
    translate: "none",
  };
  for (const property of relocationFlowProperties) {
    const value = flow[property];
    if (typeof value === "string" && value.length <= 128) placement[property] = value;
  }
  const inherited: Record<string, string> = {};
  let room = DESIGN_RELOCATION_MAX_STYLES - Object.keys(placement).length;
  for (const [property, value] of Object.entries(relocation.inheritedStyles)) {
    if (room <= 0) break;
    if (property in placement) continue;
    inherited[property] = value;
    room--;
  }
  return { ...inherited, ...placement };
}

export const designMovementGuardSchema = z
  .object({
    sourceVersion: z.string().min(1).max(128),
    geometry: z
      .object({
        x: coordinate,
        y: coordinate,
        w: z.number().finite().positive().max(16_384),
        h: z.number().finite().positive().max(16_384),
        z: z.number().int().min(0).max(DESIGN_MAX_FRAMES_PER_PAGE),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DesignMovementGuard = z.infer<typeof designMovementGuardSchema>;

/** Match the canvas selection bound. */
export const DESIGN_FRAMES_MOVE_LIMIT = 32;
const frameGeometry = z
  .object({
    x: coordinate,
    y: coordinate,
    w: z.number().finite().positive().max(16_384),
    h: z.number().finite().positive().max(16_384),
    z: z.number().int().min(0).max(DESIGN_MAX_FRAMES_PER_PAGE),
  })
  .strict();
/** Stale source geometry rejects the entire move before the canvas write. */
export const designFramesMoveSchema = z
  .array(z.object({ frame: z.string().min(1).max(255), from: frameGeometry, to: frameGeometry }).strict())
  .min(1)
  .max(DESIGN_FRAMES_MOVE_LIMIT)
  .refine((moves) => new Set(moves.map((move) => move.frame)).size === moves.length, "Each frame moves once.");
export type DesignFramesMove = z.infer<typeof designFramesMoveSchema>;

export interface DesignRuntimeRelocationContext {
  /** Store deltas from the source body for standard properties and from the root for custom properties. */
  inheritedStyles: Record<string, string>;
  /** Older runtimes omit the body's base styles and send all inherited values as deltas. */
  baseStyles?: Record<string, string>;
  /** Drop-parent root values for custom properties, empty when unset. */
  rootStyles?: Record<string, string>;
  unsupported: string[];
}

/** Carry only what the destination lacks; an unmeasured parent carries everything, an omitted parent shares the source base, and same-document drops can restore root custom properties. */
export function designRelocationInheritedStyles(
  context: DesignRuntimeRelocationContext,
  parent?: DesignRuntimeRelocationContext | null,
  sameDocument = false,
): Record<string, string> {
  const result: Record<string, string> = {};
  let count = 0;
  const add = (property: string, value: string) => {
    if (count >= DESIGN_RELOCATION_MAX_INHERITED_STYLES || property in result) return;
    result[property] = value;
    count++;
  };
  const own = new Map(Object.entries(context.inheritedStyles));
  for (const [property, value] of Object.entries(context.baseStyles ?? {}))
    if (!own.has(property)) own.set(property, value);
  const given: Readonly<Record<string, string>> | null =
    parent === undefined
      ? (context.baseStyles ?? {})
      : parent && { ...parent.baseStyles, ...parent.inheritedStyles };
  for (const [property, value] of own)
    if (!given || given[property] !== value) add(property, value);
  if (sameDocument && parent && given)
    for (const [property, value] of Object.entries(parent.rootStyles ?? {}))
      if (!own.has(property) && given[property] !== value) add(property, value || "initial");
  return result;
}

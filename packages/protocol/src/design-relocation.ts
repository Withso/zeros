import { z } from "zod";

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

/** Every style one relocation writes on the moved root. */
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

/** Inherited values one relocation carries beside its placement styles. */
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

export function designRelocationStyles(
  relocation: DesignRelocation,
): Record<string, string> {
  const styles = {
    ...relocation.inheritedStyles,
    ...relocationDefaults,
    width: `${relocation.width}px`,
    height: `${relocation.height}px`,
    transform: `matrix(${relocation.matrix.join(",")})`,
  };
  if (Object.keys(styles).length > DESIGN_RELOCATION_MAX_STYLES)
    throw new Error(`The complete relocation styles must contain at most ${DESIGN_RELOCATION_MAX_STYLES} properties.`);
  return styles;
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
        z: z.number().int().min(0).max(256),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DesignMovementGuard = z.infer<typeof designMovementGuardSchema>;

/** The most frames one canvas move carries, the canvas selection bound. */
export const DESIGN_FRAMES_MOVE_LIMIT = 32;
const frameGeometry = z
  .object({
    x: coordinate,
    y: coordinate,
    w: z.number().finite().positive().max(16_384),
    h: z.number().finite().positive().max(16_384),
    z: z.number().int().min(0).max(256),
  })
  .strict();
/** Several selected canvas frames moved together: each names the geometry
 * it was measured at, so a stale gesture moves nothing. */
export const designFramesMoveSchema = z
  .array(z.object({ frame: z.string().min(1).max(255), from: frameGeometry, to: frameGeometry }).strict())
  .min(1)
  .max(DESIGN_FRAMES_MOVE_LIMIT)
  .refine((moves) => new Set(moves.map((move) => move.frame)).size === moves.length, "Each frame moves once.");
export type DesignFramesMove = z.infer<typeof designFramesMoveSchema>;

export interface DesignRuntimeRelocationContext {
  /** Inherited values the layer's own context gives it beyond its frame's
   * base: standard properties unlike the body's, custom properties unlike
   * the root's. Shared base values come from the destination's own styles. */
  inheritedStyles: Record<string, string>;
  /** The frame body's standard inherited values those were compared with.
   * Older runtimes omit it; they carried every inherited value instead. */
  baseStyles?: Record<string, string>;
  /** The document root's values ("" where it sets none) of the custom
   * properties in inheritedStyles. As a drop parent, these are what a layer
   * of the same document that does not set them has. */
  rootStyles?: Record<string, string>;
  unsupported: string[];
}

/** The inherited values a relocation carries so the layer looks the same in
 * its drop parent: each of the layer's values that the parent's own values
 * (its context over its frame's base) would not give it. Within one document
 * (`sameDocument`), a custom property the parent sets and the layer takes
 * from the root travels at the root's value. `parent` null (unmeasured)
 * carries every value; omitted, the parent is a new frame's body, which
 * copies the source's head and so gives the source's base. Bounded, the
 * layer's own context first. */
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

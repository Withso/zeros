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
          Object.keys({ ...styles, ...relocationDefaults }).length <= 64 &&
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
  if (Object.keys(styles).length > 64)
    throw new Error("The complete relocation styles must contain at most 64 properties.");
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

export interface DesignRuntimeRelocationContext {
  inheritedStyles: Record<string, string>;
  unsupported: string[];
}

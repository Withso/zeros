import { z } from "zod";

export const DESIGN_RELOCATION_INHERITED_PROPERTIES = [
  "color", "font-family", "font-size", "font-weight", "font-style", "font-stretch",
  "font-variant", "font-kerning", "font-feature-settings", "font-variation-settings",
  "font-optical-sizing", "font-size-adjust", "font-synthesis", "line-height",
  "letter-spacing", "word-spacing", "text-indent", "text-align", "text-transform",
  "text-shadow", "text-rendering", "text-orientation", "text-combine-upright",
  "white-space", "word-break", "overflow-wrap", "writing-mode", "direction",
  "hyphens", "tab-size", "visibility", "cursor", "list-style-type", "list-style-position",
  "list-style-image", "quotes", "orphans", "widows", "color-scheme",
  "-webkit-text-fill-color", "-webkit-text-stroke-color", "-webkit-text-stroke-width",
] as const;

const inherited = new Set<string>(DESIGN_RELOCATION_INHERITED_PROPERTIES);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
export const designRelocationSchema = z.object({
  width: z.number().finite().positive().max(16_384),
  height: z.number().finite().positive().max(16_384),
  matrix: z.tuple([coordinate, coordinate, coordinate, coordinate, coordinate, coordinate])
    .refine(([a, b, c, d]) => Math.abs(a * d - b * c) >= 0.000001, "The relocation transform must be invertible."),
  inheritedStyles: z.record(z.string(), z.string().max(2048)).refine((styles) =>
    Object.keys(styles).length <= 64 && Object.keys(styles).every((key) => inherited.has(key) || /^--[A-Za-z0-9_-]{1,126}$/.test(key)),
  "Only bounded inherited appearance can accompany a relocation."),
}).strict();

export type DesignRelocation = z.infer<typeof designRelocationSchema>;

export interface DesignRuntimeRelocationContext {
  inheritedStyles: Record<string, string>;
  unsupported: string[];
}

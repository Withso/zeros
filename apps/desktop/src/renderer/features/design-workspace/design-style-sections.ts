// ============================================
// MODULE: Style panel section order
// PURPOSE: The one order the Style panel draws its sections in, by layer
//          kind. A text layer is mostly its type, so Typography comes before
//          its Fill (the text colour); any other layer reads Fill first.
// USED IN: DesignStyleEditor and DesignInspector (Export)
// ============================================

export type DesignStyleSectionId =
  | "position"
  | "layout"
  | "appearance"
  | "typography"
  | "fill"
  | "stroke"
  | "shadow"
  | "blur"
  | "transform"
  | "transition"
  | "motion"
  | "more-styles"
  | "export";

export type DesignStyleLayerKind = "text" | "other";

const TAIL: readonly DesignStyleSectionId[] = [
  "stroke",
  "shadow",
  "blur",
  "transform",
  "transition",
  "motion",
  "more-styles",
  "export",
];

const ORDERS: Readonly<Record<DesignStyleLayerKind, readonly DesignStyleSectionId[]>> = {
  text: Object.freeze(["position", "layout", "appearance", "typography", "fill", ...TAIL]),
  other: Object.freeze(["position", "layout", "appearance", "fill", "typography", ...TAIL]),
};

/** Sections that do not apply to a layer are left out by their owner; this
 * only fixes the order of those that render. */
export function designStyleSectionOrder(
  kind: DesignStyleLayerKind,
): readonly DesignStyleSectionId[] {
  return ORDERS[kind];
}

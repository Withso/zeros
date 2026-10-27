export type DesignLayerLabel = "Frame" | "Text" | "Image" | "Vector Path";

interface DesignRuntimeLayerLabelInput {
  tag: string;
  text?: string | null;
  children?: readonly unknown[];
  textEditable?: boolean;
}

const DESIGN_IMAGE_TAGS = new Set([
  "canvas",
  "img",
  "picture",
  "source",
  "video",
]);

const DESIGN_VECTOR_TAGS = new Set([
  "circle",
  "clippath",
  "defs",
  "ellipse",
  "g",
  "line",
  "mask",
  "path",
  "polygon",
  "polyline",
  "rect",
  "symbol",
  "svg",
  "textpath",
  "use",
]);

const DESIGN_TEXT_TAGS = new Set([
  "b",
  "blockquote",
  "cite",
  "code",
  "em",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "i",
  "label",
  "legend",
  "mark",
  "p",
  "pre",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
]);

/** Collapse source-specific HTML into the small vocabulary designers use.
 * Runtime ids, tags, and names remain unchanged; this is presentation only. */
export function designRuntimeLayerLabel(
  layer: DesignRuntimeLayerLabelInput,
): DesignLayerLabel {
  const tag = layer.tag.trim().toLocaleLowerCase();
  if (DESIGN_IMAGE_TAGS.has(tag)) return "Image";
  if (DESIGN_VECTOR_TAGS.has(tag)) return "Vector Path";
  if (DESIGN_TEXT_TAGS.has(tag)) return "Text";

  const directText = Boolean(layer.text?.trim());
  const knownLeaf = layer.children?.length === 0;
  if (directText && (knownLeaf || layer.textEditable === true)) return "Text";
  return "Frame";
}

export function designFrameLayerLabel(
  kind: "frame" | "text" | undefined,
): DesignLayerLabel {
  return kind === "text" ? "Text" : "Frame";
}

/** Names are authored metadata; the type vocabulary above still owns icons
 * and editing capabilities, regardless of what a person calls the layer. */
export function designRuntimeLayerDisplayName(
  layer: DesignRuntimeLayerLabelInput & { name?: string | null; layerName?: string },
): string {
  const authored = layer.layerName?.trim();
  if (authored) return authored;
  const name = layer.name?.trim();
  return name && name !== layer.tag
    ? name
    : designRuntimeLayerLabel(layer);
}

export function designFrameDisplayName(frame: {
  title?: string | null;
  kind?: "frame" | "text";
}): string {
  return frame.title?.trim() || designFrameLayerLabel(frame.kind);
}

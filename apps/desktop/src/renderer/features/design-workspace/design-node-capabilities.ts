import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { designRuntimeLayerLabel } from "./design-layer-label";

/** Text replacement is destructive for container nodes. Treat an omitted
 * capability from an older runtime as unsafe instead of guessing from a tag or
 * truncated text preview. An empty container remains a frame even when its
 * childless markup could safely accept text. */
export function canEditDesignNodeText(
  details: DesignRuntimeNodeDetails | null | undefined,
): details is DesignRuntimeNodeDetails & { textEditable: true } {
  return (
    details?.textEditable === true &&
    designRuntimeLayerLabel(details) === "Text"
  );
}

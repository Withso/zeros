import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

/** Text replacement is destructive for container nodes. Treat an omitted
 * capability from an older runtime as unsafe instead of guessing from a tag or
 * truncated text preview. */
export function canEditDesignNodeText(
  details: DesignRuntimeNodeDetails | null | undefined,
): details is DesignRuntimeNodeDetails & { textEditable: true } {
  return details?.textEditable === true;
}

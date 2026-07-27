export type MissingFileDisposition = "present" | "review-diff" | "show-missing";

/** Keep explicit File tabs stable when another tool deletes their path. The
 * Changes surface owns list-order advancement; a standalone File tab remains a
 * durable user destination and explains that its source is gone. An explicit
 * deletion change still renders its useful Git patch. */
export function resolveMissingFileDisposition(args: {
  fileMissing: boolean;
  diffIntent: boolean;
  diffPendingOrAvailable: boolean;
}): MissingFileDisposition {
  if (!args.fileMissing) return "present";
  if (args.diffIntent && args.diffPendingOrAvailable) return "review-diff";
  return "show-missing";
}

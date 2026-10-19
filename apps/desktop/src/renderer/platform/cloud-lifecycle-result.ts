/** Foreground observation ended; the accepted cloud action remains CP-owned.
 * Neither variant is evidence that a workspace was archived, deleted or ready. */
export type CloudLifecycleDeferred =
  | { kind: "background_pending"; operationId: string }
  | { kind: "retired" };

export function isCloudLifecycleDeferred(value: unknown): value is CloudLifecycleDeferred {
  return typeof value === "object" && value !== null && "kind" in value &&
    (value.kind === "retired" || value.kind === "background_pending");
}

export const FRESH_WORKSPACE_WINDOW_MS = 30_000;

/** A workspace is eligible for one-time UI defaults only when it was created
 * after this renderer session started. The age bound alone is insufficient: an
 * app restart shortly after creation would otherwise erase restored tab state. */
export function shouldInitializeFreshWorkspace(args: {
  createdAt: unknown;
  sessionStartedAt: number;
  now?: number;
}): boolean {
  if (typeof args.createdAt !== "number" || !Number.isFinite(args.createdAt))
    return false;
  const now = args.now ?? Date.now();
  return (
    args.createdAt > args.sessionStartedAt &&
    args.createdAt <= now &&
    now - args.createdAt <= FRESH_WORKSPACE_WINDOW_MS
  );
}

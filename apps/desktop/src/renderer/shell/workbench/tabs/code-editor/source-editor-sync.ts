export type DiskContentSyncResult = {
  kind: "unchanged" | "acknowledge-save" | "adopt-disk";
  baseline: string;
  draft: string;
  pendingSave: string | null;
};

/** Resolve a fresh file read against the in-memory editor state.
 *
 * Disk content is authoritative: a genuine external update replaces the local
 * draft immediately. The only exception is an echo of this editor's own save;
 * acknowledging that write must not erase keystrokes entered while the save was
 * in flight. */
export function resolveDiskContentSync(args: {
  incoming: string;
  lastSeen: string;
  baseline: string;
  draft: string;
  pendingSave: string | null;
}): DiskContentSyncResult {
  if (args.incoming === args.lastSeen) {
    return {
      kind: "unchanged",
      baseline: args.baseline,
      draft: args.draft,
      pendingSave: args.pendingSave,
    };
  }

  if (
    args.incoming === args.baseline ||
    args.incoming === args.pendingSave
  ) {
    return {
      kind: "acknowledge-save",
      baseline: args.incoming,
      draft: args.draft,
      pendingSave:
        args.incoming === args.pendingSave ? null : args.pendingSave,
    };
  }

  return {
    kind: "adopt-disk",
    baseline: args.incoming,
    draft: args.incoming,
    pendingSave: null,
  };
}

/** The worker's SYNC_CHANGED: the inventory moved on; pull again. */
export class SyncChangedError extends Error { constructor() { super("The workspace changed during sync."); } }
export class SyncRootError extends Error { constructor(readonly code: "not_directory" | "not_empty" | "other_workspace" | "unsafe_root") { super(`Sync folder: ${code}`); } }

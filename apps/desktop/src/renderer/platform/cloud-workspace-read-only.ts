/** Team sharing: a teammate's workspace this account only reads. Thrown before
 * a worker connection is attempted, and for the control plane's
 * 409 workspace_read_only, so callers see one error for both. */
export class CloudWorkspaceReadOnlyError extends Error {
  readonly status = 409;
  readonly code = "workspace_read_only";
  constructor() { super("This workspace is read only. Its Creator runs it."); this.name = "CloudWorkspaceReadOnlyError"; }
}

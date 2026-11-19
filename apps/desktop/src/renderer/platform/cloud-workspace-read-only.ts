// Use one error for renderer refusal before worker admission and the control plane's workspace_read_only response.
export class CloudWorkspaceReadOnlyError extends Error {
  readonly status = 409;
  readonly code = "workspace_read_only";
  constructor() { super("This workspace is read only. Its Creator runs it."); this.name = "CloudWorkspaceReadOnlyError"; }
}

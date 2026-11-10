import type { WorkerConfig } from "../workspace/scope";

export type WorkspaceApi = NonNullable<WorkerConfig["api"]>;

/** Worker-owned ZEROS_* variables for agents and terminals, never for setup.
 * The control plane fixes the token for one VM run, so a repeated configuration
 * changes nothing here and children are never respawned because of it. */
export class WorkspaceApiEnvironment {
  private api?: WorkspaceApi;
  constructor(private readonly workspaceId: string) {}

  /** Children started from now on see the new value; running ones keep theirs. */
  configure(api: WorkspaceApi | undefined): void { this.api = api && { url: api.url, token: api.token }; }

  get token(): string | undefined { return this.api?.token; }

  variables(sessionId?: string): Readonly<Record<string, string>> {
    return { ZEROS_WORKSPACE_ID: this.workspaceId, ...(sessionId ? { ZEROS_SESSION_ID: sessionId } : {}),
      ...(this.api ? { ZEROS_API_URL: this.api.url, ZEROS_API_TOKEN: this.api.token } : {}) };
  }
}

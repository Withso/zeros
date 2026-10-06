import { CloudRuntimeQuietSnapshotSchema, type CloudRuntimeQuietSnapshot } from "@zeros/protocol/cloud-runtime-lifecycle";
export type { CloudRuntimeQuietSnapshot } from "@zeros/protocol/cloud-runtime-lifecycle";

export type CloudRuntimeQuietScope = Pick<CloudRuntimeQuietSnapshot, "workspaceId" | "organizationId" | "generation" | "engineInstanceId">;
export interface CloudRuntimeQuietStateOptions {
  cloud(): boolean;
  scope(): CloudRuntimeQuietScope | null;
  activity(): { revision: number; quietForMs: number; recordSync: CloudRuntimeQuietSnapshot["recordSync"] };
  busy(): boolean;
  livePty(): boolean;
  presence(): CloudRuntimeQuietSnapshot["presence"];
  inspectUserProcesses(): Promise<boolean>;
}

/** The same workload guards as idle-stop, with explicit PTY/presence evidence.
 * LU's safe-point handoff can consume this interface; this reader never drains,
 * reserves, fences, stops or changes admission. Re-read at activation. */
export class CloudRuntimeQuietState {
  constructor(private readonly options: CloudRuntimeQuietStateOptions) {}

  async snapshot(challenge: string): Promise<CloudRuntimeQuietSnapshot | null> {
    if (!this.options.cloud() || !CloudRuntimeQuietSnapshotSchema.shape.challenge.safeParse(challenge).success) return null;
    try {
      const initialScope = this.options.scope();
      if (!initialScope) return null;
      const scope = { ...initialScope };
      const before = { ...this.options.activity() };
      const busy = this.options.busy(), pty = this.options.livePty(), presence = this.options.presence();
      let userProcesses: CloudRuntimeQuietSnapshot["userProcesses"];
      try { userProcesses = await this.options.inspectUserProcesses() ? "busy" : "idle"; }
      catch { userProcesses = "unknown"; }
      const after = this.options.activity(), current = this.options.scope();
      if (!this.options.cloud() || !current || current.workspaceId !== scope.workspaceId || current.organizationId !== scope.organizationId ||
          current.generation !== scope.generation || current.engineInstanceId !== scope.engineInstanceId) return null;
      const finalPresence = this.options.presence();
      const parsed = CloudRuntimeQuietSnapshotSchema.safeParse({ version: 1, challenge, ...scope,
        activityRevision: after.revision, quietForMs: after.quietForMs, recordSync: after.recordSync,
        stable: before.revision === after.revision, workloadBusy: busy || this.options.busy(), livePty: pty || this.options.livePty(),
        userProcesses, presence: presence === "present" || finalPresence === "present" ? "present" :
          presence === "unknown" || finalPresence === "unknown" ? "unknown" : "absent" });
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }
}

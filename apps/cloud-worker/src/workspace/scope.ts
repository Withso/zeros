import { isAbsolute, resolve } from "node:path";
import type { CloudV2ControlFrame } from "@zeros/protocol/cloud-v2-relay";

export type WorkerConfig = Extract<CloudV2ControlFrame, { t: "config" }>;

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export const unsupported = (): never => { throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "This operation is not available in cloud workspaces yet."); };
export function reqString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value || value.length > 4096) throw new WorkspaceError("VALIDATION_FAILED", `Invalid ${key}.`);
  return value;
}

/** The renderer maps cloud keys to native paths before forwarding frames.
 * Keep a separate exact owner/placement key for durable worker isolation. */
export class WorkspaceScope {
  readonly key: string;
  readonly root: string;
  constructor(readonly workspace: WorkerConfig["workspace"]) {
    if (!isAbsolute(workspace.checkoutPath)) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Invalid workspace checkout.");
    this.key = `cloud://${workspace.organizationId}/${workspace.id}`;
    this.root = resolve(workspace.checkoutPath);
  }

  folder(value: unknown, optional = false): string {
    if (optional && value === undefined) return this.root;
    if (value === this.key || (typeof value === "string" && isAbsolute(value) && resolve(value) === this.root)) return this.root;
    throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This request belongs to another workspace.");
  }

  assertId(value: unknown): void {
    if (value !== undefined && value !== this.workspace.id && value !== this.key) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This request belongs to another workspace.");
  }
}

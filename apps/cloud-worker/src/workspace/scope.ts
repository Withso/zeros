import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CloudV2ControlFrame } from "@zeros/protocol/cloud-v2-relay";

export type WorkerConfig = Extract<CloudV2ControlFrame, { t: "config" }>;

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export const unsupported = (): never => { throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "This operation is not available in cloud workspaces yet."); };
export function reqString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0")) throw new WorkspaceError("VALIDATION_FAILED", `Invalid ${key}.`);
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

  /** Native wire values may be absolute or repo-relative. Git and file result
   * arrays use relative paths; only typed cwd/root fields use absolute paths. */
  path(value: unknown, allowRoot = false): string {
    if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0") || value.startsWith("cloud://")) throw new WorkspaceError("VALIDATION_FAILED", "Invalid workspace path.");
    const target = resolve(this.root, value);
    const rel = relative(this.root, target);
    if ((!allowRoot && !rel) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).includes(".git")) throw new WorkspaceError("VALIDATION_FAILED", "The path is outside the workspace files.");
    return target;
  }

  relative(value: unknown, allowRoot = false): string { return relative(this.root, this.path(value, allowRoot)); }
}

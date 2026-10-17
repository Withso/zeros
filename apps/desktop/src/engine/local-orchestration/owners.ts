// ──────────────────────────────────────────────────────────
// Local orchestration — strict Local workspace ownership
// ──────────────────────────────────────────────────────────
//
// Resolves a chat folder to the Local workspace that owns it, failing closed:
//   1. the most specific managed workspace row containing the folder — refused
//      when it is organization-owned or cloud-placed;
//   2. otherwise the most specific registered (non-hidden) repository root —
//      a repo's main checkout or a legacy plain folder — as `folder:<projectId>`;
//   3. otherwise nothing (an unregistered folder is not addressable).
// Registry reads throw instead of falling back to `local-main`, so a lookup
// failure can never admit a foreign owner.
// ──────────────────────────────────────────────────────────

import { realpathSync } from "node:fs";
import * as path from "node:path";
import { LocalOrchestrationError } from "@zeros/protocol/local-orchestration";
import type { Workspace } from "../git/types";
import type { EngineProject } from "../db/projects";
import type { LocalOrchestrationPorts, LocalWorkspaceOwner } from "./types";

export const FOLDER_WORKSPACE_PREFIX = "folder:";

function canonical(p: string): string {
  const resolved = path.resolve(p);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** True when `child` is `parent` or inside it, comparing lexical and real paths. */
export function isWithinPath(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  for (const [c, p] of [
    [path.resolve(child), path.resolve(parent)],
    [canonical(child), canonical(parent)],
  ] as const) {
    if (c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)) return true;
  }
  return false;
}

function isLocalPersonal(ws: Workspace): boolean {
  const org = ws.organizationId;
  return (ws.placement ?? "local") === "local" && (org === null || org === undefined || org === "");
}

function managedOwner(ws: Workspace): LocalWorkspaceOwner {
  return {
    id: ws.id,
    kind: "worktree",
    path: ws.path,
    repoRoot: ws.repoRoot,
    name: ws.branch || path.basename(ws.path),
    branch: ws.branch || null,
    projectId: null,
    archived: ws.archivedAt != null,
    setupState: ws.setupState ?? null,
    present: ws.present !== false,
  };
}

function folderOwner(project: EngineProject): LocalWorkspaceOwner {
  return {
    id: `${FOLDER_WORKSPACE_PREFIX}${project.id}`,
    kind: "folder",
    path: project.repoRoot,
    repoRoot: project.repoRoot,
    name: project.name,
    branch: null,
    projectId: project.id,
    archived: false,
    setupState: null,
    present: true,
  };
}

/** One read of the registries, reused for every chat in a call. */
export class LocalOwnerIndex {
  private readonly managed: Workspace[];
  private readonly projects: EngineProject[];
  private readonly cache = new Map<string, LocalWorkspaceOwner | "foreign" | null>();

  constructor(private readonly ports: LocalOrchestrationPorts) {
    if (ports.isCloudWorker()) {
      throw new LocalOrchestrationError("NOT_LOCAL", "Zeros Local CLI runs only on the Mac's local engine.");
    }
    try {
      this.managed = ports.listManagedWorkspaces();
      this.projects = ports.listProjects();
    } catch {
      throw new LocalOrchestrationError("UNAVAILABLE", "Zeros could not read its workspace registry. Try again.", {
        retryable: true,
      });
    }
  }

  /** The owner of a folder: a Local owner, `foreign` (organization or cloud),
   * or null (not a registered Local folder). */
  ownerOfFolder(folder: string | null | undefined): LocalWorkspaceOwner | "foreign" | null {
    if (!folder || folder.startsWith("cloud://")) return folder ? "foreign" : null;
    const hit = this.cache.get(folder);
    if (hit !== undefined) return hit;
    let best: Workspace | null = null;
    for (const ws of this.managed) {
      if (!ws.path || !isWithinPath(folder, ws.path)) continue;
      if (!best || ws.path.length > best.path.length) best = ws;
    }
    let result: LocalWorkspaceOwner | "foreign" | null;
    if (best) {
      result = isLocalPersonal(best) ? managedOwner(best) : "foreign";
    } else {
      let project: EngineProject | null = null;
      for (const candidate of this.projects) {
        if (!candidate.repoRoot || candidate.repoRoot.startsWith("cloud://")) continue;
        if (!isWithinPath(folder, candidate.repoRoot)) continue;
        if (!project || candidate.repoRoot.length > project.repoRoot.length) project = candidate;
      }
      result = project ? folderOwner(project) : null;
    }
    this.cache.set(folder, result);
    return result;
  }

  /** Resolve a workspace id (`ws_…` or `folder:<projectId>`). */
  ownerById(id: string): LocalWorkspaceOwner | "foreign" | null {
    if (id.startsWith(FOLDER_WORKSPACE_PREFIX)) {
      const projectId = id.slice(FOLDER_WORKSPACE_PREFIX.length);
      const project = this.projects.find((p) => p.id === projectId);
      if (!project || project.repoRoot.startsWith("cloud://")) return null;
      // The id must name what owns the folder: a root inside a managed
      // workspace belongs to that workspace (foreign when it is not Local).
      const resolved = this.ownerOfFolder(project.repoRoot);
      if (resolved === "foreign") return "foreign";
      return resolved && resolved.id === id ? resolved : null;
    }
    const ws = this.managed.find((w) => w.id === id);
    if (!ws) return null;
    return isLocalPersonal(ws) ? managedOwner(ws) : "foreign";
  }

  projectsList(): EngineProject[] {
    return this.projects;
  }

  managedList(): Workspace[] {
    return this.managed;
  }

  /** The registered project a path belongs to (for repo-qualified creation). */
  projectForPath(p: string): EngineProject | null {
    let project: EngineProject | null = null;
    for (const candidate of this.projects) {
      if (!candidate.repoRoot || !isWithinPath(p, candidate.repoRoot)) continue;
      if (!project || candidate.repoRoot.length > project.repoRoot.length) project = candidate;
    }
    return project;
  }
}

/** Resolve or throw the typed failure the CLI reports. */
export function requireLocalOwner(
  index: LocalOwnerIndex,
  folder: string | null | undefined,
): LocalWorkspaceOwner {
  const owner = index.ownerOfFolder(folder);
  if (owner === "foreign") {
    throw new LocalOrchestrationError(
      "NOT_LOCAL",
      "This chat is not in a Local workspace. Zeros Local CLI works only in Local (Personal) workspaces.",
    );
  }
  if (!owner) {
    throw new LocalOrchestrationError(
      "NOT_LOCAL",
      "This chat's folder is not a workspace or project added to Zeros.",
    );
  }
  return owner;
}

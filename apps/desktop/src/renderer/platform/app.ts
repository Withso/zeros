import {
  isElectron,
  isNativeRuntime,
  nativeInvoke,
  nativeListen,
} from "./runtime";
import { normalizeExternalHttpUrl } from "@zeros/protocol/external-url";
import { cloudWorkspaceKey, isCloudWorkspace, parseCloudWorkspaceKey } from "./bridge/cloud-workspace-key";
import { getActiveBridge } from "./bridge/active-bridge";
import { workspaceOp } from "./bridge/workspace-bridge";
import { canBackgroundSyncCloudWorkspace } from "../state/cloud-workspace-catalog";

export { isElectron, isNativeRuntime, runtimeName } from "./runtime";

export type EditHistoryDirection = "undo" | "redo";

export async function onMenuEditHistory(
  handler: (payload: { direction: EditHistoryDirection }) => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  return nativeListen<{ direction: EditHistoryDirection }>("menu-edit-history", handler);
}

export async function nativeEditHistory(direction: EditHistoryDirection): Promise<void> {
  if (!isNativeRuntime()) return;
  await nativeInvoke<void>("edit_history", { direction });
}

export type ProjectChangedPayload = {
  root: string;
  port: number;
};

export type ProjectOpeningPayload = {
  root: string;
};

/** A failed zeros://open event has a null root when the link omitted its path. */
export type ProjectOpenFailedPayload = {
  root: string | null;
  reason: string;
};

export type AgentContextFile = {
  path: string;
  filename: string;
  size: number;
  /** Epoch milliseconds. */
  mtime: number;
  /** First ~200 chars of the file. Empty for binary files. */
  preview: string;
  scope: "project" | "parent" | "user";
};

export type AgentContextResult = {
  agentId: string;
  cwd: string;
  files: AgentContextFile[];
};

/** Native context discovery walks from cwd through its parents and also checks the user's home. */
export async function loadAgentContextFiles(args: {
  cwd: string;
  agentId: string;
}): Promise<AgentContextResult> {
  if (!isNativeRuntime()) {
    return { agentId: args.agentId, cwd: args.cwd, files: [] };
  }
  return nativeInvoke<AgentContextResult>("agent_context_files", args);
}

export type Skill = {
  id: string;
  name: string;
  description: string;
  icon: string;
  body: string;
  path: string;
  /** Full source, including frontmatter. Absent on older desktop runtimes. */
  content?: string;
};

export async function listSkills(
  cwd?: string,
  agentId?: string,
): Promise<Skill[]> {
  let result: unknown;
  if (cwd && isCloudWorkspace(cwd)) {
    const target = parseCloudWorkspaceKey(cwd);
    if (!target) throw new Error("Invalid cloud workspace identity.");
    // Composer discovery must not wake a stopped VM through a retained relay.
    if (!canBackgroundSyncCloudWorkspace(target))
      throw new Error("Skill sources are available when the cloud workspace is running.");
    const bridge = getActiveBridge();
    if (!bridge) throw new Error("The workspace connection is unavailable.");
    const root = cloudWorkspaceKey(target);
    const response = await workspaceOp(bridge, "skills.list", { workspaceId: root, cwd: root, agentId });
    result = (response as { skills?: unknown } | null)?.skills;
  } else {
    if (!isNativeRuntime()) return [];
    const args: { cwd?: string; agentId?: string } = {};
    if (cwd) args.cwd = cwd;
    if (agentId) args.agentId = agentId;
    result = await nativeInvoke<unknown>(
      "skills_list",
      Object.keys(args).length ? args : undefined,
    );
  }
  // Treat malformed catalogs as failed reads so the exact-key cache keeps its last confirmed snapshot.
  if (!Array.isArray(result) || result.some(skill => !skill ||
    ["id", "name", "description", "icon", "body", "path"].some(key => typeof skill[key] !== "string") ||
    (skill.content !== undefined && typeof skill.content !== "string")))
    throw new Error("Invalid skill catalog response.");
  return result as Skill[];
}

export async function shellOpenUrl(url: string): Promise<void> {
  const normalized = normalizeExternalHttpUrl(url);
  if (!normalized) throw new Error("only valid http(s) URLs are allowed");
  if (!isNativeRuntime()) {
    window.open(normalized, "_blank", "noopener,noreferrer");
    return;
  }
  await nativeInvoke<void>("shell_open_url", { url: normalized });
}

/** Host apps cannot open an opaque cloud workspace identity. */
export function canOpenPathLocally(path: string | null | undefined): boolean {
  return !!path && !isCloudWorkspace(path) && isNativeRuntime();
}

export async function revealInFinder(path: string): Promise<void> {
  if (!canOpenPathLocally(path)) return;
  await nativeInvoke<void>("reveal_in_finder", { path });
}

export async function openInTerminal(path: string): Promise<void> {
  if (!canOpenPathLocally(path)) return;
  await nativeInvoke<void>("open_in_terminal", { path });
}

/** The native command can create a missing provider config before revealing it. */
export async function openAgentConfig(agent: string): Promise<void> {
  if (!isNativeRuntime()) return;
  await nativeInvoke<void>("open_agent_config", { agent });
}

export async function onProjectChanged(
  handler: (payload: ProjectChangedPayload) => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  return nativeListen<ProjectChangedPayload>("project-changed", handler);
}

/** Native emits this before engine respawn so the sidebar can show the pending project. */
export async function onProjectOpening(
  handler: (payload: ProjectOpeningPayload) => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  return nativeListen<ProjectOpeningPayload>("project-opening", handler);
}

export async function onProjectOpenFailed(
  handler: (payload: ProjectOpenFailedPayload) => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  return nativeListen<ProjectOpenFailedPayload>("project-open-failed", handler);
}

/** Native menu requests go through the same renderer project-registration flow as the sidebar, not a direct engine respawn. */
export async function onMenuOpenProject(
  handler: () => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  return nativeListen<unknown>("menu-open-project", () => handler());
}

/** The picker does not re-root the engine; the renderer registers the chosen folder over the bridge. */
export async function pickProjectFolder(): Promise<string | null> {
  if (!isNativeRuntime()) {
    return null;
  }
  return nativeInvoke<string | null>("pick_project_folder");
}

/** After the last project is removed, re-root the engine so paired peers cannot keep using the unregistered checkout. */
export async function resetEngineToDefault(): Promise<number | null> {
  if (!isNativeRuntime()) return null;
  return nativeInvoke<number | null>("engine_reset_to_default");
}

// macOS requests notification permission on first display; there is no separate permission call.

export async function notify(title: string, body?: string): Promise<void> {
  if (!isElectron()) return;
  await nativeInvoke<void>("notify_send", { title, body });
}

// Native handles opening project paths itself; only unhandled links are forwarded to this event.

export async function onDeepLink(
  handler: (url: string) => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  return nativeListen<string>("deep-link", handler);
}

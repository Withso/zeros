// ──────────────────────────────────────────────────────────
// Native shell façade (Electron)
// ──────────────────────────────────────────────────────────
//
// Thin adapter over the desktop-shell IPC. Every function routes
// through `nativeInvoke()` / `nativeListen()` so calls land on
// Electron main-process handlers (apps/desktop/electron/ipc/router.ts) without
// the call site knowing about IPC details.
//
// In browser-only dev (`pnpm dev` without Electron), read-style
// functions resolve to empty / null; write-style ones throw so
// the caller sees a clear "requires the Mac app" error instead
// of silent failure.
//
// File renamed during the Electron migration. The function names are
// unchanged so consumers only had to update their import path.
// ──────────────────────────────────────────────────────────

import {
  isElectron,
  isNativeRuntime,
  nativeInvoke,
  nativeListen,
} from "./runtime";

// Re-export the runtime predicates so call sites can pull them
// from either module.
export { isElectron, isNativeRuntime, runtimeName } from "./runtime";

export type ProjectChangedPayload = {
  root: string;
  port: number;
};

export type ProjectOpeningPayload = {
  root: string;
};

/** A `zeros://open?path=…` deep link that never became an open project —
 *  a missing/blocked/non-project path, or a failed engine respawn. `root` is
 *  null when the link carried no path at all. */
export type ProjectOpenFailedPayload = {
  root: string | null;
  reason: string;
};

// ── Agent project-context discovery ──

export type AgentContextFile = {
  path: string;
  filename: string;
  size: number;
  /** mtime in epoch milliseconds; useful for "last edited X ago" UI. */
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

/** List the project-context files an agent is loading at this cwd —
 *  CLAUDE.md / AGENTS.md / .cursor/rules/* per agent.
 *  Walks cwd → parents → home. Read-only; binary-safe. */
export async function loadAgentContextFiles(args: {
  cwd: string;
  agentId: string;
}): Promise<AgentContextResult> {
  if (!isNativeRuntime()) {
    return { agentId: args.agentId, cwd: args.cwd, files: [] };
  }
  return nativeInvoke<AgentContextResult>("agent_context_files", args);
}

// The per-chat policies and plan IPC wrappers were removed: those
// surfaces now live in renderer localStorage (device-local.ts / policies.ts),
// and the apps/desktop/electron/db.ts store backing them is gone.

// ── Skills ───────────────────────────────────────────────

export type Skill = {
  id: string;
  name: string;
  description: string;
  icon: string;
  body: string;
  path: string;
};

export async function listSkills(
  cwd?: string,
  agentId?: string,
): Promise<Skill[]> {
  if (!isNativeRuntime()) return [];
  try {
    const args: { cwd?: string; agentId?: string } = {};
    if (cwd) args.cwd = cwd;
    if (agentId) args.agentId = agentId;
    return await nativeInvoke<Skill[]>(
      "skills_list",
      Object.keys(args).length ? args : undefined,
    );
  } catch {
    return [];
  }
}

/** Open an external http(s) URL in the user's default browser. */
export async function shellOpenUrl(url: string): Promise<void> {
  if (!isNativeRuntime()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await nativeInvoke<void>("shell_open_url", { url });
}

/** Reveal a path in macOS Finder. */
export async function revealInFinder(path: string): Promise<void> {
  if (!isNativeRuntime()) return;
  await nativeInvoke<void>("reveal_in_finder", { path });
}

/** Launch macOS Terminal.app at the given directory. */
export async function openInTerminal(path: string): Promise<void> {
  if (!isNativeRuntime()) return;
  await nativeInvoke<void>("open_in_terminal", { path });
}

/** Reveal an agent's native config file in Finder (created if missing) —
 *  claude → ~/.claude/settings.json, codex → ~/.codex/config.toml. No-op
 *  outside the native runtime. */
export async function openAgentConfig(agent: string): Promise<void> {
  if (!isNativeRuntime()) return;
  await nativeInvoke<void>("open_agent_config", { agent });
}

/**
 * Subscribe to the main-process `project-changed` event (fired when
 * the user picks a new folder via File > Open Folder). Returns an
 * unsubscribe function; safe to call in all three modes.
 */
export async function onProjectChanged(
  handler: (payload: ProjectChangedPayload) => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  return nativeListen<ProjectChangedPayload>("project-changed", handler);
}

/**
 * Subscribe to the early `project-opening` event — fired the instant the
 * user picks a folder, BEFORE the engine respawns (which can take a few
 * seconds). Lets the sidebar paint a pending/loading project row right away
 * instead of waiting on the respawn. Returns an unsubscribe function; safe
 * to call in all three modes.
 */
export async function onProjectOpening(
  handler: (payload: ProjectOpeningPayload) => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  return nativeListen<ProjectOpeningPayload>("project-opening", handler);
}

/** Subscribe to a failed `zeros://open` deep link so the renderer can tell the
 *  user why nothing happened, instead of leaving the click silently dead. */
export async function onProjectOpenFailed(
  handler: (payload: ProjectOpenFailedPayload) => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  return nativeListen<ProjectOpenFailedPayload>("project-open-failed", handler);
}

/**
 * Subscribe to the native File → Open Folder / Cmd+Shift+O menu trigger. The
 * menu lives in the main process and can't run the renderer's add-project flow
 * directly, so it emits this event and the renderer drives `openProject()` —
 * the SAME path as the sidebar "+" and the welcome screen. This is why the
 * shortcut registers the picked folder as a project (upsert + default chat)
 * instead of only respawning the engine and leaving a dangling shimmer. (Plain
 * Cmd+O is the topbar's "open worktree in default app" — see conversation/conversation-header.)
 * Returns an unsubscribe function; no-op outside the native runtime (web has
 * no menu).
 */
export async function onMenuOpenProject(
  handler: () => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  return nativeListen<unknown>("menu-open-project", () => handler());
}

/**
 * Show the native folder picker for "Open project" WITHOUT respawning the
 * engine. Returns the chosen absolute path, or null on cancel. The caller
 * registers it as a project over the bridge (`upsertProject`) — the running
 * engine serves it without re-rooting. This is the snappy add-a-repo path that
 * replaces the legacy `openProjectFolder` (which killed + respawned the engine).
 */
export async function pickProjectFolder(): Promise<string | null> {
  if (!isNativeRuntime()) {
    // No native runtime available; treat as a soft cancel.
    return null;
  }
  return nativeInvoke<string | null>("pick_project_folder");
}

/**
 * Re-root the engine at the default sentinel (~/.zeros/default-project) and
 * reconnect the bridge. Called when the user removes their LAST project so the
 * engine stops serving the now-unregistered repo root to any paired web/remote
 * peer. No-op outside the native runtime. Returns the new engine port (or null
 * when no engine is bound).
 */
export async function resetEngineToDefault(): Promise<number | null> {
  if (!isNativeRuntime()) return null;
  return nativeInvoke<number | null>("engine_reset_to_default");
}

// ── Native notifications ──────────────────────────────────
//
// notify_send routes to apps/desktop/electron/ipc/commands/notifications.ts
// which calls `new Notification({title, body}).show()`. macOS
// surfaces its own permission prompt on first display — no
// explicit permission API to manage on our side. Browser-only
// dev mode no-ops because isElectron() is false.

export async function notify(title: string, body?: string): Promise<void> {
  if (!isElectron()) return;
  await nativeInvoke<void>("notify_send", { title, body });
}

// ── Deep links ────────────────────────────────────────────
//
// The main process handles zeros://open?path=... directly and emits
// a `deep-link` event for any other routes so React can handle them
// without a native rebuild.

export async function onDeepLink(
  handler: (url: string) => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  return nativeListen<string>("deep-link", handler);
}

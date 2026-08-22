// ──────────────────────────────────────────────────────────
// Native binding — context graph (Context tab canvas)
// ──────────────────────────────────────────────────────────
//
// Renderer-side façade over the engine's `context.graph.*` bridge ops.
// Bridge-only, like listIgnoredEntries: the canvas lists once per workspace
// plus once per refresh signal, so there is no native fast path to keep in
// sync. DESKTOP ONLY — the engine refuses remote callers (the graph's
// `local/` scope is gitignored private material), so remote clients short-
// circuit here instead of spending a guaranteed-refusal round-trip.
// ──────────────────────────────────────────────────────────

import { isNativeRuntime } from "./runtime";
import { getActiveBridge } from "./bridge/active-bridge";
import {
  bridgeContextGraphList,
  bridgeContextGraphScaffold,
  bridgeContextGraphSetShared,
} from "./bridge/workspace-bridge";
import { resolveBridgeWorkspaceIdForCwd } from "./bridge/workspace-id-resolver";

export type ContextGraphScope = "local" | "shared";
export type ContextGraphCategory = "attachment" | "doc";
export type ContextGraphKind = "image" | "markdown" | "text" | "other";

/** Wire shape of one canvas card — mirrors the engine's ContextGraphItem. */
export interface ContextGraphItemWire {
  relPath: string;
  name: string;
  scope: ContextGraphScope;
  category: ContextGraphCategory;
  kind: ContextGraphKind;
  bytes: number;
  mtimeMs: number;
  /** Metadata-change time disambiguates atomic same-size rewrites that land
   *  inside one rounded mtime tick. Older engines may omit it. */
  ctimeMs?: number;
  attachmentId?: string;
  previewText?: string;
}

export interface ContextGraphListWire {
  exists: boolean;
  items: ContextGraphItemWire[];
  truncated: boolean;
}

// ── Change signal ───────────────────────────────────────────
// Attachment staging writes ride a direct electron IPC (no bridge op), so no
// DB_CHANGED reaches the renderer until the engine's worktree watcher polls
// or the turn ends. This in-process signal lets the write path nudge the
// Context tab the moment a file lands, without coupling the composer to the
// shell's refresh bus.

type ContextGraphListener = (cwd: string) => void;
const changeListeners = new Set<ContextGraphListener>();

/** Notify subscribers that `cwd`'s graph changed on disk (post-write). */
export function notifyContextGraphChanged(cwd: string): void {
  for (const listener of changeListeners) {
    try {
      listener(cwd);
    } catch {
      /* one bad subscriber must not break the others */
    }
  }
}

/** Subscribe to graph writes made from this renderer. Returns unsubscribe. */
export function subscribeContextGraphChanged(
  listener: ContextGraphListener,
): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function requireBridge(action: string) {
  const bridge = getActiveBridge();
  if (!bridge) {
    throw new Error(
      `Can't ${action}: not connected to the Zeros engine yet — try again in a moment.`,
    );
  }
  return bridge;
}

async function resolveTarget(cwd: string, action: string) {
  const bridge = requireBridge(action);
  let workspaceId = cwd;
  try {
    workspaceId = (await resolveBridgeWorkspaceIdForCwd(bridge, cwd)) ?? cwd;
  } catch {
    // A registered primary checkout has no workspace row; the engine resolves
    // its trusted raw root via isKnownRepoRoot (resolveReadCwd).
  }
  return { bridge, workspaceId };
}

/** List the workspace's `.context-graph/` contents (both scopes merged).
 *  Transport absence REJECTS (callers retain their confirmed snapshot);
 *  a remote client resolves to the empty non-existent graph. */
export async function listContextGraph(
  cwd: string,
): Promise<ContextGraphListWire> {
  if (!cwd || !isNativeRuntime()) {
    return { exists: false, items: [], truncated: false };
  }
  const { bridge, workspaceId } = await resolveTarget(
    cwd,
    "list the context graph",
  );
  return bridgeContextGraphList(bridge, workspaceId);
}

/** Idempotently create the graph skeleton. No-op without native graph access. */
export async function scaffoldContextGraph(
  cwd: string,
): Promise<{ ok: boolean; created: boolean }> {
  if (!cwd || !isNativeRuntime()) return { ok: false, created: false };
  const { bridge, workspaceId } = await resolveTarget(
    cwd,
    "scaffold the context graph",
  );
  return bridgeContextGraphScaffold(bridge, workspaceId);
}

/** Move one attachment between the private (`local/`, gitignored) and shared
 *  (`shared/`, committed) scopes — the canvas checkbox. */
export async function setContextGraphShared(
  cwd: string,
  attachmentId: string,
  shared: boolean,
): Promise<{ ok: boolean; moved: boolean }> {
  if (!cwd || !isNativeRuntime()) return { ok: false, moved: false };
  const { bridge, workspaceId } = await resolveTarget(
    cwd,
    "share the context attachment",
  );
  return bridgeContextGraphSetShared(bridge, workspaceId, attachmentId, shared);
}

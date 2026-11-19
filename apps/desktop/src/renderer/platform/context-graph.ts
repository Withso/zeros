// The engine rejects remote access to private .context material; do not send these operations from a remote renderer.

import { isNativeRuntime } from "./runtime";
import { getActiveBridge } from "./bridge/active-bridge";
import {
  bridgeContextGraphList,
  bridgeContextGraphScaffold,
} from "./bridge/workspace-bridge";
import { resolveBridgeWorkspaceIdForCwd } from "./bridge/workspace-id-resolver";

/** `shared` marks only records an earlier build's share action moved. */
export type ContextGraphScope = "local" | "shared";
export type ContextGraphCategory = "attachment" | "doc";
export type ContextGraphKind = "image" | "markdown" | "text" | "other";

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

// Direct attachment IPC writes do not immediately broadcast an engine change; notify subscribers after the file lands.

type ContextGraphListener = (cwd: string) => void;
const changeListeners = new Set<ContextGraphListener>();

export function notifyContextGraphChanged(cwd: string): void {
  for (const listener of changeListeners) {
    try {
      listener(cwd);
    } catch {
      /* one bad subscriber must not break the others */
    }
  }
}

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
    // A registered primary checkout can lack a workspace row; the engine validates its raw root.
  }
  return { bridge, workspaceId };
}

/** Reject on missing transport so a Local reader retains the last confirmed graph. */
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

/** Creating the graph skeleton is idempotent. */
export async function scaffoldContextGraph(
  cwd: string,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
  if (!cwd || !isNativeRuntime()) return { ok: false, created: false };
  const { bridge, workspaceId } = await resolveTarget(
    cwd,
    "scaffold the context graph",
  );
  return bridgeContextGraphScaffold(bridge, workspaceId);
}

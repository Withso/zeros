// ──────────────────────────────────────────────────────────
// Native bindings — interactive PTY sessions
// ──────────────────────────────────────────────────────────
//
// The ENGINE owns every interactive PTY (src/engine/pty/), and BOTH the desktop
// and the web/phone reach it the same way: through the module-level RuntimeClient
// (getActiveBridge()) over the bridge. This is the shared-PTY (Paseo) model —
// one backend, so a Mac + a web client attach to the SAME shell and type on
// both. The engine keeps a per-session scrollback mirror, so a reattach restores
// the pre-existing screen via PtySessionInfo.replay.
//
// The legacy Electron-IPC PTY path (electron/ipc/commands/pty.ts) was retired
// once the desktop converged onto the engine — there is no per-process node-pty
// in the renderer path anymore.
//
// With no bridge connected (pure browser dev, or the engine momentarily down) we
// degrade to null / [] / no-op and the terminal panel shows its "unavailable"
// state instead of throwing. getBridgeReady() smooths the mount-order race where
// the active bridge isn't published yet on first paint.
// ──────────────────────────────────────────────────────────

import type { RuntimeClient } from "../zeros/bridge/ws-client";
import type { PtyExitReason } from "@zeros/core/messages";
import {
  getActiveBridge,
  onActiveBridgeChange,
} from "../zeros/bridge/active-bridge";
import {
  bridgePtyCreate,
  bridgePtyWrite,
  bridgePtyResize,
  bridgePtyKill,
  bridgePtyList,
  bridgePtyProcessPids,
  bridgePtyTerminals,
  bridgeResolveAgentBinary,
  subscribeBridgePtyData,
  subscribeBridgePtyExit,
  subscribeBridgePtyTerminalsChanged,
  type PtyTerminalLike,
} from "../zeros/bridge/pty-bridge";

export type { PtyTerminalLike };

/** Resolve the live engine bridge, waiting briefly if it isn't up yet. Handles
 *  the mount-order race: BridgeProvider sets the active bridge in a ROOT effect
 *  that runs AFTER deep children, so a terminal reattaching on mount can see
 *  `null` for a tick. Resolves the moment the bridge appears (or null on
 *  timeout — engine genuinely down). */
function getBridgeReady(timeoutMs = 4000): Promise<RuntimeClient | null> {
  const now = getActiveBridge();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (b: RuntimeClient | null) => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve(b);
    };
    const off = onActiveBridgeChange((b) => {
      if (b) finish(b);
    });
    const timer = setTimeout(() => finish(getActiveBridge()), timeoutMs);
  });
}

export interface PtySessionInfo {
  sessionId: string;
  pid: number;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  /** True when the engine found an existing PTY for this sessionId and handed it
   *  back instead of spawning a fresh one (page refresh / col-3 collapse-expand /
   *  a second device attaching). */
  reattached?: boolean;
  /** Serialized snapshot of the resolved terminal grid captured on re-attach
   *  (NOT raw history — that ghosted redraw TUIs). Empty on a fresh spawn;
   *  byte-capped at ~256 KB. The caller writes this verbatim into a fresh,
   *  same-size xterm before binding the live data handler so dev-server logs
   *  survive cmd+R / window-reopen. */
  replay?: string;
  /** True when the snapshot dropped scrollback to stay under the ~256 KB budget.
   *  The visible screen is always intact; only older scrollback was trimmed. */
  replayTruncated?: boolean;
  /** UTF-8 byte size of `replay` (diagnostics). */
  replayBytes?: number;
}

export interface PtyDataEvent {
  sessionId: string;
  data: string;
}

export interface PtyExitEvent {
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
  /** Infrastructure failure. Absent means a real shell process exited. */
  reason?: PtyExitReason;
}

export async function ptyCreate(args: {
  sessionId: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Ephemeral one-shot terminal (the composer's inline `claude /mcp` runner):
   *  the engine spawns it like any PTY but keeps it OUT of the shared
   *  multiplayer registry, so it never shows in another device's terminal list
   *  and leaves no "(exited)" tab. The caller disposes it explicitly. */
  ephemeral?: boolean;
}): Promise<PtySessionInfo | null> {
  // The engine resolves the workspace from `cwd` (an id OR a real path)
  // server-side, so we pass the folder unchanged — no renderer-side id mapping.
  const bridge = await getBridgeReady();
  return bridge ? bridgePtyCreate(bridge, args) : null;
}

/** Resolve an agent's on-disk CLI binary path (engine-side; the renderer can't
 *  stat the filesystem). Used by the embedded-terminal commands to run the SAME
 *  `claude` the agent uses. Returns the bare agent id as a last resort (no
 *  bridge / engine down) — the login-shell PATH still resolves it. */
export async function resolveAgentBinary(agentId: string): Promise<string> {
  const bridge = await getBridgeReady();
  if (!bridge) return agentId;
  return bridgeResolveAgentBinary(bridge, agentId);
}

export async function ptyWrite(args: {
  sessionId: string;
  data: string;
}): Promise<void> {
  // Writes only ever follow a successful create, so the bridge is up by now — a
  // sync read is enough (no need to await).
  const bridge = getActiveBridge();
  if (bridge) bridgePtyWrite(bridge, args);
}

export async function ptyResize(args: {
  sessionId: string;
  cols: number;
  rows: number;
}): Promise<void> {
  const bridge = getActiveBridge();
  if (bridge) bridgePtyResize(bridge, args);
}

export async function ptyKill(args: { sessionId: string }): Promise<void> {
  const bridge = getActiveBridge();
  if (bridge) bridgePtyKill(bridge, args);
}

export async function ptyList(): Promise<PtySessionInfo[]> {
  const bridge = getActiveBridge();
  return bridge ? bridgePtyList(bridge) : [];
}

/** PID-only census for accurate resource-monitor terminal ownership. Null means
 * the engine is unavailable; an empty array is an authoritative zero PTYs. */
export async function ptyProcessPids(
  timeoutMs = 1_000,
): Promise<number[] | null> {
  const bridge = getActiveBridge();
  return bridge ? bridgePtyProcessPids(bridge, timeoutMs) : null;
}

/** Subscribe to PTY stdout/stderr chunks. The handler receives every session's
 *  output — caller filters by `sessionId`. Re-binds whenever the active bridge
 *  appears or swaps (the root-effect mount-order race, or a relay reconnect):
 *  without this, a router installed before the bridge connected would no-op
 *  forever and the terminal would stay blank. */
export async function onPtyData(
  handler: (evt: PtyDataEvent) => void,
): Promise<() => void> {
  return bindBridgeStream(subscribeBridgePtyData, handler);
}

/** Subscribe to PTY exit events. Same re-bind-on-bridge-swap contract as
 *  onPtyData. */
export async function onPtyExit(
  handler: (evt: PtyExitEvent) => void,
): Promise<() => void> {
  return bindBridgeStream(subscribeBridgePtyExit, handler);
}

/** Subscribe `handler` to a bridge stream, re-binding on every active-bridge
 *  change so a late or swapped bridge keeps delivering. Returns an unsubscribe
 *  that also stops listening for swaps. */
function bindBridgeStream<E>(
  subscribe: (bridge: RuntimeClient, handler: (evt: E) => void) => () => void,
  handler: (evt: E) => void,
): () => void {
  let inner: (() => void) | null = null;
  const rebind = (bridge: RuntimeClient | null) => {
    if (inner) {
      inner();
      inner = null;
    }
    if (bridge) inner = subscribe(bridge, handler);
  };
  rebind(getActiveBridge());
  const off = onActiveBridgeChange(rebind);
  return () => {
    off();
    if (inner) inner();
  };
}

// ── Shared terminal list (multiplayer discovery) ──────────
//
// The engine owns a registry of all live terminals; these let a device discover
// terminals OTHER devices created (so the tab strip is the same everywhere) and
// re-fetch when that set changes.

/** The SHARED terminals the engine knows about (optionally scoped to one
 *  workspace), so a device can show + attach to terminals another device
 *  created. Returns null when the engine ISN'T REACHABLE (no bridge) — distinct
 *  from `[]` (engine reachable, genuinely zero terminals) so a caller doing
 *  remove-on-vanish reconciliation never prunes tabs on a transient disconnect. */
export async function ptyTerminals(
  workspaceId?: string,
): Promise<PtyTerminalLike[] | null> {
  const bridge = getActiveBridge();
  if (!bridge) return null;
  try {
    return await bridgePtyTerminals(bridge, workspaceId);
  } catch {
    // A request failure is an unavailable snapshot, never proof that every
    // terminal vanished. Reconciliation retains the last confirmed registry.
    return null;
  }
}

/** Subscribe to "the shared terminal set changed" pushes (a terminal was created
 *  or exited on ANY device), re-binding on bridge swap. Returns an unsubscribe
 *  fn. */
export function onPtyTerminalsChanged(handler: () => void): () => void {
  return bindBridgeStream<void>(
    (bridge, h) => subscribeBridgePtyTerminalsChanged(bridge, () => h()),
    () => handler(),
  );
}

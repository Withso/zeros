// Both native and relay clients use the engine as terminal authority.
import type { RuntimeClient } from "./bridge/ws-client";
import type { PtyExitReason } from "@zeros/protocol/messages";
import {
  getActiveBridge,
  onActiveBridgeChange,
} from "./bridge/active-bridge";
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
} from "./bridge/pty-bridge";

export type { PtyTerminalLike };

/** A terminal can attach before the root provider publishes its bridge; wait briefly for it. */
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
  reattached?: boolean;
  /** Reattach gets a bounded snapshot of the resolved grid, not raw history that can replay stale redraws. */
  replay?: string;
  /** Only old scrollback is dropped; the visible screen stays intact. */
  replayTruncated?: boolean;
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
  /** One-shot terminals stay out of the shared registry; their caller must dispose of them. */
  ephemeral?: boolean;
  loginProvider?: "claude" | "codex";
  /** Only the cloud worker can restore a plain shell's last screen and directory after restart. */
  restore?: boolean;
}): Promise<PtySessionInfo | null> {
  // Pass cwd unchanged; the engine resolves either a workspace ID or a path.
  const bridge = await getBridgeReady();
  return bridge ? bridgePtyCreate(bridge, args) : null;
}

/** Use the engine-selected agent binary; without the bridge, let the shell resolve the bare name. */
export async function resolveAgentBinary(agentId: string): Promise<string> {
  const bridge = await getBridgeReady();
  if (!bridge) return agentId;
  return bridgeResolveAgentBinary(bridge, agentId);
}

export async function ptyWrite(args: {
  sessionId: string;
  data: string;
}): Promise<void> {
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

/** An empty census authoritatively means no terminal roots; null is unknown. */
export async function ptyProcessPids(
  timeoutMs = 1_000,
): Promise<number[] | null> {
  const bridge = getActiveBridge();
  if (!bridge) return null;
  try {
    return await bridgePtyProcessPids(bridge, timeoutMs);
  } catch {
    // An older or relay peer may not provide the census; treating that as empty would misattribute terminal CPU.
    return null;
  }
}

/** Each subscriber receives all sessions; filter by sessionId. */
export async function onPtyData(
  handler: (evt: PtyDataEvent) => void,
): Promise<() => void> {
  return bindBridgeStream(subscribeBridgePtyData, handler);
}

export async function onPtyExit(
  handler: (evt: PtyExitEvent) => void,
): Promise<() => void> {
  return bindBridgeStream(subscribeBridgePtyExit, handler);
}

/** Bind again when the bridge appears or changes, including after a reconnect. */
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

/** Null is an unavailable shared registry, not permission to prune terminals from a prior snapshot. */
export async function ptyTerminals(
  workspaceId?: string,
): Promise<PtyTerminalLike[] | null> {
  const bridge = getActiveBridge();
  if (!bridge) return null;
  try {
    return await bridgePtyTerminals(bridge, workspaceId);
  } catch {
    return null;
  }
}

export function onPtyTerminalsChanged(handler: () => void): () => void {
  return bindBridgeStream<void>(
    (bridge, h) => subscribeBridgePtyTerminalsChanged(bridge, () => h()),
    () => handler(),
  );
}

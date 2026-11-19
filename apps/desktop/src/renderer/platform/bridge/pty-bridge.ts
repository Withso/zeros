
import type { RuntimeClient } from "./ws-client";
import type { BridgeMessage } from "./messages";
import type {
  PtySessionInfo,
  PtyDataEvent,
  PtyExitEvent,
} from "../pty";
import type { PtyExitReason } from "@zeros/protocol/messages";

interface PtyCreatedLike {
  type: "PTY_CREATED";
  requestId: string;
  sessionId: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  reattached?: boolean;
  replay?: string;
  replayTruncated?: boolean;
  replayBytes?: number;
}
interface PtyDataLike {
  type: "PTY_DATA";
  sessionId: string;
  data: string;
}
interface PtyExitLike {
  type: "PTY_EXIT";
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
  reason?: PtyExitReason;
}

/** Remote creation and reattach authorization are enforced by the engine, not the renderer. */
export async function bridgePtyCreate(
  bridge: RuntimeClient,
  args: {
    sessionId: string;
    cwd: string;
    cols: number;
    rows: number;
    ephemeral?: boolean;
    loginProvider?: "claude" | "codex";
    restore?: boolean;
  },
  timeoutMs = 10_000,
): Promise<PtySessionInfo | null> {
  try {
    const resp = (await bridge.request(
      {
        type: "PTY_CREATE",
        sessionId: args.sessionId,
        cwd: args.cwd,
        cols: args.cols,
        rows: args.rows,
        ...(args.ephemeral ? { ephemeral: true } : {}),
        ...(args.loginProvider ? { loginProvider: args.loginProvider } : {}),
        ...(args.restore ? { restore: true } : {}),
      } as Partial<BridgeMessage> & { type: string },
      timeoutMs,
    )) as PtyCreatedLike;
    if (resp.type !== "PTY_CREATED" || resp.sessionId !== args.sessionId) return null;
    return {
      sessionId: resp.sessionId,
      pid: resp.pid,
      cwd: resp.cwd,
      // PTY_CREATED omits the host login shell path.
      shell: "",
      cols: resp.cols,
      rows: resp.rows,
      // Reattach carries a serialized grid for repaint, not raw output history.
      reattached: resp.reattached,
      replay: resp.replay,
      replayTruncated: resp.replayTruncated,
      replayBytes: resp.replayBytes,
    };
  } catch {
    // Local engine refusals emit an uncorrelated PTY_EXIT instead of PTY_CREATED, so those requests time out here.
    return null;
  }
}

export function bridgePtyWrite(
  bridge: RuntimeClient,
  args: { sessionId: string; data: string },
): void {
  bridge.send({
    type: "PTY_WRITE",
    sessionId: args.sessionId,
    data: args.data,
  } as Partial<BridgeMessage> & { type: string });
}

export function bridgePtyResize(
  bridge: RuntimeClient,
  args: { sessionId: string; cols: number; rows: number },
): void {
  bridge.send({
    type: "PTY_RESIZE",
    sessionId: args.sessionId,
    cols: args.cols,
    rows: args.rows,
  } as Partial<BridgeMessage> & { type: string });
}

export function bridgePtyKill(
  bridge: RuntimeClient,
  args: { sessionId: string },
): void {
  bridge.send({
    type: "PTY_KILL",
    sessionId: args.sessionId,
  } as Partial<BridgeMessage> & { type: string });
}

/** Use the engine's resolved CLI so the embedded terminal runs the same binary; otherwise defer to the login shell PATH. */
export async function bridgeResolveAgentBinary(
  bridge: RuntimeClient,
  agentId: string,
  timeoutMs = 5_000,
): Promise<string> {
  try {
    const resp = (await bridge.request(
      {
        type: "RESOLVE_AGENT_BINARY",
        agentId,
      } as Partial<BridgeMessage> & { type: string },
      timeoutMs,
    )) as { path?: string };
    return typeof resp.path === "string" && resp.path ? resp.path : agentId;
  } catch {
    return agentId;
  }
}

/** Only the Local engine exposes PID roots for all its terminals; a missing field does not prove there are none. */
export async function bridgePtyProcessPids(
  bridge: RuntimeClient,
  timeoutMs = 10_000,
): Promise<number[]> {
  const resp = (await bridge.request(
    { type: "PTY_LIST" } as Partial<BridgeMessage> & { type: string },
    timeoutMs,
  )) as {
    processPids?: unknown[];
  };
  if (!Array.isArray(resp.processPids)) {
    throw new Error("PTY_LIST returned no local process PID snapshot");
  }
  return resp.processPids.map((pid) => {
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid < 0 ||
      pid > 2_147_483_647
    ) {
      throw new Error("PTY_LIST returned an invalid local process PID");
    }
    return pid;
  });
}

/** The legacy native-shape list is not the shared registry or the PID census. */
export async function bridgePtyList(
  _bridge: RuntimeClient,
): Promise<PtySessionInfo[]> {
  return [];
}

export interface PtyTerminalLike {
  sessionId: string;
  workspaceId: string | null;
  cwd: string;
  createdAt: number;
  /** True when the shell exited in place (shown as "(exited)", restartable). */
  exited?: boolean;
}

/** The engine filters relay discovery and independently authorizes reattach against the stored workspace. */
export async function bridgePtyTerminals(
  bridge: RuntimeClient,
  workspaceId?: string,
  timeoutMs = 10_000,
): Promise<PtyTerminalLike[]> {
  const resp = (await bridge.request(
    {
      type: "PTY_LIST",
      ...(workspaceId ? { workspaceId } : {}),
    } as Partial<BridgeMessage> & { type: string },
    timeoutMs,
  )) as { terminals?: PtyTerminalLike[] };
  if (!Array.isArray(resp.terminals)) {
    throw new Error("PTY_LIST returned an invalid terminal snapshot");
  }
  return resp.terminals;
}

/** A change push invalidates the shared list; it does not carry the replacement snapshot. */
export function subscribeBridgePtyTerminalsChanged(
  bridge: RuntimeClient,
  handler: () => void,
): () => void {
  return bridge.on("PTY_TERMINALS_CHANGED", () => handler());
}

/** Subscribers receive all owned sessions and must filter by sessionId. */
export function subscribeBridgePtyData(
  bridge: RuntimeClient,
  handler: (evt: PtyDataEvent) => void,
): () => void {
  return bridge.on("PTY_DATA", (msg) => {
    const m = msg as unknown as PtyDataLike;
    handler({ sessionId: m.sessionId, data: m.data });
  });
}

export function subscribeBridgePtyExit(
  bridge: RuntimeClient,
  handler: (evt: PtyExitEvent) => void,
): () => void {
  return bridge.on("PTY_EXIT", (msg) => {
    const m = msg as unknown as PtyExitLike;
    handler({
      sessionId: m.sessionId,
      exitCode: m.exitCode,
      signal: m.signal,
      reason: m.reason,
    });
  });
}

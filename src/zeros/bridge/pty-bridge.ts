// ──────────────────────────────────────────────────────────
// pty-bridge — renderer-side PTY-over-bridge client (WEB build)
// ──────────────────────────────────────────────────────────
//
// The engine owns node-pty sessions (src/engine/pty/service.ts) and drives them
// for clients over the bridge: PTY_CREATE → PTY_CREATED (correlated by
// requestId, so RuntimeClient.request resolves on it), then PTY_WRITE /
// PTY_RESIZE / PTY_KILL fire-and-forget, with output streaming back as PTY_DATA
// and termination as PTY_EXIT (both addressed to the owning client). On the WEB
// build this rides the relay; native/pty.ts routes through here instead of the
// (absent) electron IPC. Mirrors the WORKSPACE_REQUEST pattern in
// workspace-bridge.ts.
//
// Reattach scrollback: the engine now keeps a per-session headless-terminal
// mirror (src/engine/pty/mirror.ts) and serializes its resolved grid on
// reattach, so PTY_CREATED carries `reattached` + `replay` — a web refresh /
// panel reopen repaints the exact pre-existing screen (parity with desktop).
// There's still no PTY_LIST message in the protocol, so listing returns [].
// ──────────────────────────────────────────────────────────

import type { RuntimeClient } from "./ws-client";
import type { BridgeMessage } from "./messages";
import type {
  PtySessionInfo,
  PtyDataEvent,
  PtyExitEvent,
} from "../../native/pty";
import type { PtyExitReason } from "@zeros/core/messages";

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

/** Request a host PTY over the bridge and map PTY_CREATED → the renderer's
 *  PtySessionInfo. Remote (relay) creation is host-approved engine-side; we just
 *  send and await — a denied create comes back as a PTY_EXIT (no PTY_CREATED),
 *  so request() times out and we surface it to the caller as null.
 *
 *  The engine's PTY_CREATED carries no `shell` (the spawn uses the host login
 *  shell), so we report an empty shell string. On reattach it DOES carry a
 *  serialized scrollback snapshot (`reattached` + `replay`), which we pass
 *  through so the panel repaints the pre-existing screen. */
export async function bridgePtyCreate(
  bridge: RuntimeClient,
  args: {
    sessionId: string;
    cwd: string;
    cols: number;
    rows: number;
    ephemeral?: boolean;
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
      } as Partial<BridgeMessage> & { type: string },
      timeoutMs,
    )) as PtyCreatedLike;
    return {
      sessionId: resp.sessionId,
      pid: resp.pid,
      cwd: resp.cwd,
      // The engine spawns the host login shell; PTY_CREATED carries no shell
      // path. The terminal panel doesn't read this field, so "" is safe.
      shell: "",
      cols: resp.cols,
      rows: resp.rows,
      // Reattach snapshot (engine-side mirror) — present only when the engine
      // handed back an existing session; the panel writes `replay` into a fresh
      // xterm before binding live data so scrollback survives a refresh.
      reattached: resp.reattached,
      replay: resp.replay,
      replayTruncated: resp.replayTruncated,
      replayBytes: resp.replayBytes,
    };
  } catch {
    // Timeout / denied create / transport gone — degrade like the browser
    // no-op path (panel shows its "unavailable" state).
    return null;
  }
}

/** Fire-and-forget keystrokes to a host PTY. */
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

/** Fire-and-forget resize of a host PTY. */
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

/** Fire-and-forget kill of a host PTY. */
export function bridgePtyKill(
  bridge: RuntimeClient,
  args: { sessionId: string },
): void {
  bridge.send({
    type: "PTY_KILL",
    sessionId: args.sessionId,
  } as Partial<BridgeMessage> & { type: string });
}

/** Resolve an agent's on-disk CLI binary path over the bridge (engine-side;
 *  the renderer can't stat the filesystem). The embedded-terminal commands use
 *  it to run the SAME `claude` the agent uses. Falls back to the bare agent id
 *  on timeout / no reply (the login-shell PATH still resolves it). */
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

/** List host PTYs over the bridge in the native ptyList() shape. The shared
 *  terminal LIST is exposed separately via bridgePtyTerminals (richer shape with
 *  workspace + createdAt); this legacy shim stays [] so callers that only need
 *  the native PtySessionInfo[] don't special-case web. */
export async function bridgePtyList(
  _bridge: RuntimeClient,
): Promise<PtySessionInfo[]> {
  return [];
}

/** One shared terminal as the engine reports it (PTY_LIST_RESULT). */
export interface PtyTerminalLike {
  sessionId: string;
  workspaceId: string | null;
  cwd: string;
  createdAt: number;
  /** True when the shell exited in place (shown as "(exited)", restartable). */
  exited?: boolean;
}

/** Fetch the SHARED terminal list (multiplayer): every paired device sees the
 *  SAME terminals, so a device can discover + attach to one another device
 *  created. The engine scopes this for a relay client to non-restricted
 *  workspaces (fail-closed). Optionally scoped to a single workspace. */
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

/** Subscribe to "the shared terminal set changed" pushes (a terminal was created
 *  or exited on any device) so the tab strip re-fetches bridgePtyTerminals and
 *  stays in sync across devices. Returns an unsubscribe fn. */
export function subscribeBridgePtyTerminalsChanged(
  bridge: RuntimeClient,
  handler: () => void,
): () => void {
  return bridge.on("PTY_TERMINALS_CHANGED", () => handler());
}

/** Subscribe to PTY_DATA chunks for ALL sessions this client owns; map → the
 *  renderer's PtyDataEvent. The caller filters by sessionId (same contract as
 *  the electron `pty-data` listener). Returns an unsubscribe fn. */
export function subscribeBridgePtyData(
  bridge: RuntimeClient,
  handler: (evt: PtyDataEvent) => void,
): () => void {
  return bridge.on("PTY_DATA", (msg) => {
    const m = msg as unknown as PtyDataLike;
    handler({ sessionId: m.sessionId, data: m.data });
  });
}

/** Subscribe to PTY_EXIT events; map → the renderer's PtyExitEvent. Returns an
 *  unsubscribe fn. */
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

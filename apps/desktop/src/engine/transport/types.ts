// ──────────────────────────────────────────────────────────
// Transport abstraction — decouples ZerosEngine from how clients connect
// ──────────────────────────────────────────────────────────
//
// The engine no longer talks to a concrete WebSocket server. It talks to
// one or more Transports, each surfacing connected peers as
// TransportClients. LocalTransport is the loopback `ws` server (unchanged
// behavior). CloudTransport is the only non-local transport and is reached
// through an Electron-owned SSH loopback tunnel. The old relay transport is
// gone.
// ──────────────────────────────────────────────────────────

import type { EngineMessage } from "../types";

export interface TransportClient {
  /** Stable per-connection id. */
  readonly id: string;
  /** Where this client connected from. The local desktop is trusted; cloud
   *  clients are remote peers and go through remote account/workspace gates. */
  readonly kind: "local" | "cloud";
  /** Server-asserted account/execution identity for a cloud admission. Local
   * clients and image qualification probes intentionally omit it. */
  readonly accountUserId?: string | null;
  readonly authorityEpoch?: number | null;
  /** Send an engine message to this client (serialized + encrypted as needed). */
  send(msg: EngineMessage): void;
  close(code?: number, reason?: string): void;
}

export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  onConnect(handler: (client: TransportClient) => void): void;
  onDisconnect(handler: (client: TransportClient) => void): void;
  onMessage(
    handler: (
      client: TransportClient,
      msg: EngineMessage,
    ) => void | Promise<void>,
  ): void;
  /** Send to every client on this transport. */
  broadcast(msg: EngineMessage): void;
}

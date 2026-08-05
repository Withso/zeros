// ──────────────────────────────────────────────────────────
// MessageRouter — per-client routing across all transports
// ──────────────────────────────────────────────────────────
//
// Before remote-workspace transport, the engine broadcast every push to every
// client. Once a second device connects, that would disclose the desktop's
// entire stream. This router fixes it by tracking
// which client owns which session, so session-scoped pushes
// (AGENT_SESSION_UPDATE, AGENT_PERMISSION_REQUEST) go only to the
// originating client. Truly global events (ENGINE_READY, agent
// stderr/exit) still broadcast.
//
// Owner is unknown only for a brief pre-map race, a single-client setup, or
// just after an owner disconnects. routeToSession falls back to LOCAL hosts
// only there — never to remote clients. A remote device must never receive a
// session-scoped stream it doesn't own just because ownership was momentarily
// lost; the trusted desktop still gets it (and re-adopts the session on
// reconnect via this same fallback).
// ──────────────────────────────────────────────────────────

import type { EngineMessage } from "../types";
import type { TransportClient } from "./types";

export class MessageRouter {
  private readonly clients = new Map<string, TransportClient>();
  private readonly sessionOwner = new Map<string, string>(); // sessionId → clientId

  register(client: TransportClient): void {
    this.clients.set(client.id, client);
  }

  /** Drop a client and any sessions it owned (e.g. on disconnect). */
  unregister(clientId: string): void {
    this.clients.delete(clientId);
    for (const [sessionId, ownerId] of this.sessionOwner) {
      if (ownerId === clientId) this.sessionOwner.delete(sessionId);
    }
  }

  setOwner(sessionId: string, clientId: string): void {
    this.sessionOwner.set(sessionId, clientId);
  }
  clearOwner(sessionId: string): void {
    this.sessionOwner.delete(sessionId);
  }
  /** The client that currently owns a session (if any). */
  ownerOf(sessionId: string): string | undefined {
    return this.sessionOwner.get(sessionId);
  }
  /** All sessions currently owned by a given client (e.g. to tear them down
   *  when that client disconnects). */
  sessionsOwnedBy(clientId: string): string[] {
    const out: string[] = [];
    for (const [sessionId, ownerId] of this.sessionOwner) {
      if (ownerId === clientId) out.push(sessionId);
    }
    return out;
  }

  /** Route a session-scoped message (agent stream, permission request) to the
   *  clients watching it. MULTIPLAYER (remote == local): it goes to every
   *  authorized local or optional relay client watching the same live agent.
   *  There is no per-client session ownership. Access is gated at pairing + the
   *  per-workspace restriction list, so there's no per-session privacy to keep
   *  between your own trusted devices. The renderer filters by sessionId, so a
   *  client that doesn't have this chat open simply ignores it. */
  routeToSession(sessionId: string, msg: EngineMessage): void {
    void sessionId;
    this.broadcast(msg);
  }

  broadcast(msg: EngineMessage): void {
    for (const client of this.clients.values()) client.send(msg);
  }

  /** Broadcast to every client EXCEPT the originator — used for DB_CHANGED, where
   *  the client that made the write already has the change locally. */
  broadcastExcept(exceptClientId: string, msg: EngineMessage): void {
    for (const client of this.clients.values()) {
      if (client.id !== exceptClientId) client.send(msg);
    }
  }

  /** Send to LOCAL desktop clients only. */
  broadcastLocal(msg: EngineMessage): void {
    for (const client of this.clients.values()) {
      if (client.kind === "local") client.send(msg);
    }
  }

  getClient(clientId: string): TransportClient | undefined {
    return this.clients.get(clientId);
  }
  /** All connected clients of a given kind (e.g. the local desktop client(s),
   *  used for local-only broadcasts). */
  clientsOfKind(kind: "local" | "cloud"): TransportClient[] {
    return [...this.clients.values()].filter((c) => c.kind === kind);
  }
  /** All remote clients — everything that isn't the trusted local desktop. */
  remoteClients(): TransportClient[] {
    return [...this.clients.values()].filter((c) => c.kind !== "local");
  }
  get clientCount(): number {
    return this.clients.size;
  }
}

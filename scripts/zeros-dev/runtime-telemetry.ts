import { randomUUID } from "node:crypto";
import { cloudBridgeCloseDiagnostic } from "@zeros/protocol/cloud-bridge-diagnostics";
import type { RuntimeClientEnvironment } from "../../apps/desktop/src/renderer/platform/bridge/runtime-client";
import { TransportObservationSchema, type TransportObservation } from "./gate0-contract";

/** Counts at the actual socket factory and authenticated-ready boundary. The
 * shared client's human-readable logger is throttled and is not a denominator.
 * No URL, protocol, frame, account or free-form reason leaves this object. */
export class RuntimeTelemetry {
  private route: "direct" | "relay" | null = null;
  private current?: { route: "direct" | "relay" | null; ready: boolean; closed: boolean; expected: boolean };
  private readonly attempts = new Set<NonNullable<RuntimeTelemetry["current"]>>();
  private readonly value: TransportObservation = { connectionId: randomUUID(), coverage: "complete",
    directAttempts: 0, directReady: 0, relayAttempts: 0, relayReady: 0, lostConnections: 0,
    authorityCloses: 0, unexplainedAuthorityCloses: 0 };

  target(channel: string): void {
    this.route = channel === "direct-provider-websocket" ? "direct" : channel === "control-plane-websocket" ? "relay" : null;
    if (!this.route) this.value.coverage = "unavailable";
  }
  wrap(environment: RuntimeClientEnvironment): RuntimeClientEnvironment {
    return { ...environment, createWebSocket: (url, protocols) => {
      const attempt = { route: this.route, ready: false, closed: false, expected: false };
      this.current = attempt; this.attempts.add(attempt);
      if (attempt.route === "direct") this.value.directAttempts++;
      else if (attempt.route === "relay") this.value.relayAttempts++;
      else this.value.coverage = "unavailable";
      const socket = environment.createWebSocket(url, protocols);
      if (typeof socket.addEventListener !== "function") { this.value.coverage = "unavailable"; return socket; }
      socket.addEventListener("close", event => {
        if (attempt.closed) return;
        attempt.closed = true; this.attempts.delete(attempt);
        const { class: category } = cloudBridgeCloseDiagnostic(event.code, event.reason);
        const authority = ["authority_expired", "authority_revoked", "authority_unavailable", "account_binding_required", "actor_forbidden"].includes(category);
        if (attempt.ready && !attempt.expected) this.value.lostConnections++;
        if (authority) { this.value.authorityCloses++; this.value.unexplainedAuthorityCloses++; }
        if (!attempt.expected || authority) this.value.firstClose ??= ["authority_expired", "authority_revoked", "authority_unavailable",
          "account_binding_required", "actor_forbidden", "protocol_mismatch", "handshake_failed", "engine_shutdown", "abnormal"].includes(category)
          ? category as TransportObservation["firstClose"] : "other";
      }, { once: true });
      return socket;
    } };
  }
  status(status: string): void {
    const attempt = this.current;
    if (status !== "connected" || !attempt || attempt.ready || attempt.closed) return;
    attempt.ready = true;
    if (attempt.route === "direct") this.value.directReady++;
    else if (attempt.route === "relay") this.value.relayReady++;
  }
  expectDisconnect(): void { for (const attempt of this.attempts) attempt.expected = true; }
  snapshot(): TransportObservation { return TransportObservationSchema.parse(this.value); }
}

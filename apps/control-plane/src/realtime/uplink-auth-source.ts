import type { UplinkIdentity } from "./uplink-authority.js";
import type { UplinkAuthSnapshot, UplinkJwk } from "./uplink-protocol.js";

/** Epochs, revocations and keys for the `auth` channel (S1). The capability
 * authority (track B) implements this; realtime never derives epochs itself. */
export interface UplinkAuthSource {
  /** The current JWKS: one to three keys (`next`, `current`, `retiring`). */
  keys(): Promise<readonly UplinkJwk[]>;
  /** Epochs for the S1 snapshot scope of the engine's workspace plus every
   * revocation since `authCursor`; `complete` when the cursor is too old. */
  snapshot(identity: UplinkIdentity, authCursor: string | undefined): Promise<UplinkAuthSnapshot>;
}

export type EngineCapabilityResult =
  | { ok: true; token: string; expiresAtMs: number }
  /** `authority`: the engine instance is no longer current (close 4403).
   * `unavailable`: the issuer could not answer; retried later. */
  | { ok: false; reason: "authority" | "unavailable" };

/** Engine `zeros:api` capabilities are signed by `api` from current
 * authority on request from realtime, never by realtime itself. */
export interface EngineCapabilityIssuer {
  issue(identity: UplinkIdentity): Promise<EngineCapabilityResult>;
}

/** The uplink's `auth` dependencies until the capability authority is wired
 * into this process. Null keeps the uplink unmounted: the frozen handshake
 * cannot complete without keys and epochs. */
export function uplinkCapabilityAuthority(): { source: UplinkAuthSource; issuer: EngineCapabilityIssuer } | null {
  return null;
}

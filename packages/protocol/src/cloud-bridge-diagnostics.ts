/** Close frames are untrusted. Only these engine-authored reason classes may
 * leave the transport in diagnostics; arbitrary reason text is never logged.
 * Mirrored in apps/control-plane/src/cloud-workspaces/bridge-close-diagnostic.ts
 * (the service type-checks without this package); parity is tested there. */
export const CLOUD_BRIDGE_CLOSE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  "CONNECTED required": "handshake_required",
  "CONNECTED handler failed": "handshake_failed",
  "pre-auth queue limit": "handshake_queue_limit",
  "client authority expired": "authority_expired",
  "client authority revoked": "authority_revoked",
  "client authority unavailable": "authority_unavailable",
  "account binding required": "account_binding_required",
  "workspace operation denied": "actor_forbidden",
  "protocol version mismatch": "protocol_mismatch",
  "message handler failed": "handler_failed",
  "message queue limit": "handler_queue_limit",
  "outbound buffer limit": "outbound_limit",
  "Engine shutting down": "engine_shutdown",
  "cloud handshake failed": "handshake_failed",
});
export function cloudBridgeCloseDiagnostic(code: unknown, reason: unknown) {
  return {
    code: typeof code === "number" && Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : null,
    class: typeof reason === "string" && Object.hasOwn(CLOUD_BRIDGE_CLOSE_REASONS, reason) ? CLOUD_BRIDGE_CLOSE_REASONS[reason]
      : reason ? "other" : code === 1006 ? "abnormal" : "empty",
  };
}

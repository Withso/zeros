// ──────────────────────────────────────────────────────────
// Bridge protocol versioning
// ──────────────────────────────────────────────────────────
//
// A remote client (phone/web) may run an older protocol than the
// desktop engine — app-store review lag guarantees version skew.
// The handshake negotiates the highest mutually-supported version;
// incompatible peers are rejected cleanly rather than silently
// mis-parsing each other's frames.
//
// Bump PROTOCOL_VERSION whenever a wire-incompatible change lands.
// Bump MIN_SUPPORTED_PROTOCOL only when dropping support for an old
// client is acceptable (be conservative — a stale phone is common).
// ──────────────────────────────────────────────────────────

/** Current wire-protocol version this build speaks. */
export const PROTOCOL_VERSION = 6 as const;

/** Oldest protocol version this build will still accept from a peer. */
export const MIN_SUPPORTED_PROTOCOL = 2 as const;

/** True when a peer's protocol version is acceptable to this build. */
export function isCompatible(
  remoteVersion: number,
  minSupported: number = MIN_SUPPORTED_PROTOCOL,
  maxSupported: number = PROTOCOL_VERSION,
): boolean {
  return (
    Number.isInteger(remoteVersion) &&
    remoteVersion >= minSupported &&
    remoteVersion <= maxSupported
  );
}


/** Bump for a wire-incompatible change. */
export const PROTOCOL_VERSION = 21 as const;

/** Raise only when dropping support for older deployed clients is acceptable. */
export const MIN_SUPPORTED_PROTOCOL = 2 as const;

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

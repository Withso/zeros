/** Decode only local file URLs emitted by the trusted browser artifact host.
 * Remote URLs and network file authorities never become native shell paths. */
export function localArtifactPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:" || parsed.hostname) return null;
    const path = decodeURIComponent(parsed.pathname);
    return path.startsWith("/") ? path : null;
  } catch {
    return null;
  }
}

/** Persist the live runtime identity only as an atomic pair. Codex's native
 * thread id is a distinct durable resume handle, while other providers leave
 * it unset and continue using the Zeros session id for both purposes. */
export function sessionIdentityUpdate(
  persisted: {
    sessionId?: string;
    nativeSessionId?: string;
  },
  liveSessionId: string | null,
  liveNativeSessionId: string | null,
): { sessionId: string; nativeSessionId: string | undefined } | null {
  if (!liveSessionId) return null;
  const nativeSessionId = liveNativeSessionId ?? undefined;
  if (
    persisted.sessionId === liveSessionId &&
    persisted.nativeSessionId === nativeSessionId
  ) {
    return null;
  }
  return { sessionId: liveSessionId, nativeSessionId };
}

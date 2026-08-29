import type { SessionStatus } from "./use-agent-session";

/** During bind, providers first report their native default and Zeros then
 * reconciles the chat's persisted choice. Prefer that persisted choice while
 * the session is warming so the icon does not flash through an intermediate
 * mode. Once ready, live provider updates are authoritative. */
export function permissionModeIdForDisplay(input: {
  status: SessionStatus;
  liveModeId: string | null;
  persistedModeId: string | null;
  fallbackModeId: string | null;
}): string | null {
  if (input.status === "warming") {
    return (
      input.persistedModeId ?? input.liveModeId ?? input.fallbackModeId ?? null
    );
  }
  return (
    input.liveModeId ?? input.persistedModeId ?? input.fallbackModeId ?? null
  );
}

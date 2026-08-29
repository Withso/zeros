/** Workspace errors that mean the connected engine cannot perform a
 * host-local browser open. The trusted renderer should switch to the headless
 * OAuth handshake, open the returned URL on this device, and keep the
 * paste-code fallback visible. */
export function shouldUseHeadlessMcpAuth(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === "REMOTE_OP_NOT_ALLOWED" || code === "SETTINGS_REMOTE_KEY_DENIED"
  );
}

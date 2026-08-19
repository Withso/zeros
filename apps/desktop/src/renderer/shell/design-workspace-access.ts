/** Should the workspace route show the "design mode is disabled" placeholder?
 *
 * Under the mode model a design-MODE workspace stays fully visible and
 * reachable when the `designWorkspaces` Internal flag is off — hiding it (or
 * bouncing to Home, as pre-mode builds did) would trap the workspace in a
 * mode whose surface can't render, with no way back. Instead the route mounts
 * a placeholder whose one action — exit design mode — is deliberately never
 * flag-gated.
 *
 * Fail-closed while staff identity is loading: neither the design UI nor the
 * placeholder mounts until the access decision settles, so a staff user whose
 * flag is about to land never sees a placeholder flash, and a non-staff user
 * never sees the design canvas flash. */
export function shouldShowBlockedDesignModePlaceholder(input: {
  workspaceRoute: boolean;
  designRequested: boolean;
  designActive: boolean;
  internalUserResolutionSettled: boolean;
}): boolean {
  return (
    input.workspaceRoute &&
    input.designRequested &&
    !input.designActive &&
    input.internalUserResolutionSettled
  );
}

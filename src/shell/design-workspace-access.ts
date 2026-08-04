/** A blocked design destination remains inert while staff identity is loading.
 * Once the access decision settles off, leave the route without ever mounting
 * the coding harness as a fallback. */
export function shouldLeaveBlockedDesignWorkspace(input: {
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

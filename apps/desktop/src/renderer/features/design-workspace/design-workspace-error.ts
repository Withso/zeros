// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Workbench
// ============================================

// --- IMPORTS ---





// --- WORKFLOWS ---

export function errorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "The design could not load.";
  // Raw transport diagnostics ("Request timeout: WORKSPACE_REQUEST",
  // "Engine swapping — request aborted") describe the bridge, not the user's
  // edit. The write may still have landed; stale-generation replay and the
  // reconnect revalidation converge the canvas either way.
  if (
    /^Request timeout: /.test(message) ||
    message.includes("Engine swapping — request aborted")
  ) {
    return "The workspace engine didn't respond in time. If the change applied, the canvas catches up automatically — otherwise try again.";
  }
  return message;
}

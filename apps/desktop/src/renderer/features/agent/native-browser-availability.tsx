/** Shared cloud provider/session copy. No installation or Local settings
 * action belongs here: cloud workspaces have no browser. */
export function NativeBrowserAvailability({ provider }: { provider: string | null }) {
  if (provider !== "codex" && provider !== "claude" && provider !== "cursor") return null;
  return <span className="text-fg2 text-xs">Native browser is unavailable in cloud workspaces.</span>;
}

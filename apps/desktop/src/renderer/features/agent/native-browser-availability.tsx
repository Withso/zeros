export const NATIVE_BROWSER_UNAVAILABLE = "Native browser is unavailable in cloud workspaces.";

export function NativeBrowserAvailability({ provider }: { provider: string | null }) {
  if (provider !== "codex" && provider !== "claude" && provider !== "cursor") return null;
  return <span className="text-fg2 text-xs">{NATIVE_BROWSER_UNAVAILABLE}</span>;
}

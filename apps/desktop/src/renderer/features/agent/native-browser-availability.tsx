import {
  resolveCloudBrowserCapability,
  type CloudBrowserCapability,
} from "@zeros/protocol/containment";

/** Shared cloud provider/session copy. No installation or Local settings
 * action belongs here: neither supplies a browser to the workspace VM. */
export function NativeBrowserAvailability({
  provider,
  capability,
}: {
  provider: string | null;
  capability?: CloudBrowserCapability | null;
}) {
  if (provider !== "codex" && provider !== "claude" && provider !== "cursor") return null;
  const browser = resolveCloudBrowserCapability(provider, capability);
  if (browser.state === "ready") return <span className="text-fg2 text-xs">Native browser is ready.</span>;
  if (browser.state === "disabled") return <span className="text-fg2 text-xs">Native browser is disabled.</span>;
  const detail = provider === "codex"
    ? "The official browser runtime is not available for Linux VMs."
    : provider === "claude"
      ? "Chrome integration requires a direct Claude login, not an API key or setup token."
      : "Cursor does not expose a native browser integration.";
  return (
    <span className="text-fg2 flex flex-col gap-1 text-xs">
      <span>Native browser is unavailable in cloud workspaces.</span>
      <span>{detail}</span>
    </span>
  );
}

import type { ExecutionBoundaryStatus } from "@zeros/protocol/containment";

// Whether ordinary Code chats may load provider-owned account MCP. Each
// adapter separately excludes unimported local declarations. The historical
// environment name remains a host opt-out; it cannot grant local MCP access.
// Cursor also uses this account opt-out for team rules and managed skills.
// Design actors and tool-free helpers keep only their admitted tools.

export function nativeMcpPassthroughEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
  boundary?: { status?: Pick<ExecutionBoundaryStatus, "actor"> },
): boolean {
  // Legacy direct adapter callers can supply a boundary without status. Keep
  // their prior scoped behavior until its Code ownership is known.
  if (boundary && boundary.status?.actor !== "agent-code") return false;
  return env.ZEROS_NATIVE_MCP_PASSTHROUGH !== "0";
}

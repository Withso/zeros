import type { ExecutionBoundaryStatus } from "@zeros/protocol/containment";

// Whether ordinary Code chats may load provider-owned MCP. Claude and Cursor
// Code chats load their native settings sources, including MCP servers
// declared in local configuration; Codex still excludes unimported local
// declarations. The historical environment name remains a host opt-out.
// Cursor also uses this account opt-out for team rules and managed skills.
// Design actors and tool-free helpers keep only their admitted tools.

type BoundaryActor = { status?: Pick<ExecutionBoundaryStatus, "actor"> };

/** An ordinary Code chat: uncontained, or contained as the Code actor. Legacy
 *  direct adapter callers can supply a boundary without status; they keep
 *  their prior scoped behavior until its Code ownership is known. */
export function isNativeCodeActor(boundary?: BoundaryActor): boolean {
  return !boundary || boundary.status?.actor === "agent-code";
}

export function nativeMcpPassthroughEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
  boundary?: BoundaryActor,
): boolean {
  if (!isNativeCodeActor(boundary)) return false;
  return env.ZEROS_NATIVE_MCP_PASSTHROUGH !== "0";
}

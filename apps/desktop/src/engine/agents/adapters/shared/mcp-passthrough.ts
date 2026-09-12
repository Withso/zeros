// Native MCP scope is independent of inventory visibility. Customize lists
// native declarations without importing their credentials or unrelated config.
//
// With pass-through off, Claude uses strictMcpConfig; Codex disables native
// server names except the account app bridge and Zeros-injected servers; Cursor
// retains project/team/MDM sources because its SDK couples MCP with rules.
//
// Codex Apps are visible through supported account APIs and authenticated by
// Codex. Normal chats preserve that bridge; tool-free title threads disable it.
// Claude cloud connectors are shown when an existing SDK session reports them.
// Inventory reads never widen Claude/Cursor settingSources or change modes.
//
// ZEROS_NATIVE_MCP_PASSTHROUGH=1 remains a diagnostic escape hatch, not a
// product preference. Keep provider-specific enforcement at adapter call sites.

/** Whether normal sessions may additionally load all native MCP sources. */
export function nativeMcpPassthroughEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.ZEROS_NATIVE_MCP_PASSTHROUGH === "1";
}

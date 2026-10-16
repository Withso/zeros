import type { AgentComputerUse } from "../../types";
import type { NativeMcpSurface } from "./native-mcp";

/** OpenAI's bundled computer-use plugins. The unified plugin serves
 * `cua_repl`; the older plugin served `computer-use`. */
export const CODEX_COMPUTER_USE_PLUGIN_IDS = [
  "computer-use@openai-bundled",
  "unified-computer-use@openai-bundled",
] as const;
export const CODEX_COMPUTER_USE_SERVERS: readonly string[] = [
  "cua_repl",
  "computer-use",
];

function codexNativeOff(computerUse: AgentComputerUse | undefined): boolean {
  return computerUse?.codexNative === false;
}

/** An MCP tool call that is Codex's built-in computer use acting. */
export function isCodexComputerUseServer(server: unknown): boolean {
  return (
    typeof server === "string" && CODEX_COMPUTER_USE_SERVERS.includes(server)
  );
}

/** Add the computer-use servers to the thread's native MCP disables when
 * Settings turned Codex's own computer use off. Going through the native
 * surface keeps a configured HTTP namesake valid and lets the caller's
 * Zeros-registry scoping keep a server Zeros itself registered. */
export function withCodexComputerUseDisabled(
  surface: NativeMcpSurface,
  computerUse: AgentComputerUse | undefined,
): NativeMcpSurface {
  if (!codexNativeOff(computerUse)) return surface;
  return {
    ...surface,
    serverNames: [
      ...new Set([...surface.serverNames, ...CODEX_COMPUTER_USE_SERVERS]),
    ],
  };
}

/** Thread-scoped plugin gates, so Codex also loses the plugins' skills and
 * instructions. Dotted like `codexBrowserThreadConfig`; these ids contain no
 * `.`. Absent or on leaves Codex's own configuration alone. */
export function codexComputerUseThreadConfig(
  computerUse: AgentComputerUse | undefined,
): Record<string, boolean> {
  if (!codexNativeOff(computerUse)) return {};
  return Object.fromEntries(
    CODEX_COMPUTER_USE_PLUGIN_IDS.map((id) => [`plugins.${id}.enabled`, false]),
  );
}

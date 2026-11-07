import type { NativeMcpSurface } from "./native-mcp";

/** OpenAI's bundled browser and computer-use plugins. Codex uses Zeros
 * computer use and the Zeros browser like every agent, so every Zeros thread
 * turns these off: the plugin gate removes their skills and instructions, and
 * native MCP discovery disables their servers like any unimported local one. */
export const CODEX_BUILT_IN_PLUGIN_IDS = [
  "browser@openai-bundled",
  "chrome@openai-bundled",
  "computer-use@openai-bundled",
  "unified-computer-use@openai-bundled",
] as const;

/** The computer-use plugins' servers: the unified plugin serves `cua_repl`,
 * the older one `computer-use`. Disabled by name too, so a Codex build whose
 * plugin listing misses them still cannot reach the Mac through them. */
export const CODEX_COMPUTER_USE_SERVERS: readonly string[] = [
  "cua_repl",
  "computer-use",
];

/** Add the computer-use servers to the thread's native MCP disables. Going
 * through the native surface keeps a configured HTTP namesake valid and lets
 * the caller's Zeros-registry scoping keep a server Zeros itself registered. */
export function withCodexBuiltInServersDisabled(
  surface: NativeMcpSurface,
): NativeMcpSurface {
  return {
    ...surface,
    serverNames: [
      ...new Set([...surface.serverNames, ...CODEX_COMPUTER_USE_SERVERS]),
    ],
  };
}

/** Thread-scoped plugin gates. Dotted like other thread config keys; these
 * ids contain no `.`. */
export function codexBuiltInPluginsThreadConfig(): Record<string, boolean> {
  return Object.fromEntries(
    CODEX_BUILT_IN_PLUGIN_IDS.map((id) => [`plugins.${id}.enabled`, false]),
  );
}

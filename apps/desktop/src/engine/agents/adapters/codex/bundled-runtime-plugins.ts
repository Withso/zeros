import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { PluginMarketplaceEntry } from "./generated/v2/PluginMarketplaceEntry";
import type { PluginSummary } from "./generated/v2/PluginSummary";

const RUNTIME_PLUGINS = new Set([
  "browser",
  "chrome",
  "computer-use",
  "unified-computer-use",
]);

/** Desktop materializes its own runtime plugins as source.type=local. Those
 * are provider capabilities, not user-declared MCPs. Require the exact bundled
 * identity and selected CODEX_HOME's materialization; a namesake marketplace,
 * another account's home, or an arbitrary local package gets no exemption.
 * This classifies provider provenance, not a code-signature/security attestation.
 */
export async function isBundledCodexRuntimePlugin(
  market: Pick<PluginMarketplaceEntry, "name">,
  plugin: PluginSummary,
  codexHome?: string,
): Promise<boolean> {
  if (
    market.name !== "openai-bundled" ||
    !RUNTIME_PLUGINS.has(plugin.name) ||
    plugin.id !== `${plugin.name}@openai-bundled` ||
    plugin.source.type !== "local" ||
    !isAbsolute(plugin.source.path)
  )
    return false;
  const home = resolve(
    codexHome || process.env.CODEX_HOME || join(homedir(), ".codex"),
  );
  const materialized = join(
    home,
    ".tmp/bundled-marketplaces/openai-bundled/plugins",
    plugin.name,
  );
  if (resolve(plugin.source.path) !== materialized) return false;
  try {
    const root = await realpath(materialized);
    const cache = await realpath(
      join(home, "plugins/cache/openai-bundled", plugin.name),
    ).catch(() => null);
    // Current Desktop copies its package; older versions link a cache version.
    const cacheRelative = cache ? relative(cache, root) : null;
    if (
      root !== materialized &&
      (!cacheRelative ||
        cacheRelative.startsWith("..") ||
        isAbsolute(cacheRelative))
    )
      return false;
    const handle = await open(join(root, ".codex-plugin/plugin.json"), "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 64 * 1024) return false;
      const manifest = JSON.parse(await handle.readFile("utf8")) as {
        name?: unknown;
      };
      return manifest.name === plugin.name;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

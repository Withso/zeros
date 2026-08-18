import { createHash } from "node:crypto";
import {
  open,
  readFile,
  readdir,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

import type { McpServerRegistration } from "../../types";
import type { CodexUserInput } from "./app-server";

const BROWSER_PLUGIN_ID = "browser@openai-bundled";
const MAX_BROWSER_CLIENT_BYTES = 16 * 1024 * 1024;

export interface CodexNativeBrowserRuntime {
  pluginId: typeof BROWSER_PLUGIN_ID;
  pluginRoot: string;
  browserSkill: CodexNativeBrowserSkill;
  mcpServer: Extract<McpServerRegistration, { transport: "stdio" }>;
}

export interface CodexNativeBrowserSkill {
  /** SKILL.md frontmatter name. The plugin qualification belongs to the `$`
   * marker; app-server's typed skill item uses this unqualified identity. */
  name: "control-in-app-browser";
  path: string;
}

export interface ResolveCodexNativeBrowserRuntimeOptions {
  runtimeRoots?: readonly string[];
  pluginRoots?: readonly string[];
  codexCliPath?: string;
  codexHome?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Record<string, string | undefined>;
}

/** The official Codex Browser plugin is the only browser surface exposed to
 * Codex. The feature gates are thread-scoped and do not mutate config.toml. */
export function codexBrowserThreadConfig(
  nativeBrowserAvailable: boolean,
): Record<string, boolean> {
  if (!nativeBrowserAvailable) {
    return { "plugins.browser@openai-bundled.enabled": false };
  }
  return {
    "plugins.browser@openai-bundled.enabled": true,
  };
}

/** Locate—not copy—the official Browser plugin and OpenAI node_repl runtime.
 * ChatGPT/Codex Desktop installs these outside the public @openai/codex CLI
 * package. If either half is absent or malformed we fail closed and leave the
 * Browser plugin disabled instead of substituting Zeros tools. */
export async function resolveCodexNativeBrowserRuntime(
  options: ResolveCodexNativeBrowserRuntimeOptions = {},
): Promise<CodexNativeBrowserRuntime | null> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const codexHome = resolve(
    options.codexHome?.trim() ||
      env.CODEX_HOME?.trim() ||
      join(homedir(), ".codex"),
  );
  const codexCliPath =
    options.codexCliPath?.trim() || env.ZEROS_CODEX_CLI_PATH?.trim();
  if (!codexCliPath || !isAbsolute(codexCliPath)) return null;
  const trustedCodexCli = await regularFile(codexCliPath);
  if (!trustedCodexCli) return null;

  const runtimeRoots = options.runtimeRoots
    ? [...options.runtimeRoots]
    : await defaultRuntimeRoots(platform, env);
  const pluginRoots = options.pluginRoots
    ? [...options.pluginRoots]
    : await defaultBrowserPluginRoots(codexHome, env);

  for (const runtimeCandidate of runtimeRoots) {
    const runtime = await inspectRuntime(runtimeCandidate, platform, arch);
    if (!runtime) continue;
    for (const pluginCandidate of pluginRoots) {
      const plugin = await inspectBrowserPlugin(pluginCandidate);
      if (!plugin) continue;
      return {
        pluginId: BROWSER_PLUGIN_ID,
        pluginRoot: plugin.root,
        browserSkill: {
          name: "control-in-app-browser",
          path: plugin.browserSkillPath,
        },
        mcpServer: {
          name: "node_repl",
          transport: "stdio",
          command: runtime.nodeReplPath,
          args: [],
          startupTimeoutSec: 120,
          env: {
            BROWSER_USE_AVAILABLE_BACKENDS: "iab",
            BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
            BROWSER_USE_CODEX_APP_VERSION: plugin.version,
            CODEX_CLI_PATH: trustedCodexCli,
            CODEX_HOME: codexHome,
            NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
            NODE_REPL_NODE_MODULE_DIRS: runtime.nodeModulesPath,
            NODE_REPL_NODE_PATH: runtime.nodePath,
            NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S:
              plugin.browserClientSha256,
            NODE_REPL_TRUSTED_CODE_PATHS: [
              codexHome,
              runtime.nodeModulesPath,
            ].join(delimiter),
            NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER:
              "Control the in-app browser in conjunction with the Browser Plugin.",
          },
        },
      };
    }
  }
  return null;
}

/** `node_repl` is an official Codex MCP dependency, but its name is also a
 * security boundary. Replace any workspace registration with the verified
 * OpenAI binary so the Browser plugin cannot be redirected to another server. */
export function mergeCodexNativeBrowserMcp(
  configured: readonly McpServerRegistration[],
  runtime: CodexNativeBrowserRuntime,
): McpServerRegistration[] {
  return [
    runtime.mcpServer,
    ...configured.filter((server) => server.name !== runtime.mcpServer.name),
  ];
}

async function defaultRuntimeRoots(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const roots: string[] = [];
  pushCandidate(roots, env.ZEROS_CODEX_CUA_NODE_ROOT);
  pushCandidate(
    roots,
    env.ZEROS_RESOURCES_PATH
      ? join(env.ZEROS_RESOURCES_PATH, "cua_node")
      : undefined,
  );
  if (platform === "darwin") {
    roots.push(
      "/Applications/ChatGPT.app/Contents/Resources/cua_node",
      "/Applications/Codex.app/Contents/Resources/cua_node",
      join(
        homedir(),
        "Applications",
        "ChatGPT.app",
        "Contents",
        "Resources",
        "cua_node",
      ),
      join(
        homedir(),
        "Applications",
        "Codex.app",
        "Contents",
        "Resources",
        "cua_node",
      ),
    );
  } else if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      const runtimes = join(
        localAppData,
        "OpenAI",
        "Codex",
        "runtimes",
        "cua_node",
      );
      roots.push(...(await childDirectoriesNewestFirst(runtimes)));
    }
  }
  return uniquePaths(roots);
}

async function defaultBrowserPluginRoots(
  codexHome: string,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const roots: string[] = [];
  pushCandidate(roots, env.ZEROS_CODEX_BROWSER_PLUGIN_ROOT);
  const cacheRoot = join(
    codexHome,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
  );
  roots.push(join(cacheRoot, "latest"));
  roots.push(...(await childDirectoriesNewestFirst(cacheRoot)));
  return uniquePaths(roots);
}

async function inspectRuntime(
  candidate: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<{
  nodeModulesPath: string;
  nodePath: string;
  nodeReplPath: string;
} | null> {
  const root = await directory(candidate);
  if (!root) return null;
  const manifest = await readJsonObject(join(root, "manifest.json"));
  if (!manifest || manifest.platform !== platform || manifest.arch !== arch) {
    return null;
  }
  const executableSuffix = platform === "win32" ? ".exe" : "";
  const nodeReplPath = await regularFileInside(
    root,
    resolve(
      root,
      runtimeManifestPath(
        manifest,
        "node_repl_path",
        join("bin", `node_repl${executableSuffix}`),
      ),
    ),
  );
  const nodePath = await regularFileInside(
    root,
    resolve(
      root,
      runtimeManifestPath(
        manifest,
        "node_path",
        join("bin", `node${executableSuffix}`),
      ),
    ),
  );
  const nodeModulesPath = await directoryInside(
    root,
    resolve(
      root,
      runtimeManifestPath(
        manifest,
        "node_modules",
        join("lib", "node_modules"),
      ),
    ),
  );
  if (!nodeReplPath || !nodePath || !nodeModulesPath) return null;
  return { nodeModulesPath, nodePath, nodeReplPath };
}

function runtimeManifestPath(
  manifest: Record<string, unknown>,
  key: "node_repl_path" | "node_path" | "node_modules",
  fallback: string,
): string {
  const declared = manifest[key];
  return typeof declared === "string" && declared.trim()
    ? declared.trim()
    : fallback;
}

async function inspectBrowserPlugin(candidate: string): Promise<{
  browserClientSha256: string;
  browserSkillPath: string;
  root: string;
  version: string;
} | null> {
  const root = await directory(candidate);
  if (!root) return null;
  const manifest = await readJsonObject(
    join(root, ".codex-plugin", "plugin.json"),
  );
  const author =
    manifest?.author &&
    typeof manifest.author === "object" &&
    !Array.isArray(manifest.author)
      ? (manifest.author as Record<string, unknown>).name
      : null;
  if (
    manifest?.name !== "browser" ||
    author !== "OpenAI" ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0 ||
    manifest.version.length > 128
  ) {
    return null;
  }
  const browserClientPath = await regularFileInside(
    root,
    join(root, "scripts", "browser-client.mjs"),
  );
  if (!browserClientPath) return null;
  const browserSkillPath = await regularFileInside(
    root,
    join(root, "skills", "control-in-app-browser", "SKILL.md"),
  );
  if (!browserSkillPath) return null;
  const source = await readCappedFile(
    browserClientPath,
    MAX_BROWSER_CLIENT_BYTES,
  );
  if (!source) return null;
  return {
    root,
    version: manifest.version,
    browserSkillPath,
    browserClientSha256: createHash("sha256").update(source).digest("hex"),
  };
}

const CODEX_BROWSER_SKILL_MARKER = "$control-in-app-browser";

/** Detect explicit interactive website intent. A filename such as
 * browser-tab.tsx is not enough; the prompt must request a browser/page action
 * or name the Browser surface. */
export function codexPromptRequestsBrowserSkill(
  input: readonly CodexUserInput[],
): boolean {
  const text = input
    .filter(
      (item): item is Extract<CodexUserInput, { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!text) return false;
  if (
    /\$(?:control-in-app-browser|browser(?::control-in-app-browser)?|browser-use)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:use|using|with|open|show)\s+(?:the\s+)?(?:in-app|built-in|native\s+codex\s+)?browser\b/i.test(
      text,
    ) ||
    /\bbrowser\s+use\b/i.test(text)
  ) {
    return true;
  }
  const interactive =
    /\b(?:browse|navigate|visit|explore|interact|click|scroll|open|go\s+to|walk\s+through)\b/i.test(
      text,
    );
  const webTarget =
    /https?:\/\/|(?:^|\s)(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:[\s/]|$)|\b(?:website|web\s+site|homepage|webpage|public\s+pages?|site\s+navigation)\b/i.test(
      text,
    );
  return interactive && webTarget;
}

/** Explicitly invoke the exact Browser skill returned by the verified plugin
 * root. This removes path reconstruction from the model and lets app-server
 * inject the skill directly, as recommended by its native UserInput contract. */
export function injectCodexBrowserSkillInput(
  input: readonly CodexUserInput[],
  skill: CodexNativeBrowserSkill,
): CodexUserInput[] {
  if (input.some((item) => item.type === "skill" && item.path === skill.path)) {
    return [...input];
  }
  let marked = false;
  const next = input.map((item): CodexUserInput => {
    if (marked || item.type !== "text") return item;
    marked = true;
    return {
      ...item,
      text: item.text.includes(CODEX_BROWSER_SKILL_MARKER)
        ? item.text
        : `${CODEX_BROWSER_SKILL_MARKER} ${item.text}`.trim(),
    };
  });
  return [...next, { type: "skill", name: skill.name, path: skill.path }];
}

async function childDirectoriesNewestFirst(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const directories = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map(async (entry) => {
          const path = join(root, entry.name);
          const details = await stat(path).catch(() => null);
          return details?.isDirectory()
            ? { path, modifiedAt: details.mtimeMs, name: entry.name }
            : null;
        }),
    );
    return directories
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort(
        (left, right) =>
          right.modifiedAt - left.modifiedAt ||
          right.name.localeCompare(left.name, undefined, { numeric: true }),
      )
      .map((entry) => entry.path);
  } catch {
    return [];
  }
}

async function readJsonObject(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read a file through a single handle, refusing anything over `maxBytes`.
 *
 * The size guard and the bytes we return have to describe the same inode.
 * Checking with stat() and then reading the path again leaves a window where the
 * plugin cache can swap the file, so the hash we pin into
 * NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S would cover bytes that never passed
 * the cap. Opening once and asking the handle closes it: the fstat and the read
 * both follow the descriptor, whatever the path points at afterwards.
 */
async function readCappedFile(
  path: string,
  maxBytes: number,
): Promise<Buffer | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > maxBytes) {
      return null;
    }
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function regularFile(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path);
    return (await stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

async function directory(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function regularFileInside(root: string, path: string) {
  const file = await regularFile(path);
  return file && isInside(root, file) ? file : null;
}

async function directoryInside(root: string, path: string) {
  const child = await directory(path);
  return child && isInside(root, child) ? child : null;
}

function isInside(root: string, child: string): boolean {
  const nested = relative(root, child);
  return nested.length > 0 && !nested.startsWith("..") && !isAbsolute(nested);
}

function pushCandidate(paths: string[], value: string | undefined): void {
  const candidate = value?.trim();
  if (candidate && isAbsolute(candidate)) paths.push(candidate);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

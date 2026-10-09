import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

/** Native writable state slots, separate from product-projected settings. */
export const CLOUD_CODEX_STATE_DIRECTORIES = Object.freeze(["tmp", "log", "shell_snapshots", ".tmp", "thread-writer-locks", "skills"]);
/** Organization skills copied into the physical provider HOME. */
export const CLOUD_NATIVE_SKILL_HOMES = Object.freeze([".agents", ".claude", ".cursor", ".codex"]);

export interface CloudNativeHomePaths {
  readonly directory: string;
  readonly home: string;
  readonly tmp: string;
  readonly xdgConfigHome: string;
  readonly xdgCacheHome: string;
  readonly xdgDataHome: string;
  readonly xdgStateHome: string;
  readonly claudeConfigDir: string;
  readonly codexHome: string;
  readonly cursorHome: string;
}
export interface CloudNativeHome {
  readonly paths: CloudNativeHomePaths;
  environment(): Record<string, string>;
}
const originalHomes = new WeakSet<object>();
export function isCloudNativeHome(value: unknown): value is CloudNativeHome {
  return typeof value === "object" && value !== null && originalHomes.has(value);
}

async function physicalDirectory(directory: string, create: boolean): Promise<void> {
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory ||
    typeof process.geteuid === "function" && stat.uid !== process.geteuid())
    throw new Error("cloud native HOME is not an engine-owned physical directory");
  await chmod(directory, 0o700);
}

/** Plain per-conversation state directories. Same-user peers can access them;
 * they are not a filesystem or credential isolation boundary. */
export async function createCloudNativeHome(input: {
  dataRoot: string; conversationId: string; provider: "claude" | "codex" | "cursor"; executionId: string;
}): Promise<CloudNativeHome> {
  if (!path.isAbsolute(input.dataRoot) || path.resolve(input.dataRoot) !== input.dataRoot ||
    input.dataRoot.includes("\0") || !/^[A-Za-z0-9_-]{1,128}$/.test(input.executionId) ||
    !["claude", "codex", "cursor"].includes(input.provider) ||
    typeof input.conversationId !== "string" || input.conversationId.length === 0 ||
    Buffer.byteLength(input.conversationId) > 256 || input.conversationId.includes("\0"))
    throw new Error("invalid cloud native HOME identity");
  await physicalDirectory(input.dataRoot, false);
  const root = path.join(input.dataRoot, "native-agent-homes");
  const conversation = path.join(root, createHash("sha256").update(input.conversationId).digest("hex"));
  const provider = path.join(conversation, input.provider);
  const directory = path.join(provider, input.executionId);
  for (const value of [root, conversation, provider, directory]) await physicalDirectory(value, true);
  const home = path.join(directory, "home");
  const paths: CloudNativeHomePaths = Object.freeze({
    directory, home, tmp: path.join(directory, "tmp"),
    xdgConfigHome: path.join(directory, "config"), xdgCacheHome: path.join(directory, "cache"),
    xdgDataHome: path.join(directory, "data"), xdgStateHome: path.join(directory, "state"),
    claudeConfigDir: path.join(home, ".claude"), codexHome: path.join(home, ".codex"), cursorHome: path.join(home, ".cursor"),
  });
  for (const value of Object.values(paths)) await physicalDirectory(value, true);
  const result: CloudNativeHome = Object.freeze({ paths, environment: () => ({
    HOME: paths.home, TMPDIR: paths.tmp, XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_CACHE_HOME: paths.xdgCacheHome, XDG_DATA_HOME: paths.xdgDataHome, XDG_STATE_HOME: paths.xdgStateHome,
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir, CODEX_HOME: paths.codexHome,
  }) });
  originalHomes.add(result);
  return result;
}

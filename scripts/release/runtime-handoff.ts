import { constants } from "node:fs";
import { mkdir, open, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { PromotionError, requireCheck } from "./contracts";
import { RuntimeReleaseConfigSchema, type RuntimeReleaseConfig } from "./runtime-contracts";
import { runtimeJson } from "./runtime-proof";

export const RuntimeLoginSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().regex(/^zeros-(?:alpha|beta|production)-runtime-[1-9]\d{0,19}-[1-9]\d{0,4}$/),
  username: z.string().regex(/^[A-Za-z0-9_]+\.[a-z0-9]+$/), password: z.string().min(1).max(8192),
  access_host_url: z.string().regex(/^[a-z0-9.-]+\.pg\.psdb\.cloud$/),
}).strict();
export type RuntimeLogin = z.infer<typeof RuntimeLoginSchema>;
const Handoff = z.object({ version: z.literal(1), source: RuntimeReleaseConfigSchema,
  login: RuntimeLoginSchema, expiresAt: z.string().datetime({ offset: true }) }).strict();
export type RuntimeHandoff = z.infer<typeof Handoff>;
const basename = (config: RuntimeReleaseConfig) => `zeros-runtime-cleanup-${config.runId}-${config.runAttempt}`;
const filename = "login.json";
const within = (parent: string, path: string) => { const child = relative(parent, path); return child === "" || !child.startsWith("..") && !isAbsolute(child); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const refuse = () => new PromotionError("Runtime private cleanup handoff is unavailable or invalid; details withheld");

export async function maskRuntimeLogin(password: string): Promise<void> {
  await new Promise<void>((resolve, reject) => process.stdout.write(
    `::add-mask::${password.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}\n`, error => error ? reject(error) : resolve()));
}
async function parent(env: NodeJS.ProcessEnv): Promise<FileHandle> {
  requireCheck(env.RUNNER_ENVIRONMENT === "github-hosted" && process.platform === "linux" && env.RUNNER_TEMP && env.GITHUB_WORKSPACE,
    "Runtime cleanup requires an ephemeral GitHub-hosted Linux runner");
  const temporary = await realpath(resolve(env.RUNNER_TEMP)), workspace = await realpath(resolve(env.GITHUB_WORKSPACE));
  requireCheck(!within(workspace, temporary), "Runtime private cleanup cannot use the checkout");
  const directory = await open(temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const stat = await directory.stat();
  if (!stat.isDirectory() || stat.uid !== process.getuid!()) { await directory.close(); throw refuse(); }
  return directory;
}
// A renamed directory must not redirect a credential read, write or unlink.
const childPath = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`;
async function privateDirectory(outer: FileHandle, config: RuntimeReleaseConfig) {
  const directory = await open(childPath(outer, basename(config)), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const stat = await directory.stat();
  if (!stat.isDirectory() || stat.uid !== process.getuid!()) { await directory.close(); throw refuse(); }
  return directory;
}
async function discard(outer: FileHandle, directory: FileHandle, config: RuntimeReleaseConfig) {
  await unlink(childPath(directory, filename)).catch(error => { if (!missing(error)) throw refuse(); });
  const original = await directory.stat();
  let entry: FileHandle | undefined;
  try {
    entry = await privateDirectory(outer, config);
    const current = await entry.stat();
    if (current.dev === original.dev && current.ino === original.ino) await rmdir(childPath(outer, basename(config)));
  } finally { await entry?.close(); }
}

export async function writeRuntimeHandoff(config: RuntimeReleaseConfig, env: NodeJS.ProcessEnv, login: RuntimeLogin, expiresAt: string,
  mask: (password: string) => void | Promise<void> = maskRuntimeLogin): Promise<void> {
  let outer: FileHandle | undefined, directory: FileHandle | undefined, file: FileHandle | undefined, created = false;
  try {
    const value = Handoff.parse({ version: 1, source: config, login, expiresAt });
    requireCheck(login.name === `zeros-${config.channel}-runtime-${config.runId}-${config.runAttempt}` && Date.parse(expiresAt) > Date.now(), "invalid binding");
    const bytes = Buffer.from(JSON.stringify(value)); requireCheck(bytes.length <= 16 * 1024, "invalid private size");
    outer = await parent(env);
    await mkdir(childPath(outer, basename(config)), { mode: 0o700 });
    directory = await privateDirectory(outer, config);
    requireCheck(((await directory.stat()).mode & 0o777) === 0o700, "invalid private directory");
    await mask(login.password);
    file = await open(childPath(directory, filename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    const stat = await file.stat();
    requireCheck(stat.isFile() && stat.uid === process.getuid!() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1, "invalid private file");
    await file.writeFile(bytes); await file.sync(); await directory.sync();
  } catch {
    if (created && outer && directory) await discard(outer, directory, config).catch(() => {});
    throw refuse();
  } finally { await file?.close(); await directory?.close(); await outer?.close(); }
}

export async function withRuntimeHandoff<T>(config: RuntimeReleaseConfig, env: NodeJS.ProcessEnv,
  operation: (handoff: RuntimeHandoff | null) => Promise<T>, mask: (password: string) => void | Promise<void> = maskRuntimeLogin): Promise<T> {
  let outer: FileHandle | undefined, directory: FileHandle | undefined, file: FileHandle | undefined;
  let result: T | undefined, failed = false;
  try {
    outer = await parent(env);
    try { directory = await privateDirectory(outer, config); } catch (error) { if (!missing(error)) throw error; }
    if (!directory) result = await operation(null);
    else {
      requireCheck(((await directory.stat()).mode & 0o777) === 0o700, "invalid private directory");
      file = await open(childPath(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      requireCheck(stat.isFile() && stat.uid === process.getuid!() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= 16 * 1024, "invalid private file");
      const bytes = await file.readFile(); requireCheck(bytes.length <= 16 * 1024, "invalid private size");
      const value = Handoff.parse(JSON.parse(bytes.toString("utf8")));
      requireCheck(runtimeJson(value.source) === runtimeJson(config) && value.login.name === `zeros-${config.channel}-runtime-${config.runId}-${config.runAttempt}`,
        "invalid cleanup binding");
      await mask(value.login.password);
      result = await operation(value);
    }
  } catch { failed = true; }
  finally {
    try { if (outer && directory) await discard(outer, directory, config); }
    catch { failed = true; }
    for (const handle of [file, directory, outer]) { try { await handle?.close(); } catch { failed = true; } }
  }
  if (failed) throw refuse();
  return result as T;
}

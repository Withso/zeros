import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

import {
  zerosChannelDataDir,
  zerosDataDir,
  zerosStateRoot,
} from "../../db/paths";
import { openSqlite } from "../../db/sqlite";

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const LOCK_WAIT_MS = 60_000;
const LOCK_RETRY_MS = 25;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const CREDENTIAL_SOURCE_FILE = "credential-source.json";

type EntrySnapshot =
  | { readonly kind: "file"; readonly digest: string; readonly mode: number }
  | { readonly kind: "symlink"; readonly target: string }
  | { readonly kind: "directory"; readonly digest: string };

type DurableEntrySnapshot = EntrySnapshot | { readonly kind: "tombstone" };

interface DurableState {
  readonly version: 2;
  readonly tombstones: readonly string[];
  /** Host value on which each durable override was based. `null` means the
   * entry did not exist on the host. This is the third side of the merge. */
  readonly hostBases: Readonly<Record<string, EntrySnapshot | null>>;
}

interface ReadDurableState extends DurableState {
  readonly migratedFromV1: boolean;
}

interface ManagedPath {
  readonly source: string;
  readonly relative: string;
}

export type ProviderCredentialSeedResult =
  | { readonly status: "available"; readonly value: string }
  | { readonly status: "absent" }
  | { readonly status: "unavailable" };

export type ProviderCredentialSeedReader =
  () => Promise<ProviderCredentialSeedResult>;

interface CredentialSourceMarker {
  readonly version: 1;
  readonly providerId: string;
  readonly relative: string;
  readonly digest: string;
}

interface ActiveCredentialSource {
  readonly relative: string;
  readonly read: ProviderCredentialSeedReader;
  /** Last confirmed keychain value. A transient read failure at promotion
   * must retain this host side of the three-way merge. */
  readonly fallbackSnapshot?: EntrySnapshot;
}

export interface ProviderHomeOverlay {
  readonly providerId: string;
  readonly workspaceRoot: string;
  readonly localHome: string;
  readonly persistentRoot: string;
  readonly contentRoot: string;
  readonly managed: readonly ManagedPath[];
  /** Canonical host roots exposed read-only through links in the private HOME.
   * These are compatibility inputs, never promotion destinations. */
  readonly readOnlyHostRoots: readonly string[];
  readonly baselineLocal: ReadonlyMap<string, EntrySnapshot>;
  readonly baselineHost: ReadonlyMap<string, EntrySnapshot>;
  readonly baselinePersistent: ReadonlyMap<string, DurableEntrySnapshot>;
  readonly preparationConflicts: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Engine-only capability. It never crosses into the child environment. */
  readonly credentialSource?: ActiveCredentialSource;
}

export interface ProviderHomePromotionResult {
  readonly conflicts: readonly string[];
  readonly updatedFiles: number;
}

const promotionTails = new Map<string, Promise<void>>();

function safeProviderId(value: string | undefined): string {
  const normalized = (value ?? "generic").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)
    ? normalized
    : "generic";
}

function absoluteEnvPath(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const candidate = env[name]?.trim() || fallback;
  return path.isAbsolute(candidate) ? path.resolve(candidate) : fallback;
}

function providerManagedPaths(
  providerId: string,
  hostHome: string,
  env: NodeJS.ProcessEnv,
): ManagedPath[] {
  const paths: ManagedPath[] = [
    { source: path.join(hostHome, ".agents"), relative: ".agents" },
  ];
  if (providerId === "claude") {
    paths.push(
      {
        source: absoluteEnvPath(
          env,
          "CLAUDE_CONFIG_DIR",
          path.join(hostHome, ".claude"),
        ),
        relative: ".claude",
      },
      { source: path.join(hostHome, ".claude.json"), relative: ".claude.json" },
    );
  } else if (providerId === "codex") {
    paths.push({
      source: absoluteEnvPath(env, "CODEX_HOME", path.join(hostHome, ".codex")),
      relative: ".codex",
    });
  } else if (providerId === "cursor") {
    paths.push(
      { source: path.join(hostHome, ".cursor"), relative: ".cursor" },
      {
        source: path.join(hostHome, ".cursor-agent"),
        relative: ".cursor-agent",
      },
    );
  } else if (providerId === "opencode") {
    const config = absoluteEnvPath(
      env,
      "XDG_CONFIG_HOME",
      path.join(hostHome, ".config"),
    );
    const data = absoluteEnvPath(
      env,
      "XDG_DATA_HOME",
      path.join(hostHome, ".local", "share"),
    );
    const state = absoluteEnvPath(
      env,
      "XDG_STATE_HOME",
      path.join(hostHome, ".local", "state"),
    );
    const cache = absoluteEnvPath(
      env,
      "XDG_CACHE_HOME",
      path.join(hostHome, ".cache"),
    );
    paths.push(
      { source: path.join(config, "opencode"), relative: ".config/opencode" },
      {
        source: path.join(data, "opencode"),
        relative: ".local/share/opencode",
      },
      {
        source: path.join(state, "opencode"),
        relative: ".local/state/opencode",
      },
      { source: path.join(cache, "opencode"), relative: ".cache/opencode" },
    );
  } else if (providerId !== "generic") {
    paths.push({
      source: path.join(hostHome, ".config", providerId),
      relative: path.join(".config", providerId),
    });
  }
  const seen = new Set<string>();
  return paths.filter(({ relative }) => {
    const key = path.normalize(relative);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function providerCredentialRelative(providerId: string): string | undefined {
  if (providerId === "claude") {
    return path.join(".claude", ".credentials.json");
  }
  if (providerId === "codex") {
    return path.join(".codex", "auth.json");
  }
  return undefined;
}

function hasExplicitProviderCredential(
  providerId: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const names =
    providerId === "claude"
      ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
      : providerId === "codex"
        ? ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]
        : [];
  return names.some((name) => Boolean(env[name]?.trim()));
}

async function readMacKeychainPassword(options: {
  readonly service: string;
  readonly account?: string;
  readonly hostHome: string;
}): Promise<ProviderCredentialSeedResult> {
  const args = ["find-generic-password", "-w", "-s", options.service];
  if (options.account) args.push("-a", options.account);
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      args,
      {
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: MAX_CREDENTIAL_BYTES + 4096,
        env: {
          HOME: options.hostHome,
          PATH: "/usr/bin:/bin",
          ...(process.env.USER ? { USER: process.env.USER } : {}),
          ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
          ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        },
      },
      (error, stdout) => {
        if (!error) {
          resolve({ status: "available", value: stdout });
          return;
        }
        const exitCode = (error as NodeJS.ErrnoException).code;
        // `errSecItemNotFound` is -25300, surfaced by the security CLI as
        // process exit status 44. Every other failure may be transient (locked
        // keychain, denied UI, timeout), so it must not revoke a good seed.
        if (String(exitCode) === "44") {
          resolve({ status: "absent" });
          return;
        }
        resolve({ status: "unavailable" });
      },
    );
  });
}

async function defaultProviderCredentialSeedReader(
  providerId: string,
  hostHome: string,
  env: NodeJS.ProcessEnv,
): Promise<ProviderCredentialSeedReader | undefined> {
  if (process.platform !== "darwin") return undefined;
  if (providerId !== "claude" && providerId !== "codex") return undefined;
  // An explicit environment credential has higher precedence. Do not read a
  // second, unrelated login. If an earlier keychain projection exists, the
  // marker reconciliation below treats it as temporarily unavailable.
  if (hasExplicitProviderCredential(providerId, env)) {
    return undefined;
  }
  if (providerId === "claude") {
    return () =>
      readMacKeychainPassword({
        service: "Claude Code-credentials",
        hostHome,
      });
  }
  const codexHome = await canonicalExistingOrLexical(
    absoluteEnvPath(env, "CODEX_HOME", path.join(hostHome, ".codex")),
  );
  try {
    const configPath = path.join(codexHome, "config.toml");
    const stat = await lstat(configPath);
    if (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= MAX_CREDENTIAL_BYTES
    ) {
      const config = parseToml(await readFile(configPath, "utf8")) as Record<
        string,
        unknown
      >;
      const storage = Object.hasOwn(config, "cli_auth_credentials_store")
        ? config.cli_auth_credentials_store
        : undefined;
      if (storage === "file" || storage === "ephemeral") {
        return async () => ({ status: "absent" });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Codex will surface malformed/unsafe config itself. Credential
      // selection stays on its default `auto` path without logging content.
    }
  }
  const account = `cli|${createHash("sha256")
    .update(codexHome)
    .digest("hex")
    .slice(0, 16)}`;
  return () =>
    readMacKeychainPassword({
      service: "Codex Auth",
      account,
      hostHome,
    });
}

function normalizedCredentialBytes(raw: string): Buffer {
  if (Buffer.byteLength(raw) > MAX_CREDENTIAL_BYTES) {
    throw new Error("provider keychain credential exceeds its size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("provider keychain credential is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("provider keychain credential is not a JSON object");
  }
  const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
  if (bytes.byteLength > MAX_CREDENTIAL_BYTES) {
    throw new Error("provider keychain credential exceeds its size limit");
  }
  return bytes;
}

function credentialSnapshot(
  bytes: Buffer,
): Extract<EntrySnapshot, { readonly kind: "file" }> {
  return {
    kind: "file",
    digest: createHash("sha256").update(bytes).digest("hex"),
    mode: 0o600,
  };
}

function compatibilitySeedPaths(hostHome: string): ManagedPath[] {
  return [
    ".zshenv",
    ".zprofile",
    ".zshrc",
    ".zlogin",
    ".zlogout",
    ".bash_profile",
    ".bash_login",
    ".bashrc",
    ".bash_logout",
    ".profile",
    ".inputrc",
    path.join(".config", "fish"),
    path.join(".config", "nushell"),
    path.join(".config", "zsh"),
    path.join(".config", "starship.toml"),
    path.join(".cargo", "env"),
    // SSH private keys never enter the writable provider HOME. The client
    // configuration and host-key databases are compatibility inputs only;
    // authentication remains behind the generation-scoped SSH-agent façade.
    path.join(".ssh", "config"),
    path.join(".ssh", "known_hosts"),
    path.join(".ssh", "known_hosts2"),
    path.join(".ssh", "known_hosts.old"),
  ].map((relative) => ({ source: path.join(hostHome, relative), relative }));
}

function readOnlyCompatibilityLinks(hostHome: string): ManagedPath[] {
  return [
    ".oh-my-zsh",
    ".zprezto",
    ".bash_it",
    ".zsh",
    ".nvm",
    ".asdf",
    ".volta",
    ".fnm",
    ".pyenv",
    ".rbenv",
    ".bun",
    ".deno",
    ".rustup",
    path.join(".cargo", "bin"),
    path.join(".cargo", "registry"),
    path.join(".cargo", "git"),
    path.join(".local", "bin"),
    path.join(".local", "share", "mise"),
    path.join(".local", "share", "pnpm"),
    path.join(".local", "share", "zinit"),
  ].map((relative) => ({ source: path.join(hostHome, relative), relative }));
}

function workspaceKey(
  providerId: string,
  workspaceRoot: string,
  hostHome: string,
): string {
  return createHash("sha256")
    .update(
      `${providerId}\0${path.resolve(workspaceRoot)}\0${path.resolve(hostHome)}`,
    )
    .digest("hex");
}

async function assertPhysicalDirectory(directory: string, label: string) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a physical directory`);
  }
  if ((await realpath(directory)) !== directory) {
    throw new Error(`${label} is not canonical`);
  }
}

function safeFileMode(mode: number): number {
  return 0o600 | (mode & 0o100);
}

async function copyTree(source: string, destination: string): Promise<void> {
  let files = 0;
  let totalBytes = 0;
  const visit = async (from: string, to: string): Promise<void> => {
    let stat;
    try {
      stat = await lstat(from);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      files += 1;
      if (files > MAX_FILES)
        throw new Error("provider overlay has too many files");
      await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await rm(to, { recursive: true, force: true });
      await symlink(await readlink(from), to);
      return;
    }
    if (stat.isDirectory()) {
      try {
        const destinationStat = await lstat(to);
        if (
          !destinationStat.isDirectory() ||
          destinationStat.isSymbolicLink()
        ) {
          await rm(to, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(to, { recursive: true, mode: 0o700 });
      await chmod(to, 0o700);
      const entries = await readdir(from, { withFileTypes: true });
      for (const entry of entries) {
        await visit(path.join(from, entry.name), path.join(to, entry.name));
      }
      return;
    }
    if (!stat.isFile()) return;
    files += 1;
    totalBytes += stat.size;
    if (
      files > MAX_FILES ||
      stat.size > MAX_FILE_BYTES ||
      totalBytes > MAX_TOTAL_BYTES
    ) {
      throw new Error("provider overlay exceeds its bounded copy quota");
    }
    await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
    await rm(to, { recursive: true, force: true });
    await copyFile(from, to);
    await chmod(to, safeFileMode(stat.mode));
  };
  await visit(source, destination);
}

async function snapshotManaged(
  root: string | null,
  managed: readonly ManagedPath[],
): Promise<Map<string, EntrySnapshot>> {
  const result = new Map<string, EntrySnapshot>();
  let files = 0;
  let totalBytes = 0;
  const visit = async (
    absolute: string,
    relative: string,
  ): Promise<EntrySnapshot | undefined> => {
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      files += 1;
      if (files > MAX_FILES)
        throw new Error("provider overlay has too many files");
      const snapshot = {
        kind: "symlink",
        target: await readlink(absolute),
      } as const;
      result.set(relative, snapshot);
      return snapshot;
    }
    if (stat.isDirectory()) {
      const children: Array<readonly [string, EntrySnapshot]> = [];
      const entries = await readdir(absolute, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const child = await visit(
          path.join(absolute, entry.name),
          path.join(relative, entry.name),
        );
        if (child) children.push([entry.name, child]);
      }
      const snapshot = {
        kind: "directory",
        digest: createHash("sha256")
          .update(JSON.stringify(children))
          .digest("hex"),
      } as const;
      result.set(relative, snapshot);
      return snapshot;
    }
    if (!stat.isFile()) return undefined;
    files += 1;
    totalBytes += stat.size;
    if (
      files > MAX_FILES ||
      stat.size > MAX_FILE_BYTES ||
      totalBytes > MAX_TOTAL_BYTES
    ) {
      throw new Error("provider overlay exceeds its bounded snapshot quota");
    }
    const bytes = await readFile(absolute);
    const snapshot = {
      kind: "file",
      digest: createHash("sha256").update(bytes).digest("hex"),
      mode: safeFileMode(stat.mode),
    } as const;
    result.set(relative, snapshot);
    return snapshot;
  };
  for (const item of managed) {
    await visit(
      root === null ? item.source : path.join(root, item.relative),
      item.relative,
    );
  }
  return result;
}

async function snapshotManagedSources(
  managed: readonly ManagedPath[],
): Promise<Map<string, EntrySnapshot>> {
  return snapshotManaged(null, managed);
}

function equalEntry(
  left: EntrySnapshot | undefined,
  right: EntrySnapshot | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.kind === "file" && right.kind === "file"
    ? left.digest === right.digest && left.mode === right.mode
    : left.kind === "symlink" && right.kind === "symlink"
      ? left.target === right.target
      : left.kind === "directory" && right.kind === "directory"
        ? left.digest === right.digest
        : false;
}

function equalDurableEntry(
  left: DurableEntrySnapshot | undefined,
  right: DurableEntrySnapshot | undefined,
): boolean {
  if (left?.kind === "tombstone" || right?.kind === "tombstone") {
    return left?.kind === right?.kind;
  }
  return equalEntry(left, right);
}

function durableMatchesLocal(
  durable: DurableEntrySnapshot | undefined,
  local: EntrySnapshot | undefined,
): boolean {
  if (durable?.kind === "tombstone") return local === undefined;
  return equalEntry(durable, local);
}

function relativeDepth(relative: string): number {
  return relative.split(path.sep).length;
}

function assertSafeRelative(relative: string): string {
  const normalized = path.normalize(relative);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error("provider overlay contains an unsafe relative path");
  }
  return normalized;
}

function comparisonPath(input: string): string {
  const normalized = path.resolve(input).replace(/[\\/]+$/, "");
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.normalize("NFC").toLocaleLowerCase("en-US")
    : normalized;
}

function pathIsInsideOrEqual(candidate: string, parent: string): boolean {
  const childKey = comparisonPath(candidate);
  const parentKey = comparisonPath(parent);
  if (childKey === parentKey) return true;
  const relative = path.relative(parentKey, childKey);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function relativeIsInsideOrEqual(candidate: string, parent: string): boolean {
  const child = assertSafeRelative(candidate);
  const ancestor = assertSafeRelative(parent);
  return child === ancestor || child.startsWith(`${ancestor}${path.sep}`);
}

function conflictId(relative: string): string {
  return createHash("sha256").update(relative).digest("hex").slice(0, 16);
}

async function canonicalExistingOrLexical(input: string): Promise<string> {
  try {
    return await realpath(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return path.resolve(input);
    throw error;
  }
}

async function ensurePhysicalParents(
  root: string,
  relative: string,
): Promise<string> {
  const normalized = assertSafeRelative(relative);
  const parts = normalized.split(path.sep);
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        await rm(cursor, { recursive: true, force: true });
        await mkdir(cursor, { mode: 0o700 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(cursor, { mode: 0o700 });
    }
    await chmod(cursor, 0o700);
  }
  return path.join(root, normalized);
}

async function removeContainedEntry(
  root: string,
  relative: string,
): Promise<void> {
  const normalized = assertSafeRelative(relative);
  const parts = normalized.split(path.sep);
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  await rm(path.join(root, normalized), { recursive: true, force: true });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    // Some filesystems do not implement fsync(2) for directory descriptors.
    if (
      !new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function atomicCopyEntry(
  source: string,
  destination: string,
  snapshot: EntrySnapshot,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  if (snapshot.kind === "directory") {
    const safeDestination = await ensurePhysicalParents(
      path.dirname(destination),
      path.basename(destination),
    );
    try {
      const stat = await lstat(safeDestination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        await rm(safeDestination, { recursive: true, force: true });
        await mkdir(safeDestination, { mode: 0o700 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(safeDestination, { mode: 0o700 });
    }
    await chmod(safeDestination, 0o700);
    return;
  }
  if (snapshot.kind === "symlink") {
    await symlink(snapshot.target, temporary);
  } else {
    await copyFile(source, temporary);
    await chmod(temporary, snapshot.mode);
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
  await syncDirectory(path.dirname(destination));
}

async function atomicWritePrivateFile(
  root: string,
  relative: string,
  bytes: Buffer,
): Promise<void> {
  const destination = await ensurePhysicalParents(root, relative);
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
  await chmod(destination, 0o600);
  await syncDirectory(path.dirname(destination));
}

async function readCredentialSourceMarker(
  root: string,
  providerId: string,
  relative: string,
): Promise<CredentialSourceMarker | null> {
  const markerPath = path.join(root, CREDENTIAL_SOURCE_FILE);
  try {
    const metadata = await lstat(markerPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > 4096 ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error(
        "provider credential source marker has unsafe filesystem metadata",
      );
    }
    const parsed = JSON.parse(
      await readFile(markerPath, "utf8"),
    ) as Partial<CredentialSourceMarker>;
    if (
      parsed.version !== 1 ||
      parsed.providerId !== providerId ||
      parsed.relative !== relative ||
      typeof parsed.digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(parsed.digest)
    ) {
      throw new Error("provider credential source marker is invalid");
    }
    return parsed as CredentialSourceMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeCredentialSourceMarker(
  root: string,
  marker: CredentialSourceMarker,
): Promise<void> {
  await atomicWritePrivateFile(
    root,
    CREDENTIAL_SOURCE_FILE,
    Buffer.from(`${JSON.stringify(marker)}\n`, "utf8"),
  );
}

async function removeCredentialSourceMarker(root: string): Promise<void> {
  await rm(path.join(root, CREDENTIAL_SOURCE_FILE), { force: true });
  await syncDirectory(root);
}

function validSerializedEntry(value: unknown): value is EntrySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<EntrySnapshot>;
  if (entry.kind === "file") {
    return (
      typeof entry.digest === "string" &&
      /^[0-9a-f]{64}$/.test(entry.digest) &&
      typeof entry.mode === "number" &&
      Number.isInteger(entry.mode) &&
      entry.mode >= 0 &&
      entry.mode <= 0o777
    );
  }
  if (entry.kind === "symlink") {
    return (
      typeof entry.target === "string" &&
      !entry.target.includes("\0") &&
      Buffer.byteLength(entry.target) <= 16_384
    );
  }
  return (
    entry.kind === "directory" &&
    typeof entry.digest === "string" &&
    /^[0-9a-f]{64}$/.test(entry.digest)
  );
}

async function readDurableState(root: string): Promise<ReadDurableState> {
  try {
    const statePath = path.join(root, "state.json");
    const metadata = await lstat(statePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > 16 * 1024 * 1024 ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("provider overlay state has unsafe filesystem metadata");
    }
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
      version?: unknown;
      tombstones?: unknown;
      hostBases?: unknown;
    };
    if (
      (parsed.version !== 1 && parsed.version !== 2) ||
      !Array.isArray(parsed.tombstones) ||
      parsed.tombstones.some((entry) => typeof entry !== "string")
    ) {
      throw new Error("provider overlay state has an unsupported format");
    }
    const hostBases: Record<string, EntrySnapshot | null> = {};
    if (parsed.version === 2) {
      if (
        !parsed.hostBases ||
        typeof parsed.hostBases !== "object" ||
        Array.isArray(parsed.hostBases)
      ) {
        throw new Error("provider overlay state has an unsupported format");
      }
      const entries = Object.entries(parsed.hostBases);
      if (entries.length > MAX_FILES * 2) {
        throw new Error("provider overlay state exceeds its entry quota");
      }
      for (const [rawRelative, value] of entries) {
        const relative = assertSafeRelative(rawRelative);
        if (value !== null && !validSerializedEntry(value)) {
          throw new Error(
            "provider overlay state contains an invalid host base",
          );
        }
        hostBases[relative] = value;
      }
    }
    return {
      version: 2,
      tombstones: [...new Set(parsed.tombstones.map(assertSafeRelative))],
      hostBases,
      migratedFromV1: parsed.version === 1,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: 2,
        tombstones: [],
        hostBases: {},
        migratedFromV1: false,
      };
    }
    throw error;
  }
}

async function writeDurableState(
  root: string,
  tombstones: ReadonlySet<string>,
  hostBases: ReadonlyMap<string, EntrySnapshot | undefined>,
): Promise<void> {
  const target = path.join(root, "state.json");
  const temporary = path.join(root, `.state.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({
        version: 2,
        tombstones: [...tombstones].sort((a, b) => a.localeCompare(b)),
        hostBases: Object.fromEntries(
          [...hostBases]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([relative, snapshot]) => [relative, snapshot ?? null]),
        ),
      } satisfies DurableState)}\n`,
      "utf8",
    );
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporary, target);
  await syncDirectory(root);
}

async function durableSnapshot(
  contentRoot: string,
  managed: readonly ManagedPath[],
  tombstones: readonly string[],
): Promise<Map<string, DurableEntrySnapshot>> {
  const snapshot = new Map<string, DurableEntrySnapshot>(
    await snapshotManaged(contentRoot, managed),
  );
  for (const relative of tombstones) {
    snapshot.set(assertSafeRelative(relative), { kind: "tombstone" });
  }
  return snapshot;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireFilesystemLock(
  root: string,
): Promise<() => Promise<void>> {
  const databasePath = path.join(root, "promotion-lock.sqlite");
  const seed = await open(databasePath, "a", 0o600);
  await seed.close();
  await chmod(databasePath, 0o600);
  const database = openSqlite(databasePath);
  database.pragma("busy_timeout = 0");
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      try {
        database.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") throw error;
        if (Date.now() >= deadline) {
          throw new Error(
            "timed out waiting for provider state promotion lock",
          );
        }
        await wait(LOCK_RETRY_MS);
      }
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The transaction may already have been released by SQLite.
        }
        throw error;
      } finally {
        database.close();
      }
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

async function withPromotionLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = promotionTails.get(root) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const queued = prior.catch(() => undefined).then(() => pending);
  promotionTails.set(root, queued);
  await prior.catch(() => undefined);
  let releaseFilesystemLock: (() => Promise<void>) | undefined;
  try {
    releaseFilesystemLock = await acquireFilesystemLock(root);
    return await operation();
  } finally {
    await releaseFilesystemLock?.();
    release();
    if (promotionTails.get(root) === queued) promotionTails.delete(root);
  }
}

async function materializeReadOnlyLink(
  localHome: string,
  relative: string,
  source: string,
): Promise<void> {
  const destination = await ensurePhysicalParents(localHome, relative);
  await rm(destination, { recursive: true, force: true });
  const stat = await lstat(source);
  await symlink(source, destination, stat.isDirectory() ? "dir" : "file");
}

export async function prepareProviderHomeOverlay(options: {
  readonly providerId?: string;
  readonly localHome: string;
  readonly workspaceRoot: string;
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly deniedSourceRoots?: readonly string[];
  /** Injectable for deterministic tests. Production derives the supported
   * macOS keychain lookup from providerId and the canonical host HOME. */
  readonly credentialSeedReader?: ProviderCredentialSeedReader;
}): Promise<ProviderHomeOverlay> {
  const providerId = safeProviderId(options.providerId);
  const env = options.ambientEnv ?? process.env;
  const hostHomeInput = absoluteEnvPath(env, "HOME", homedir());
  if (path.dirname(hostHomeInput) === hostHomeInput) {
    throw new Error("provider host HOME cannot be the filesystem root");
  }
  const hostHome = await realpath(hostHomeInput);
  const workspaceRoot = await realpath(options.workspaceRoot);
  if (!path.isAbsolute(options.localHome) || options.localHome === hostHome) {
    throw new Error("provider HOME overlay requires a distinct absolute root");
  }
  if (path.dirname(hostHome) === hostHome) {
    throw new Error("provider host HOME cannot be the filesystem root");
  }
  await assertPhysicalDirectory(hostHome, "provider host HOME");
  await assertPhysicalDirectory(workspaceRoot, "provider overlay workspace");
  await assertPhysicalDirectory(options.localHome, "provider HOME overlay");
  const managed = providerManagedPaths(providerId, hostHome, env);
  const credentialRelative = providerCredentialRelative(providerId);
  if (options.credentialSeedReader && !credentialRelative) {
    throw new Error("provider does not have a supported keychain projection");
  }
  const configuredCredentialReader =
    options.credentialSeedReader ??
    (await defaultProviderCredentialSeedReader(providerId, hostHome, env));
  const compatibilitySeeds = compatibilitySeedPaths(hostHome);
  const compatibilityLinks = readOnlyCompatibilityLinks(hostHome);
  const deniedRoots = await Promise.all(
    [
      zerosDataDir(),
      zerosChannelDataDir(),
      zerosStateRoot(),
      options.localHome,
      ...(options.deniedSourceRoots ?? []),
    ].map(canonicalExistingOrLexical),
  );
  for (const item of [
    ...managed,
    ...compatibilitySeeds,
    ...compatibilityLinks,
  ]) {
    const resolved = await canonicalExistingOrLexical(item.source);
    if (path.dirname(resolved) === resolved) {
      throw new Error("provider state source cannot be the filesystem root");
    }
    if (
      deniedRoots.some(
        (denied) =>
          pathIsInsideOrEqual(resolved, denied) ||
          pathIsInsideOrEqual(denied, resolved),
      )
    ) {
      throw new Error(
        "provider state source overlaps Zeros engine-private or boundary state",
      );
    }
  }
  const resolvedCompatibilityLinks: Array<ManagedPath & { source: string }> =
    [];
  for (const item of compatibilityLinks) {
    try {
      const source = await realpath(item.source);
      const stat = await lstat(source);
      if (!stat.isDirectory() && !stat.isFile()) continue;
      resolvedCompatibilityLinks.push({ ...item, source });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const persistentRoot = path.join(
    zerosDataDir(),
    "provider-home",
    providerId,
    workspaceKey(providerId, workspaceRoot, hostHome),
  );
  const contentRoot = path.join(persistentRoot, "content");
  await mkdir(contentRoot, { recursive: true, mode: 0o700 });
  await assertPhysicalDirectory(contentRoot, "durable provider HOME overlay");
  return withPromotionLock(persistentRoot, async () => {
    const state = await readDurableState(persistentRoot);
    const host = await snapshotManagedSources(managed);
    let persistent = await durableSnapshot(
      contentRoot,
      managed,
      state.tombstones,
    );
    const tombstones = new Set(state.tombstones);
    const hostBases = new Map<string, EntrySnapshot | undefined>(
      Object.entries(state.hostBases).map(([relative, snapshot]) => [
        relative,
        snapshot ?? undefined,
      ]),
    );
    let stateChanged = state.migratedFromV1;
    let credentialMarkerAction: "none" | "write" | "remove" = "none";
    let nextCredentialMarker: CredentialSourceMarker | null = null;
    let activeCredentialSource: ActiveCredentialSource | undefined;
    if (credentialRelative) {
      const marker = await readCredentialSourceMarker(
        persistentRoot,
        providerId,
        credentialRelative,
      );
      const credentialReader =
        configuredCredentialReader ??
        (marker ? async () => ({ status: "unavailable" as const }) : undefined);
      const source = await credentialReader?.();
      let fallbackSnapshot: EntrySnapshot | undefined;
      if (source?.status === "available") {
        const bytes = normalizedCredentialBytes(source.value);
        const snapshot = credentialSnapshot(bytes);
        fallbackSnapshot = snapshot;
        host.set(credentialRelative, snapshot);
        const durable = persistent.get(credentialRelative);
        const sourceChanged = marker?.digest !== snapshot.digest;
        if (sourceChanged || durable?.kind !== "file") {
          await atomicWritePrivateFile(contentRoot, credentialRelative, bytes);
          for (const tombstone of [...tombstones]) {
            if (
              relativeIsInsideOrEqual(credentialRelative, tombstone) ||
              relativeIsInsideOrEqual(tombstone, credentialRelative)
            ) {
              tombstones.delete(tombstone);
            }
          }
          for (const relative of [...hostBases.keys()]) {
            if (
              relative !== credentialRelative &&
              relativeIsInsideOrEqual(relative, credentialRelative)
            ) {
              hostBases.delete(relative);
            }
          }
          stateChanged = true;
          persistent = await durableSnapshot(contentRoot, managed, [
            ...tombstones,
          ]);
        }
        if (!equalEntry(hostBases.get(credentialRelative), snapshot)) {
          hostBases.set(credentialRelative, snapshot);
          stateChanged = true;
        }
        nextCredentialMarker = {
          version: 1,
          providerId,
          relative: credentialRelative,
          digest: snapshot.digest,
        };
        if (
          !marker ||
          marker.digest !== snapshot.digest ||
          marker.relative !== credentialRelative ||
          marker.providerId !== providerId
        ) {
          credentialMarkerAction = "write";
        }
      } else if (source?.status === "absent" && marker) {
        await removeContainedEntry(contentRoot, credentialRelative);
        for (const relative of [...hostBases.keys()]) {
          if (relativeIsInsideOrEqual(relative, credentialRelative)) {
            hostBases.delete(relative);
          }
        }
        tombstones.delete(credentialRelative);
        persistent = await durableSnapshot(contentRoot, managed, [
          ...tombstones,
        ]);
        stateChanged = true;
        credentialMarkerAction = "remove";
      } else if (source?.status === "unavailable" && marker) {
        const snapshot: EntrySnapshot = {
          kind: "file",
          digest: marker.digest,
          mode: 0o600,
        };
        if (persistent.get(credentialRelative)?.kind !== "file") {
          throw new Error(
            "provider keychain credential is temporarily unavailable",
          );
        }
        fallbackSnapshot = snapshot;
        host.set(credentialRelative, snapshot);
      } else if (
        source?.status === "unavailable" &&
        host.get(credentialRelative)?.kind !== "file"
      ) {
        throw new Error(
          "provider keychain credential is temporarily unavailable",
        );
      }
      if (credentialReader) {
        activeCredentialSource = {
          relative: credentialRelative,
          read: credentialReader,
          ...(fallbackSnapshot ? { fallbackSnapshot } : {}),
        };
      }
    }
    if (state.migratedFromV1) {
      // Version 1 had no third side. Adopt the current host as the base once;
      // this preserves existing private state and makes every later host edit
      // detectable instead of guessing destructively during migration.
      for (const relative of persistent.keys()) {
        if (!hostBases.has(relative)) {
          hostBases.set(relative, host.get(relative));
          stateChanged = true;
        }
      }
    }
    const staleRoots = new Set<string>();
    const conflictRoots = new Set<string>();
    const preparationConflicts: string[] = [];
    for (const [relative, base] of hostBases) {
      const durable = persistent.get(relative);
      if (!durable) {
        hostBases.delete(relative);
        stateChanged = true;
        continue;
      }
      const currentHost = host.get(relative);
      if (equalEntry(base, currentHost)) continue;
      if (durableMatchesLocal(durable, currentHost)) {
        staleRoots.add(relative);
        continue;
      }
      preparationConflicts.push(conflictId(relative));
      staleRoots.add(relative);
      conflictRoots.add(relative);
    }
    if (staleRoots.size > 0) {
      for (const relative of conflictRoots) {
        const durable = persistent.get(relative);
        if (!durable) continue;
        // Auth artifacts are intentionally recoverable through provider login,
        // not duplicated into long-lived conflict archives. A parent conflict
        // is skipped too because copying it would include the credential.
        if (
          credentialRelative &&
          (relativeIsInsideOrEqual(credentialRelative, relative) ||
            relativeIsInsideOrEqual(relative, credentialRelative))
        ) {
          continue;
        }
        const recovery = path.join(
          persistentRoot,
          "conflicts",
          `${Date.now()}-${randomUUID()}`,
        );
        if (durable.kind === "tombstone") {
          await mkdir(recovery, { recursive: true, mode: 0o700 });
          await writeFile(
            path.join(recovery, "deletion.json"),
            `${JSON.stringify({ operation: "delete", pathHash: conflictId(relative) })}\n`,
            { encoding: "utf8", mode: 0o600, flag: "wx" },
          );
        } else {
          await copyTree(
            path.join(contentRoot, relative),
            path.join(recovery, relative),
          );
        }
      }
      const expanded = [...persistent.keys()].filter((relative) =>
        [...staleRoots].some((root) => {
          const rootEntry = persistent.get(root);
          return (
            relative === root ||
            (rootEntry?.kind === "directory" || rootEntry?.kind === "tombstone"
              ? relativeIsInsideOrEqual(relative, root)
              : false)
          );
        }),
      );
      for (const relative of expanded.sort(
        (left, right) => relativeDepth(right) - relativeDepth(left),
      )) {
        await removeContainedEntry(contentRoot, relative);
        tombstones.delete(relative);
        hostBases.delete(relative);
        stateChanged = true;
      }
      persistent = await durableSnapshot(contentRoot, managed, [...tombstones]);
    }
    if (stateChanged) {
      await writeDurableState(persistentRoot, tombstones, hostBases);
    }
    if (credentialMarkerAction === "write" && nextCredentialMarker) {
      await writeCredentialSourceMarker(persistentRoot, nextCredentialMarker);
    } else if (credentialMarkerAction === "remove") {
      await removeCredentialSourceMarker(persistentRoot);
    }
    for (const item of compatibilitySeeds) {
      try {
        await copyTree(
          await realpath(item.source),
          path.join(options.localHome, item.relative),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const item of managed) {
      await copyTree(item.source, path.join(options.localHome, item.relative));
    }
    for (const item of managed) {
      await copyTree(
        path.join(contentRoot, item.relative),
        path.join(options.localHome, item.relative),
      );
    }
    for (const relative of [...state.tombstones].sort(
      (a, b) => relativeDepth(b) - relativeDepth(a),
    )) {
      await removeContainedEntry(options.localHome, relative);
    }
    for (const item of resolvedCompatibilityLinks) {
      await materializeReadOnlyLink(
        options.localHome,
        item.relative,
        item.source,
      );
    }
    await Promise.all(
      [
        ".config",
        ".cache",
        path.join(".local", "share"),
        path.join(".local", "state"),
      ].map((relative) =>
        mkdir(path.join(options.localHome, relative), {
          recursive: true,
          mode: 0o700,
        }),
      ),
    );
    return {
      providerId,
      workspaceRoot,
      localHome: options.localHome,
      persistentRoot,
      contentRoot,
      managed,
      readOnlyHostRoots: [
        ...new Set(resolvedCompatibilityLinks.map((item) => item.source)),
      ].sort((left, right) => left.localeCompare(right)),
      baselineLocal: await snapshotManaged(options.localHome, managed),
      baselineHost: host,
      baselinePersistent: persistent,
      preparationConflicts,
      ...(activeCredentialSource
        ? { credentialSource: activeCredentialSource }
        : {}),
      env: {
        HOME: options.localHome,
        XDG_CONFIG_HOME: path.join(options.localHome, ".config"),
        XDG_CACHE_HOME: path.join(options.localHome, ".cache"),
        XDG_DATA_HOME: path.join(options.localHome, ".local", "share"),
        XDG_STATE_HOME: path.join(options.localHome, ".local", "state"),
        ...(providerId === "claude"
          ? { CLAUDE_CONFIG_DIR: path.join(options.localHome, ".claude") }
          : {}),
        ...(providerId === "codex"
          ? { CODEX_HOME: path.join(options.localHome, ".codex") }
          : {}),
      },
    };
  });
}

export async function promoteProviderHomeOverlay(
  overlay: ProviderHomeOverlay,
): Promise<ProviderHomePromotionResult> {
  return withPromotionLock(overlay.persistentRoot, async () => {
    const local = await snapshotManaged(overlay.localHome, overlay.managed);
    const host = await snapshotManagedSources(overlay.managed);
    if (overlay.credentialSource) {
      const source = await overlay.credentialSource.read();
      if (source.status === "available") {
        host.set(
          overlay.credentialSource.relative,
          credentialSnapshot(normalizedCredentialBytes(source.value)),
        );
      } else if (
        source.status === "unavailable" &&
        overlay.credentialSource.fallbackSnapshot
      ) {
        host.set(
          overlay.credentialSource.relative,
          overlay.credentialSource.fallbackSnapshot,
        );
      }
      // Confirmed absence deliberately leaves the real host-file snapshot in
      // place. A user may have switched from Keychain to file storage while
      // this session was active.
    }
    const state = await readDurableState(overlay.persistentRoot);
    const tombstones = new Set(state.tombstones);
    const hostBases = new Map<string, EntrySnapshot | undefined>(
      Object.entries(state.hostBases).map(([relative, snapshot]) => [
        relative,
        snapshot ?? undefined,
      ]),
    );
    const persistent = await durableSnapshot(
      overlay.contentRoot,
      overlay.managed,
      state.tombstones,
    );
    const candidates = [
      ...new Set([...overlay.baselineLocal.keys(), ...local.keys()]),
    ].sort(
      (left, right) =>
        relativeDepth(left) - relativeDepth(right) || left.localeCompare(right),
    );
    const conflicts: string[] = [];
    const conflictRoots = new Set<string>();
    let updatedFiles = 0;
    const changes: Array<{
      relative: string;
      next: EntrySnapshot | undefined;
    }> = [];
    const quarantine = async (
      relative: string,
      next: EntrySnapshot | undefined,
      operation: "write" | "delete",
    ): Promise<void> => {
      const sensitive = providerCredentialRelative(overlay.providerId);
      if (
        sensitive &&
        (relativeIsInsideOrEqual(sensitive, relative) ||
          relativeIsInsideOrEqual(relative, sensitive))
      ) {
        return;
      }
      const recovery = path.join(
        overlay.persistentRoot,
        "conflicts",
        `${Date.now()}-${randomUUID()}`,
      );
      if (next) {
        await copyTree(
          path.join(overlay.localHome, relative),
          path.join(recovery, relative),
        );
      } else {
        await mkdir(recovery, { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(recovery, "deletion.json"),
          `${JSON.stringify({ operation, pathHash: conflictId(relative) })}\n`,
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
      }
    };
    for (const relative of candidates) {
      const before = overlay.baselineLocal.get(relative);
      const next = local.get(relative);
      if (equalEntry(before, next)) continue;
      // A directory whose kind is unchanged is structural. Its descendant
      // entries carry the actual edits; treating the recursive digest as one
      // write would turn disjoint child edits into false conflicts.
      if (before?.kind === "directory" && next?.kind === "directory") continue;
      if (
        [...conflictRoots].some((root) =>
          relativeIsInsideOrEqual(relative, root),
        )
      ) {
        continue;
      }
      const hostBefore = overlay.baselineHost.get(relative);
      const hostNow = host.get(relative);
      if (!equalEntry(hostBefore, hostNow) && !equalEntry(hostNow, next)) {
        conflicts.push(conflictId(relative));
        if (
          before?.kind === "directory" ||
          next?.kind === "directory" ||
          next === undefined
        ) {
          conflictRoots.add(relative);
        }
        await quarantine(relative, next, next ? "write" : "delete");
        continue;
      }
      const durableBefore = overlay.baselinePersistent.get(relative);
      const durableNow = persistent.get(relative);
      if (
        !equalDurableEntry(durableBefore, durableNow) &&
        !durableMatchesLocal(durableNow, next)
      ) {
        conflicts.push(conflictId(relative));
        if (
          before?.kind === "directory" ||
          next?.kind === "directory" ||
          durableNow?.kind === "directory" ||
          durableNow?.kind === "tombstone" ||
          next === undefined
        ) {
          conflictRoots.add(relative);
        }
        await quarantine(relative, next, next ? "write" : "delete");
        continue;
      }
      changes.push({ relative, next });
    }
    changes.sort((left, right) => {
      if (!left.next && right.next) return -1;
      if (left.next && !right.next) return 1;
      const leftDepth = relativeDepth(left.relative);
      const rightDepth = relativeDepth(right.relative);
      return left.next
        ? leftDepth - rightDepth || left.relative.localeCompare(right.relative)
        : rightDepth - leftDepth || left.relative.localeCompare(right.relative);
    });
    for (const { relative, next } of changes) {
      const destination = path.join(overlay.contentRoot, relative);
      const hostNow = host.get(relative);
      if (equalEntry(hostNow, next)) {
        await removeContainedEntry(overlay.contentRoot, relative);
        tombstones.delete(relative);
        hostBases.delete(relative);
        updatedFiles += 1;
        continue;
      }
      if (!next) {
        await removeContainedEntry(overlay.contentRoot, relative);
        tombstones.add(relative);
      } else {
        await ensurePhysicalParents(overlay.contentRoot, relative);
        await atomicCopyEntry(
          path.join(overlay.localHome, relative),
          destination,
          next,
        );
        tombstones.delete(relative);
        if (next.kind !== "directory") {
          for (const tombstone of [...tombstones]) {
            if (tombstone.startsWith(`${relative}${path.sep}`)) {
              tombstones.delete(tombstone);
            }
          }
        }
      }
      hostBases.set(relative, hostNow);
      updatedFiles += 1;
    }
    await writeDurableState(overlay.persistentRoot, tombstones, hostBases);
    return { conflicts, updatedFiles };
  });
}

/** Move an unpromoted private HOME out of the ephemeral boundary before the
 * boundary root is removed. This is deliberately whole-directory recovery:
 * an unexpected I/O/state-format error must not discard a provider artifact
 * merely because it was outside the currently known managed-path corpus. */
export async function preserveProviderHomeOverlay(
  overlay: ProviderHomeOverlay,
  failure: unknown,
): Promise<string> {
  const recovery = path.join(
    overlay.persistentRoot,
    "recovery",
    `${Date.now()}-${randomUUID()}`,
  );
  await mkdir(recovery, { recursive: true, mode: 0o700 });
  const recoveredHome = path.join(recovery, "home");
  try {
    await rename(overlay.localHome, recoveredHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await mkdir(recoveredHome, { mode: 0o700 });
    for (const item of overlay.managed) {
      await copyTree(
        path.join(overlay.localHome, item.relative),
        path.join(recoveredHome, item.relative),
      );
    }
  }
  await writeFile(
    path.join(recovery, "failure.json"),
    `${JSON.stringify({
      version: 1,
      providerId: overlay.providerId,
      workspaceHash: createHash("sha256")
        .update(overlay.workspaceRoot)
        .digest("hex"),
      errorName: failure instanceof Error ? failure.name : "UnknownError",
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await syncDirectory(recovery);
  return recovery;
}

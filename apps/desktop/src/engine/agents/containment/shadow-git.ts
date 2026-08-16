import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Socket } from "node:net";
import { Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { zerosDataDir } from "../../db/paths";
import { openSqlite } from "../../db/sqlite";
import {
  prepareGitCredentialInvocation,
  refreshGitCredentialAfterAuthenticationFailure,
  type GitCredentialInvocation,
} from "../../git/credential-broker";
import { runFile } from "../../git/git-exec";
import type { AgentFilesystemTerritory } from "../types";
import { SHADOW_GIT_RECOVERY_HOLD_FILE } from "../session-paths";
import { ShadowGitRemoteBroker } from "./shadow-git-remote-broker";
import type {
  ShadowGitBrokerOperation,
  ShadowGitLocalOperation,
  ShadowGitRemoteOperation,
  ShadowGitRemoteResult,
} from "./shadow-git-remote-broker";
import type { TerritoryGeneration } from "./types";

const MAX_REFS = 100_000;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_INDEX_BYTES = 512 * 1024 * 1024;
const MAX_PRIVATE_OBJECT_FILES = 200_000;
const MAX_PRIVATE_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PRIVATE_LFS_FILES = 200_000;
const MAX_PRIVATE_LFS_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_LINKED_WORKTREES = 128;
const MAX_LINKED_WORKTREE_METADATA_FILES = 4_096;
const MAX_LINKED_WORKTREE_METADATA_BYTES = 512 * 1024 * 1024;
const MAX_HOOK_FILES = 2_048;
const MAX_HOOK_BYTES = 64 * 1024 * 1024;
const MAX_CONFIG_ENTRIES = 10_000;
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_CONFIG_VALUE_BYTES = 1024 * 1024;
const MAX_STAGED_FETCHES = 32;
const MAX_REFLOGS = 4_096;
const MAX_REFLOG_ENTRIES = 100_000;
const ZERO_SHA1 = "0".repeat(40);
const ZERO_SHA256 = "0".repeat(64);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMOTION_LOCK_WAIT_MS = 30_000;
const SHADOW_RECOVERY_VERSION = 2 as const;
const MAX_RECOVERY_FILES =
  MAX_PRIVATE_OBJECT_FILES + MAX_PRIVATE_LFS_FILES + 100_000;
const MAX_RECOVERY_BYTES =
  MAX_PRIVATE_OBJECT_BYTES +
  MAX_PRIVATE_LFS_BYTES +
  MAX_LINKED_WORKTREE_METADATA_BYTES +
  1024 * 1024 * 1024;

const promotionTails = new Map<string, Promise<void>>();

export type ShadowGitPromotionState = "not-applicable" | "clean" | "promoted";

export interface ShadowGitPromotionResult {
  readonly state: ShadowGitPromotionState;
  readonly updatedRefs: number;
  readonly indexUpdated: boolean;
}

interface ScopedHttpRemote {
  readonly kind: "http";
  readonly name: string | null;
  readonly url: string;
  readonly protocol: "http" | "https";
  readonly host: string;
  readonly authority: string;
}

interface ScopedSshRemote {
  readonly kind: "ssh";
  readonly name: string | null;
  readonly url: string;
}

interface ScopedNativeRemote {
  readonly kind: "native";
  readonly name: string | null;
  readonly url: string;
}

type ScopedBrokeredRemote = ScopedHttpRemote | ScopedSshRemote;
type ScopedGitRemote = ScopedBrokeredRemote | ScopedNativeRemote;

export class ShadowGitPromotionError extends Error {
  constructor(
    readonly code:
      | "concurrent-git-change"
      | "design-impact"
      | "invalid-shadow-repository"
      | "quota-exceeded",
    message: string,
  ) {
    super(message);
    this.name = "ShadowGitPromotionError";
  }
}

export interface CanonicalGitRepository {
  readonly workspaceRoot: string;
  readonly gitEntry: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly objectDir: string;
  readonly indexPath: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly gitBinary: string;
  readonly uploadPackBinary: string;
}

export interface ShadowGitOptions {
  readonly workspaceRoot: string;
  /** Durable code roots in which an agent-created linked worktree may survive
   * session teardown. Ephemeral boundary-private roots are deliberately not
   * promoted into canonical Git metadata. */
  readonly additionalWriteRoots?: readonly string[];
  readonly shadowRoot: string;
  readonly privateHome: string;
  readonly commandsRoot: string;
  readonly toolsRoot: string;
  readonly toolRuntime: string;
  readonly generation: TerritoryGeneration;
  readonly territory?: AgentFilesystemTerritory;
  readonly repository: CanonicalGitRepository;
  /** Optional port reservation created before policy serialization so the
   * credential broker is reachable through the exact ZSR localhost grant. */
  readonly remoteBroker?: ShadowGitRemoteBroker;
  /** Absolute fake SSH transport used only by the integration suite. */
  readonly trustedSshCommandForTesting?: string;
  /** Deterministic crash-point injection for the recovery suite. Production
   * callers must omit it. Throw an error carrying `zsrSimulatedCrash: true` to
   * emulate abrupt process death without running in-process cleanup. */
  readonly promotionCheckpointForTesting?: (
    phase:
      | "replacements-staged"
      | "journal-prepared"
      | "refs-committed"
      | "head-committed"
      | "index-committed"
      | "recovery-copy-ready"
      | "recovery-pointer-committed"
      | "recovery-source-removed",
  ) => void | Promise<void>;
}

export interface ShadowGitFilesystemProjection {
  readonly source: string;
  readonly destination: string;
  readonly readOnly: boolean;
}

interface StagedReplacement {
  readonly changed: boolean;
  readonly target: string;
  readonly lockPath: string | null;
  readonly temporaryPath: string | null;
  readonly expectedDigest: string | null;
  readonly candidateDigest: string | null;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

interface GitPromotionJournal {
  readonly version: 1;
  readonly transactionId: string;
  readonly workspaceHash: string;
  readonly generation: string;
  readonly state: "prepared" | "refs-committed" | "head-committed";
  readonly refs: readonly {
    readonly name: string;
    readonly before: string | null;
    readonly after: string | null;
  }[];
  readonly head: Omit<StagedReplacement, "commit" | "abort">;
  readonly index: Omit<StagedReplacement, "commit" | "abort">;
}

function isSimulatedCrash(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as { zsrSimulatedCrash?: unknown }).zsrSimulatedCrash === true,
  );
}

function executableOnPath(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching the engine-authored PATH.
    }
  }
  return null;
}

function executableOnTrustedHostPath(name: string): string | null {
  for (const directory of [
    "/usr/bin",
    "/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ]) {
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching the fixed host-tool path.
    }
  }
  return null;
}

function absoluteFrom(base: string, value: string): string {
  return path.resolve(path.isAbsolute(value) ? value : path.join(base, value));
}

function pathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function trustedGitEnvironment(
  privateHome: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: privateHome,
    XDG_CONFIG_HOME: path.join(privateHome, ".config"),
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...overrides,
  };
}

function trustedGitArgs(emptyHooks: string, args: readonly string[]): string[] {
  return [
    "-c",
    `core.hooksPath=${emptyHooks}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "protocol.ext.allow=never",
    ...args,
  ];
}

function assertCapabilityActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("shadow Git capability was revoked");
}

async function runTrustedGit(opts: {
  repository: CanonicalGitRepository;
  privateHome: string;
  emptyHooks: string;
  cwd: string;
  args: readonly string[];
  gitDir?: string;
  workTree?: string;
  indexFile?: string;
  input?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string }> {
  assertCapabilityActive(opts.signal);
  return runFile(
    opts.repository.gitBinary,
    trustedGitArgs(opts.emptyHooks, opts.args),
    {
      cwd: opts.cwd,
      maxBufferBytes: MAX_GIT_OUTPUT,
      timeoutMs: opts.timeoutMs ?? 30_000,
      input: opts.input,
      env: trustedGitEnvironment(opts.privateHome, {
        ...(opts.gitDir ? { GIT_DIR: opts.gitDir } : {}),
        ...(opts.workTree ? { GIT_WORK_TREE: opts.workTree } : {}),
        ...(opts.indexFile ? { GIT_INDEX_FILE: opts.indexFile } : {}),
        ...(opts.env ?? {}),
      }),
      signal: opts.signal,
    },
  );
}

async function runDiscoveryGit(
  gitBinary: string,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await runFile(gitBinary, [...args], {
    cwd,
    timeoutMs: 10_000,
    maxBufferBytes: MAX_GIT_OUTPUT,
    env: trustedGitEnvironment(path.dirname(gitBinary)),
  });
  return stdout.trim();
}

/** Resolve canonical metadata without trusting ambient GIT_* variables or
 * repository programs. `rev-parse` and `--exec-path` are fixed Git plumbing
 * operations and do not invoke hooks, aliases, filters, or helpers. */
export async function discoverCanonicalGitRepository(
  workspaceRoot: string,
): Promise<CanonicalGitRepository | null> {
  const gitBinary = executableOnPath("git");
  if (!gitBinary) throw new Error("Git is unavailable for the ZSR shadow view");
  try {
    const inside = await runDiscoveryGit(gitBinary, workspaceRoot, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    if (inside !== "true") return null;
  } catch {
    return null;
  }

  const top = realpathSync(
    await runDiscoveryGit(gitBinary, workspaceRoot, [
      "rev-parse",
      "--show-toplevel",
    ]),
  );
  const canonicalWorkspace = realpathSync(workspaceRoot);
  if (top !== canonicalWorkspace) {
    throw new Error("ZSR Git workspace root does not match Git's top level");
  }
  const gitDir = realpathSync(
    await runDiscoveryGit(gitBinary, workspaceRoot, [
      "rev-parse",
      "--absolute-git-dir",
    ]),
  );
  const commonRaw = await runDiscoveryGit(gitBinary, workspaceRoot, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const commonDir = realpathSync(absoluteFrom(workspaceRoot, commonRaw));
  const objectDir = realpathSync(path.join(commonDir, "objects"));
  const indexRaw = await runDiscoveryGit(gitBinary, workspaceRoot, [
    "rev-parse",
    "--git-path",
    "index",
  ]);
  const indexPath = absoluteFrom(workspaceRoot, indexRaw);
  const formatRaw = await runDiscoveryGit(gitBinary, workspaceRoot, [
    "rev-parse",
    "--show-object-format",
  ]).catch(() => "sha1");
  if (formatRaw !== "sha1" && formatRaw !== "sha256") {
    throw new Error("unsupported Git object format");
  }
  const execPath = await runDiscoveryGit(gitBinary, workspaceRoot, [
    "--exec-path",
  ]);
  const uploadPackBinary = realpathSync(path.join(execPath, "git-upload-pack"));
  accessSync(uploadPackBinary, fsConstants.X_OK);

  const gitEntry = path.join(canonicalWorkspace, ".git");
  if (!existsSync(gitEntry)) {
    throw new Error("Git worktree metadata entry is missing");
  }
  return {
    workspaceRoot: canonicalWorkspace,
    gitEntry,
    gitDir,
    commonDir,
    objectDir,
    indexPath,
    objectFormat: formatRaw,
    gitBinary,
    uploadPackBinary,
  };
}

interface RefSnapshot {
  readonly refs: Map<string, string>;
  readonly symbolicRefs: Map<string, string>;
}

function parseRefSnapshot(output: string, oidLength: number): RefSnapshot {
  const refs = new Map<string, string>();
  const symbolicRefs = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [ref = "", oid = "", symbolicTarget = "", ...extra] =
      line.split("\0");
    if (
      extra.length > 0 ||
      !ref?.startsWith("refs/") ||
      !oid ||
      !new RegExp(`^[0-9a-f]{${oidLength}}$`).test(oid) ||
      (symbolicTarget !== "" && !symbolicTarget.startsWith("refs/"))
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git produced an invalid ref snapshot",
      );
    }
    refs.set(ref, oid);
    if (symbolicTarget) symbolicRefs.set(ref, symbolicTarget);
    if (refs.size > MAX_REFS) {
      throw new ShadowGitPromotionError(
        "quota-exceeded",
        "Git ref count exceeds the ZSR promotion limit",
      );
    }
  }
  return { refs, symbolicRefs };
}

function sameStringMap(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([key, value]) => right.get(key) === value)
  );
}

async function readBoundedRegularFile(
  file: string,
  maximum: number,
): Promise<Buffer | null> {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Git metadata is not a physical regular file");
    }
    if (metadata.size > maximum) throw new Error("Git metadata exceeds limit");
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function digest(value: Buffer | null): string | null {
  return value ? createHash("sha256").update(value).digest("hex") : null;
}

function validDigest(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && /^[0-9a-f]{64}$/.test(value))
  );
}

function parseConfigList(output: string): Array<readonly [string, string]> {
  if (Buffer.byteLength(output) > MAX_CONFIG_BYTES) {
    throw new Error("Git config exceeds the ZSR byte limit");
  }
  const entries: Array<readonly [string, string]> = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\n");
    if (separator <= 0) throw new Error("Git produced invalid config output");
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1);
    if (
      !/^[A-Za-z0-9]/.test(key) ||
      /[\0\r\n]/.test(key) ||
      value.includes("\0") ||
      Buffer.byteLength(value) > MAX_CONFIG_VALUE_BYTES
    ) {
      throw new Error("Git produced an unsafe config entry");
    }
    entries.push([key, value]);
    if (entries.length > MAX_CONFIG_ENTRIES) {
      throw new Error("Git config exceeds the ZSR entry limit");
    }
  }
  return entries;
}

function withoutEmbeddedPassword(value: string): string | null {
  if (/^(?:ext::|fd::)/i.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (!/^(?:https?|ssh|git):$/.test(parsed.protocol)) return value;
    // Query strings, fragments, and passwords routinely carry bearer material.
    // They cannot be copied into an agent-writable config or a process argv.
    if (parsed.search || parsed.hash) return null;
    if (!parsed.password) return value;
    parsed.password = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function scopedHttpRemoteUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function scopedSshRemoteUrl(value: string): string | null {
  if (/^ssh:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== "ssh:" ||
        !parsed.hostname ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        !parsed.pathname ||
        parsed.pathname === "/"
      ) {
        return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }
  if (
    value.length === 0 ||
    value.length > 16_384 ||
    value.startsWith("-") ||
    /[\0-\x20\x7f\\]/.test(value) ||
    value.includes("://")
  ) {
    return null;
  }
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const authority = value.slice(0, separator);
  const remotePath = value.slice(separator + 1);
  if (
    authority.includes("/") ||
    remotePath.startsWith("-") ||
    remotePath.includes("\0")
  ) {
    return null;
  }
  const at = authority.lastIndexOf("@");
  const host = at < 0 ? authority : authority.slice(at + 1);
  if (
    !host ||
    (host.startsWith("[")
      ? !/^\[[0-9A-Fa-f:.]+\]$/.test(host)
      : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(host))
  ) {
    return null;
  }
  if (at >= 0 && !/^[A-Za-z0-9._-]{1,255}$/.test(authority.slice(0, at))) {
    return null;
  }
  return value;
}

function scopedBrokeredRemoteUrl(value: string): string | null {
  return scopedHttpRemoteUrl(value) ?? scopedSshRemoteUrl(value);
}

interface ScopedSshInvocation {
  readonly authority: string;
  readonly port: string | null;
  readonly repositoryPath: string;
}

function scopedSshInvocation(value: string): ScopedSshInvocation | null {
  if (!scopedSshRemoteUrl(value)) return null;
  if (/^ssh:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const username = parsed.username
        ? decodedUrlComponent(parsed.username)
        : "";
      if (username && !/^[A-Za-z0-9._-]{1,255}$/.test(username)) return null;
      const rawHost = parsed.hostname;
      const host =
        rawHost.startsWith("[") && rawHost.endsWith("]")
          ? rawHost.slice(1, -1)
          : rawHost;
      const repositoryPath = decodedUrlComponent(parsed.pathname);
      if (
        !host ||
        !repositoryPath ||
        repositoryPath.length > 16_384 ||
        /[\0\r\n]/.test(repositoryPath)
      ) {
        return null;
      }
      return {
        authority: username ? `${username}@${host}` : host,
        port: parsed.port || null,
        repositoryPath,
      };
    } catch {
      return null;
    }
  }
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const authority = value.slice(0, separator);
  const repositoryPath = value.slice(separator + 1);
  return { authority, port: null, repositoryPath };
}

function remoteExtLiteral(value: string): string {
  if (
    !value ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("SSH transport contains an unsafe remote-ext argument");
  }
  return value.replaceAll("%", "%%").replaceAll(" ", "% ");
}

function remoteShellQuote(value: string): string {
  if (!value || /[\0\r\n]/.test(value)) {
    throw new Error("SSH transport contains an unsafe repository path");
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sshRemoteExtCommand(remoteUrl: string, sshExecutable: string): string {
  const invocation = scopedSshInvocation(remoteUrl);
  if (!invocation || !path.isAbsolute(sshExecutable)) {
    throw new Error("SSH promisor transport is not safely addressable");
  }
  const args = [
    remoteExtLiteral(sshExecutable),
    "-o",
    "BatchMode=yes",
    ...(invocation.port ? ["-p", invocation.port] : []),
    "--",
    remoteExtLiteral(invocation.authority),
    `%S% ${remoteExtLiteral(remoteShellQuote(invocation.repositoryPath))}`,
  ];
  return args.join(" ");
}

function gitBoolean(value: string): boolean {
  return /^(?:1|true|yes|on)$/i.test(value.trim());
}

function promisorTransports(
  entries: readonly (readonly [string, string])[],
  admitted: ReadonlyMap<string, AdmittedRemoteUrls>,
): Array<readonly [string, string]> {
  const promisor = new Set<string>();
  const remoteValues = new Map<string, string>();
  for (const [key, value] of entries) {
    const partial = /^extensions\.partialclone$/i.test(key);
    if (partial && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value)) {
      promisor.add(value);
      continue;
    }
    const promised =
      /^remote\.([A-Za-z0-9][A-Za-z0-9._-]{0,254})\.promisor$/i.exec(key);
    if (promised) {
      if (gitBoolean(value)) promisor.add(promised[1]!);
      else promisor.delete(promised[1]!);
      continue;
    }
    const remote = /^remote\.([A-Za-z0-9][A-Za-z0-9._-]{0,254})\.url$/i.exec(
      key,
    );
    if (remote && !remoteValues.has(remote[1]!)) {
      remoteValues.set(remote[1]!, value);
    }
  }
  const rewrites: Array<readonly [string, string]> = [];
  for (const name of promisor) {
    const source = remoteValues.get(name);
    const normalized = source ? scopedBrokeredRemoteUrl(source) : null;
    if (!source || !normalized || admitted.get(name)?.fetch !== normalized) {
      continue;
    }
    rewrites.push([name, normalized]);
  }
  return rewrites;
}

/** Permit only the read half of Git's remote-helper protocol. In particular,
 * `get` can name an engine-side output path and `push`/export can mutate the
 * remote, so neither may cross this implicit lazy-fetch transport. */
function fetchOnlyRemoteProtocol(): Transform {
  let pending = Buffer.alloc(0);
  let uploadPackStream = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (uploadPackStream) {
        this.push(chunk);
        callback();
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 64 * 1024) {
        callback(new Error("Git remote-helper request is too large"));
        return;
      }
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        const framed = pending.subarray(0, newline + 1);
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        const connects =
          line === "connect git-upload-pack" ||
          line === "stateless-connect git-upload-pack";
        const allowed =
          line === "" ||
          line === "capabilities" ||
          line === "list" ||
          line.startsWith("option ") ||
          /^fetch [0-9a-f]{40}(?:[0-9a-f]{24})? [^\0\r\n]{1,16384}$/.test(
            line,
          ) ||
          connects;
        if (!allowed) {
          callback(
            new Error("Git promisor transport accepts upload-pack only"),
          );
          return;
        }
        this.push(framed);
        if (connects) {
          uploadPackStream = true;
          if (pending.length > 0) this.push(pending);
          pending = Buffer.alloc(0);
          break;
        }
      }
      callback();
    },
    flush(callback) {
      callback(
        pending.length === 0
          ? undefined
          : new Error("Git remote-helper request ended mid-frame"),
      );
    },
  });
}

function decodedUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface AdmittedRemoteUrls {
  readonly fetch: string | null;
  readonly push: string | null;
  readonly fetchRefspecs: readonly string[];
}

function admittedRemoteUrls(
  entries: readonly (readonly [string, string])[],
): Map<string, AdmittedRemoteUrls> {
  const values = new Map<
    string,
    { fetch: string | null; push: string | null; fetchRefspecs: string[] }
  >();
  for (const [key, rawValue] of entries) {
    const match =
      /^remote\.([A-Za-z0-9][A-Za-z0-9._-]{0,254})\.(url|pushurl)$/i.exec(key);
    const fetchMatch =
      /^remote\.([A-Za-z0-9][A-Za-z0-9._-]{0,254})\.fetch$/i.exec(key);
    if (!match && !fetchMatch) continue;
    const name = (match?.[1] ?? fetchMatch?.[1])!;
    const existing = values.get(name) ?? {
      fetch: null,
      push: null,
      fetchRefspecs: [],
    };
    if (fetchMatch) {
      if (existing.fetchRefspecs.length < 256) {
        existing.fetchRefspecs.push(rawValue);
      }
      values.set(name, existing);
      continue;
    }
    if (!match) continue;
    const url = scopedBrokeredRemoteUrl(rawValue);
    if (!url) continue;
    // Git uses the first URL for fetch and the first pushurl (falling back to
    // the fetch URL) for this scoped single-destination adapter.
    if (match[2]!.toLowerCase() === "url" && !existing.fetch) {
      existing.fetch = url;
    } else if (match[2]!.toLowerCase() === "pushurl" && !existing.push) {
      existing.push = url;
    }
    values.set(name, existing);
  }
  return new Map(
    [...values].map(([name, urls]) => [
      name,
      {
        fetch: urls.fetch,
        push: urls.push ?? urls.fetch,
        fetchRefspecs: [...urls.fetchRefspecs],
      },
    ]),
  );
}

/** Copy ordinary identity, aliases, filters, hooks, remotes, and preferences,
 * but never serialize a host credential/credential helper into the agent's
 * writable private config. Executable config remains compatible because it
 * runs as a descendant of the boundary. */
function sanitizedConfigEntry(
  key: string,
  value: string,
): readonly [string, string] | null {
  const lower = key.toLowerCase();
  if (
    lower === "include.path" ||
    lower.startsWith("includeif.") ||
    lower.startsWith("credential.") ||
    lower.startsWith("url.") ||
    lower === "core.askpass" ||
    lower === "core.sshcommand" ||
    lower === "core.gitproxy" ||
    /^(?:http|https)(?:\..+)?\.(?:extraheader|cookiefile|sslkey|proxy|proxyauthmethod)$/.test(
      lower,
    )
  ) {
    return null;
  }
  if (/^remote\..+\.(?:url|pushurl)$/.test(lower)) {
    const sanitized = withoutEmbeddedPassword(value);
    return sanitized === null ? null : [key, sanitized];
  }
  return [key, value];
}

async function writeSanitizedConfig(opts: {
  repository: CanonicalGitRepository;
  privateHome: string;
  destination: string;
  entries: readonly (readonly [string, string])[];
}): Promise<void> {
  await writeFile(opts.destination, "", { mode: 0o600, flag: "w" });
  for (const [rawKey, rawValue] of opts.entries) {
    const entry = sanitizedConfigEntry(rawKey, rawValue);
    if (!entry) continue;
    await runFile(
      opts.repository.gitBinary,
      ["config", "--file", opts.destination, "--add", entry[0], entry[1]],
      {
        cwd: opts.repository.workspaceRoot,
        timeoutMs: 10_000,
        maxBufferBytes: MAX_GIT_OUTPUT,
        env: trustedGitEnvironment(opts.privateHome),
      },
    );
  }
  await chmod(opts.destination, 0o600);
}

async function readAmbientGlobalConfig(
  repository: CanonicalGitRepository,
  privateHome: string,
): Promise<Array<readonly [string, string]>> {
  const env = trustedGitEnvironment(privateHome, {
    HOME: process.env.HOME ?? privateHome,
    ...(process.env.XDG_CONFIG_HOME
      ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
      : {}),
  });
  delete env.GIT_CONFIG_GLOBAL;
  const { stdout } = await runFile(
    repository.gitBinary,
    ["config", "--global", "--null", "--list"],
    {
      cwd: repository.workspaceRoot,
      timeoutMs: 10_000,
      maxBufferBytes: MAX_CONFIG_BYTES,
      env,
    },
  ).catch((error: unknown) => {
    const code = (error as { code?: unknown }).code;
    if (code === 1 || code === "1") return { stdout: "", stderr: "" };
    throw error;
  });
  return parseConfigList(stdout);
}

async function copyRegularFileIfPresent(
  source: string,
  destination: string,
  maximum = MAX_INDEX_BYTES,
): Promise<boolean> {
  const value = await readBoundedRegularFile(source, maximum);
  if (!value) return false;
  await writeFile(destination, value, { mode: 0o600, flag: "wx" });
  return true;
}

async function copySelectedGitState(
  sourceGitDir: string,
  shadowRoot: string,
): Promise<void> {
  const names = [
    "MERGE_HEAD",
    "MERGE_MSG",
    "MERGE_MODE",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "BISECT_START",
    "AUTO_MERGE",
    "SQUASH_MSG",
  ];
  for (const name of names) {
    await copyRegularFileIfPresent(
      path.join(sourceGitDir, name),
      path.join(shadowRoot, name),
      16 * 1024 * 1024,
    );
  }
}

async function copyContainedHooks(
  source: string,
  destination: string,
): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  let sourceMetadata;
  try {
    sourceMetadata = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      return;
    }
    throw error;
  }
  if (sourceMetadata.isSymbolicLink()) {
    // Never dereference a trusted-side directory symlink and thereby copy data
    // that the child could not read through the boundary. Point the private
    // view at the original resolved target; normal kernel policy then decides
    // whether that hook is reachable, exactly as it does for any absolute path.
    let target: string;
    try {
      target = realpathSync(source);
    } catch {
      target = path.resolve(path.dirname(source), await readlink(source));
    }
    await symlink(target, destination, "dir");
    return;
  }
  if (!sourceMetadata.isDirectory()) {
    throw new Error("Git hooks path is not a physical directory");
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const canonicalSource = realpathSync(source);
  let files = 0;
  let bytes = 0;
  const pending: Array<{ source: string; destination: string; depth: number }> =
    [{ source, destination, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current.source, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (current.depth > 16) throw new Error("Git hooks tree is too deep");
    for (const entry of entries) {
      const sourcePath = path.join(current.source, entry.name);
      const destinationPath = path.join(current.destination, entry.name);
      if (entry.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        pending.push({
          source: sourcePath,
          destination: destinationPath,
          depth: current.depth + 1,
        });
        continue;
      }
      let sourceFile = sourcePath;
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(sourcePath);
        } catch {
          target = path.resolve(
            path.dirname(sourcePath),
            await readlink(sourcePath),
          );
        }
        if (!pathInside(target, canonicalSource)) {
          files += 1;
          bytes += Buffer.byteLength(target);
          if (files > MAX_HOOK_FILES || bytes > MAX_HOOK_BYTES) {
            throw new Error("Git hooks exceed the ZSR copy limit");
          }
          // Preserve authority instead of expanding it: an out-of-tree link
          // stays a link and remains subject to the sandbox's path policy.
          await symlink(target, destinationPath);
          continue;
        }
        sourceFile = target;
      }
      const handle = await open(
        sourceFile,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
          throw new Error("Git hooks contain a non-regular entry");
        }
        files += 1;
        bytes += metadata.size;
        if (files > MAX_HOOK_FILES || bytes > MAX_HOOK_BYTES) {
          throw new Error("Git hooks exceed the ZSR copy limit");
        }
        const content = await handle.readFile();
        await writeFile(destinationPath, content, {
          mode: metadata.mode & 0o777,
          flag: "wx",
        });
      } finally {
        await handle.close();
      }
    }
  }
}

function allowedPromotedRef(ref: string): boolean {
  return /^(?:refs\/(?:heads|tags|remotes|notes)\/|refs\/stash$)/.test(ref);
}

export interface ParsedShadowGitPush {
  readonly remote: string | null;
  readonly refspecs: readonly string[];
  readonly flags: readonly string[];
  readonly setUpstream: boolean;
  readonly deleteMode: boolean;
  readonly forceWithLease: boolean;
  readonly explicitLeases: readonly string[];
  readonly allBranches: boolean;
  readonly allTags: boolean;
  readonly followTags: boolean;
  readonly mirror: boolean;
  readonly prune: boolean;
}

const ALLOWED_PUSH_FLAGS = new Set([
  "-f",
  "--force",
  "--force-if-includes",
  "--atomic",
  "-n",
  "--dry-run",
  "--porcelain",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--progress",
  "--no-progress",
  "--thin",
  "--no-thin",
  "--no-verify",
  "--force-if-includes",
]);

/** Parse only the bounded push surface Zeros can reconstruct against an exact
 * validated object/ref grant. Repository-controlled aliases, upload helpers,
 * receive-pack overrides, config injection, and wildcard/bulk pushes never
 * reach a privileged engine Git process. */
export function parseShadowGitPushArgs(
  args: readonly string[],
): ParsedShadowGitPush {
  if (args.length === 0 || args.length > 1_024) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      "Git push arguments exceed the ZSR broker limit",
    );
  }
  const allowedGlobal = new Set([
    "--no-pager",
    "--paginate",
    "-p",
    "--literal-pathspecs",
    "--glob-pathspecs",
    "--noglob-pathspecs",
    "--icase-pathspecs",
    "--no-replace-objects",
    "--no-optional-locks",
  ]);
  let commandIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "push") {
      commandIndex = index;
      break;
    }
    if (allowedGlobal.has(value)) continue;
    // -C only changes discovery/cwd. The broker is already bound to one
    // canonical repository, so accepting it would be misleading at best and a
    // cross-workspace authority request at worst.
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      `Git global option ${value} is not valid for a scoped push`,
    );
  }
  if (commandIndex < 0) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      "The ZSR Git broker accepts only a direct push command",
    );
  }

  const flags: string[] = [];
  const positionals: string[] = [];
  let setUpstream = false;
  let deleteMode = false;
  let forceWithLease = false;
  const explicitLeases: string[] = [];
  let allBranches = false;
  let allTags = false;
  let followTags = false;
  let mirror = false;
  let prune = false;
  let positionalOnly = false;
  for (let index = commandIndex + 1; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && value.startsWith("-")) {
      if (value === "-u" || value === "--set-upstream") {
        setUpstream = true;
        continue;
      }
      if (value === "--delete" || value === "-d") {
        deleteMode = true;
        continue;
      }
      if (value === "--force-with-lease") {
        forceWithLease = true;
        continue;
      }
      if (value.startsWith("--force-with-lease=")) {
        const lease = value.slice("--force-with-lease=".length);
        if (!lease || /[\0\r\n*]/.test(lease)) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Git push contains an invalid force-with-lease grant",
          );
        }
        explicitLeases.push(lease);
        continue;
      }
      if (value === "--all") {
        allBranches = true;
        continue;
      }
      if (value === "--tags") {
        allTags = true;
        continue;
      }
      if (value === "--follow-tags") {
        followTags = true;
        continue;
      }
      if (value === "--mirror") {
        mirror = true;
        continue;
      }
      if (value === "--prune") {
        prune = true;
        continue;
      }
      if (value === "-o" || value === "--push-option") {
        const option = args[index + 1];
        if (!option || /[\0\r\n]/.test(option) || option.length > 8_192) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Git push option is missing or invalid",
          );
        }
        flags.push("--push-option", option);
        index += 1;
        continue;
      }
      if (value.startsWith("--push-option=")) {
        const option = value.slice("--push-option=".length);
        if (!option || /[\0\r\n]/.test(option) || option.length > 8_192) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Git push option is invalid",
          );
        }
        flags.push(`--push-option=${option}`);
        continue;
      }
      if (ALLOWED_PUSH_FLAGS.has(value)) {
        flags.push(value);
        continue;
      }
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git push option ${value} requires an explicit Zeros adapter`,
      );
    }
    if (/[^\x20-\x7e]/.test(value) || value.length > 16_384) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git push contains an invalid remote or refspec",
      );
    }
    positionals.push(value);
  }
  if (positionals.length > 65) {
    throw new ShadowGitPromotionError(
      "quota-exceeded",
      "Git push contains too many refspecs",
    );
  }
  if (
    [allBranches, allTags, mirror].filter(Boolean).length > 1 ||
    ((allBranches || allTags || mirror) && positionals.length > 1)
  ) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      "Git push bulk modes cannot be combined with explicit refspecs",
    );
  }
  return {
    remote: positionals.shift() ?? null,
    refspecs: positionals,
    flags,
    setUpstream,
    deleteMode,
    forceWithLease,
    explicitLeases,
    allBranches,
    allTags,
    followTags,
    mirror,
    prune,
  };
}

export interface ParsedShadowGitFetch {
  readonly remote: string | null;
  readonly refspecs: readonly string[];
  readonly flags: readonly string[];
}

export interface ParsedShadowGitPull extends ParsedShadowGitFetch {
  readonly integration: "merge" | "rebase" | null;
  readonly integrationFlags: readonly string[];
}

const ALLOWED_SCOPED_GIT_GLOBAL_FLAGS = new Set([
  "--no-pager",
  "--paginate",
  "-p",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-replace-objects",
  "--no-optional-locks",
]);

const FETCH_BOOLEAN_FLAGS = new Set([
  "-a",
  "--append",
  "--atomic",
  "--dry-run",
  "-f",
  "--force",
  "-k",
  "--keep",
  "-n",
  "--no-tags",
  "-t",
  "--tags",
  "-p",
  "--prune",
  "-P",
  "--prune-tags",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--progress",
  "--no-progress",
  "--write-fetch-head",
  "--no-write-fetch-head",
  "--unshallow",
  "--update-shallow",
  "--refetch",
  "--show-forced-updates",
  "--no-show-forced-updates",
  "--auto-maintenance",
  "--no-auto-maintenance",
  "-4",
  "--ipv4",
  "-6",
  "--ipv6",
]);

const FETCH_VALUE_FLAGS = new Set([
  "--depth",
  "--deepen",
  "--shallow-since",
  "--shallow-exclude",
  "--negotiation-tip",
  "--server-option",
  "--refmap",
  "--filter",
]);

const PULL_MERGE_BOOLEAN_FLAGS = new Set([
  "--ff",
  "--no-ff",
  "--ff-only",
  "--commit",
  "--no-commit",
  "--edit",
  "--no-edit",
  "--squash",
  "--no-squash",
  "--stat",
  "--no-stat",
  "--compact-summary",
  "--signoff",
  "--no-signoff",
  "--verify-signatures",
  "--no-verify",
  "--allow-unrelated-histories",
  "--autostash",
  "--no-autostash",
]);

const PULL_MERGE_VALUE_FLAGS = new Set([
  "-s",
  "--strategy",
  "-X",
  "--strategy-option",
  "--cleanup",
  "--gpg-sign",
]);

function scopedCommandIndex(
  args: readonly string[],
  command: "fetch" | "pull",
): number {
  if (args.length === 0 || args.length > 1_024) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      `Git ${command} arguments exceed the ZSR broker limit`,
    );
  }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === command) return index;
    if (ALLOWED_SCOPED_GIT_GLOBAL_FLAGS.has(value)) continue;
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      `Git global option ${value} is not valid for a scoped ${command}`,
    );
  }
  throw new ShadowGitPromotionError(
    "invalid-shadow-repository",
    `The ZSR Git broker accepts only a direct ${command} command`,
  );
}

function safeRemoteArgument(value: string, command: string): string {
  if (
    value.length === 0 ||
    value.length > 16_384 ||
    value.startsWith("-") ||
    /[\0\r\n]/.test(value)
  ) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      `Git ${command} contains an invalid remote`,
    );
  }
  return value;
}

function safeFetchRefspec(value: string, command: string): string {
  if (
    value.length === 0 ||
    value.length > 16_384 ||
    value.startsWith("-") ||
    /[\0-\x20\x7f]/.test(value) ||
    value.includes("::") ||
    value.split("*").length > 3
  ) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      `Git ${command} contains an invalid refspec`,
    );
  }
  return value;
}

function safeFetchOptionValue(flag: string, value: string): string {
  if (value.length === 0 || value.length > 8_192 || /[\0\r\n]/.test(value)) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      `Git fetch option ${flag} is missing or invalid`,
    );
  }
  if (
    (flag === "--depth" || flag === "--deepen") &&
    (!/^\d{1,10}$/.test(value) || Number(value) < 1)
  ) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      `Git fetch option ${flag} needs a positive bounded integer`,
    );
  }
  if (
    flag === "--filter" &&
    !/^(?:blob:none|blob:limit=\d{1,12}[kKmMgG]?|tree:\d{1,10})$/.test(value)
  ) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      "Git fetch filter requires an explicitly supported object filter",
    );
  }
  if (flag === "--refmap") safeFetchRefspec(value, "fetch");
  return value;
}

function consumeFetchFlag(
  args: readonly string[],
  index: number,
): { values: string[]; nextIndex: number } | null {
  const value = args[index]!;
  if (FETCH_BOOLEAN_FLAGS.has(value)) {
    return { values: [value], nextIndex: index };
  }
  if (FETCH_VALUE_FLAGS.has(value)) {
    const option = args[index + 1];
    if (!option) safeFetchOptionValue(value, "");
    return {
      values: [value, safeFetchOptionValue(value, option!)],
      nextIndex: index + 1,
    };
  }
  for (const flag of FETCH_VALUE_FLAGS) {
    if (value.startsWith(`${flag}=`)) {
      const option = safeFetchOptionValue(flag, value.slice(flag.length + 1));
      return { values: [`${flag}=${option}`], nextIndex: index };
    }
  }
  return null;
}

/** Parse a single-remote fetch. Multi-remote fetches are deliberately handled
 * by a separate broker adapter so one credential capability can never be
 * silently reused for another authority. */
export function parseShadowGitFetchArgs(
  args: readonly string[],
): ParsedShadowGitFetch {
  const commandIndex = scopedCommandIndex(args, "fetch");
  const flags: string[] = [];
  const positionals: string[] = [];
  let positionalOnly = false;
  for (let index = commandIndex + 1; index < args.length; index += 1) {
    const value = args[index]!;
    if (!positionalOnly && value === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && value.startsWith("-")) {
      const consumed = consumeFetchFlag(args, index);
      if (consumed) {
        flags.push(...consumed.values);
        index = consumed.nextIndex;
        continue;
      }
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git fetch option ${value} requires an explicit Zeros adapter`,
      );
    }
    positionals.push(value);
  }
  if (positionals.length > 65) {
    throw new ShadowGitPromotionError(
      "quota-exceeded",
      "Git fetch contains too many refspecs",
    );
  }
  const remote = positionals.shift() ?? null;
  return {
    remote: remote === null ? null : safeRemoteArgument(remote, "fetch"),
    refspecs: positionals.map((value) => safeFetchRefspec(value, "fetch")),
    flags,
  };
}

export function parseShadowGitPullArgs(
  args: readonly string[],
): ParsedShadowGitPull {
  const commandIndex = scopedCommandIndex(args, "pull");
  const flags: string[] = [];
  const integrationFlags: string[] = [];
  const positionals: string[] = [];
  let integration: "merge" | "rebase" | null = null;
  let positionalOnly = false;
  for (let index = commandIndex + 1; index < args.length; index += 1) {
    const value = args[index]!;
    if (!positionalOnly && value === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && value.startsWith("-")) {
      if (value === "--rebase" || value === "-r") {
        integration = "rebase";
        continue;
      }
      if (value === "--no-rebase") {
        integration = "merge";
        continue;
      }
      if (value.startsWith("--rebase=")) {
        const mode = value.slice("--rebase=".length);
        if (!["true", "false", "merges", "interactive"].includes(mode)) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Git pull contains an unsupported rebase mode",
          );
        }
        integration = mode === "false" ? "merge" : "rebase";
        if (mode === "merges") integrationFlags.push("--rebase-merges");
        if (mode === "interactive") integrationFlags.push("--interactive");
        continue;
      }
      if (PULL_MERGE_BOOLEAN_FLAGS.has(value)) {
        integrationFlags.push(value);
        continue;
      }
      if (PULL_MERGE_VALUE_FLAGS.has(value)) {
        const option = args[index + 1];
        if (!option || option.startsWith("-") || /[\0\r\n]/.test(option)) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            `Git pull option ${value} is missing or invalid`,
          );
        }
        integrationFlags.push(value, option);
        index += 1;
        continue;
      }
      let matchedMergeValue = false;
      for (const flag of PULL_MERGE_VALUE_FLAGS) {
        if (value.startsWith(`${flag}=`)) {
          const option = value.slice(flag.length + 1);
          if (!option || /[\0\r\n]/.test(option)) {
            throw new ShadowGitPromotionError(
              "invalid-shadow-repository",
              `Git pull option ${flag} is invalid`,
            );
          }
          integrationFlags.push(`${flag}=${option}`);
          matchedMergeValue = true;
          break;
        }
      }
      if (matchedMergeValue) continue;
      const consumed = consumeFetchFlag(args, index);
      if (consumed) {
        flags.push(...consumed.values);
        index = consumed.nextIndex;
        continue;
      }
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git pull option ${value} requires an explicit Zeros adapter`,
      );
    }
    positionals.push(value);
  }
  if (positionals.length > 65) {
    throw new ShadowGitPromotionError(
      "quota-exceeded",
      "Git pull contains too many refspecs",
    );
  }
  const remote = positionals.shift() ?? null;
  return {
    remote: remote === null ? null : safeRemoteArgument(remote, "pull"),
    refspecs: positionals.map((value) => safeFetchRefspec(value, "pull")),
    flags,
    integration,
    integrationFlags,
  };
}

interface StagedFetchRefspecPlan {
  readonly networkRefspecs: readonly string[];
  readonly localRefspecs: readonly string[];
  readonly stagedSource: ReadonlyMap<string, string>;
}

function normalizeRemoteFetchSource(source: string): string {
  if (source === "HEAD") return source;
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(source)) return source;
  if (source.startsWith("refs/")) return source;
  if (
    !source ||
    source.startsWith("-") ||
    /[\0-\x20\x7f~^:?\\]/.test(source) ||
    source.includes("[") ||
    source.includes("..") ||
    source.includes("@{") ||
    source.split("*").length > 2
  ) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      "Git fetch contains an unsupported remote ref expression",
    );
  }
  return `refs/heads/${source}`;
}

function expandTagFetchSyntax(refspecs: readonly string[]): string[] {
  const expanded: string[] = [];
  for (let index = 0; index < refspecs.length; index += 1) {
    const value = refspecs[index]!;
    if (value !== "tag") {
      expanded.push(value);
      continue;
    }
    const tag = refspecs[index + 1];
    if (!tag) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git fetch tag needs an exact tag name",
      );
    }
    expanded.push(`refs/tags/${tag}:refs/tags/${tag}`);
    index += 1;
  }
  return expanded;
}

function positiveFetchSource(raw: string): string | null {
  if (raw.startsWith("^")) return null;
  const value = raw.startsWith("+") ? raw.slice(1) : raw;
  const separator = value.indexOf(":");
  return normalizeRemoteFetchSource(
    separator < 0 ? value : value.slice(0, separator),
  );
}

function fetchRefspecCoversSource(raw: string, source: string): boolean {
  const candidate = positiveFetchSource(raw);
  if (!candidate) return false;
  if (!candidate.includes("*")) return candidate === source;
  const [prefix, suffix] = candidate.split("*");
  return source.startsWith(prefix!) && source.endsWith(suffix!);
}

function stagedFetchRefspecPlan(
  rawRefspecs: readonly string[],
  stagingId: string,
): StagedFetchRefspecPlan {
  const networkRefspecs: string[] = [];
  const localRefspecs: string[] = [];
  const stagedSource = new Map<string, string>();
  const refspecs =
    rawRefspecs.length > 0 ? expandTagFetchSyntax(rawRefspecs) : ["HEAD"];
  let temporaryIndex = 0;
  for (const raw of refspecs) {
    if (raw.startsWith("^")) {
      const excluded = normalizeRemoteFetchSource(raw.slice(1));
      if (excluded === "HEAD" || /^[0-9a-f]+$/.test(excluded)) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git fetch negative refspec must name a ref namespace",
        );
      }
      networkRefspecs.push(`^${excluded}`);
      continue;
    }
    const forced = raw.startsWith("+");
    const value = forced ? raw.slice(1) : raw;
    const separator = value.indexOf(":");
    if (separator >= 0 && value.indexOf(":", separator + 1) >= 0) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git fetch refspec contains multiple separators",
      );
    }
    const source = normalizeRemoteFetchSource(
      separator < 0 ? value : value.slice(0, separator),
    );
    const destination = separator < 0 ? null : value.slice(separator + 1);
    if (!source || destination === "") {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git fetch deletion refspecs are not valid for a remote fetch",
      );
    }
    const sourceHasWildcard = source.includes("*");
    if (sourceHasWildcard && destination && !destination.includes("*")) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git fetch wildcard source needs a wildcard destination",
      );
    }
    const stageRef =
      source === "HEAD" || /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(source)
        ? `refs/zeros/fetch/${stagingId}/${temporaryIndex++}`
        : source;
    const force = forced || stageRef.startsWith("refs/heads/") ? "+" : "";
    networkRefspecs.push(`${force}${source}:${stageRef}`);
    localRefspecs.push(
      `${forced ? "+" : ""}${stageRef}${
        destination === null ? "" : `:${destination}`
      }`,
    );
    stagedSource.set(source, stageRef);
  }
  if (localRefspecs.length === 0) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      "Git fetch refspecs exclude every fetchable ref",
    );
  }
  return { networkRefspecs, localRefspecs, stagedSource };
}

function filterFetchFlags(
  flags: readonly string[],
  target: "network" | "local",
): string[] {
  const networkOmissions = new Set([
    "--depth",
    "--deepen",
    "--shallow-since",
    "--shallow-exclude",
    "--unshallow",
    "--update-shallow",
    "--negotiation-tip",
    "--refmap",
    "--filter",
  ]);
  const localOmissions = new Set([
    "--server-option",
    "-4",
    "--ipv4",
    "-6",
    "--ipv6",
  ]);
  const omissions = target === "network" ? networkOmissions : localOmissions;
  const filtered: string[] = [];
  for (let index = 0; index < flags.length; index += 1) {
    const value = flags[index]!;
    const name = value.includes("=")
      ? value.slice(0, value.indexOf("="))
      : value;
    if (omissions.has(name)) {
      if (FETCH_VALUE_FLAGS.has(name) && !value.includes("=")) index += 1;
      continue;
    }
    filtered.push(value);
  }
  return filtered;
}

async function makeTreeReadOnly(root: string): Promise<void> {
  const directories: string[] = [];
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    directories.push(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_PRIVATE_OBJECT_FILES + MAX_REFS) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Staged Git fetch contains too many filesystem entries",
        );
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Staged Git fetch contains a symbolic link",
        );
      }
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) await chmod(candidate, 0o400);
      else {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Staged Git fetch contains a non-regular entry",
        );
      }
    }
  }
  for (const directory of directories.reverse()) await chmod(directory, 0o500);
}

async function removeReadOnlyTree(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    await chmod(directory, 0o700).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const children = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of children) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(path.join(directory, entry.name));
      }
    }
  }
  await rm(root, { recursive: true, force: true });
}

function relativeProtectedPaths(
  territory: AgentFilesystemTerritory | undefined,
  repository: CanonicalGitRepository,
): string[] {
  if (!territory) return [];
  const protectedPaths: string[] = [];
  for (const candidate of territory.writeCapabilities.deniedPaths) {
    const absolute = path.resolve(candidate);
    if (!pathInside(absolute, repository.workspaceRoot)) continue;
    if (
      pathInside(absolute, repository.gitEntry) ||
      pathInside(absolute, repository.gitDir) ||
      pathInside(absolute, repository.commonDir)
    ) {
      continue;
    }
    const relative = path.relative(repository.workspaceRoot, absolute);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      protectedPaths.push(relative.split(path.sep).join("/"));
    }
  }
  return [...new Set(protectedPaths)].sort();
}

interface CheckoutPreflight {
  readonly force: boolean;
  readonly orphan: boolean;
  readonly target: string | null;
  readonly pathspecs: readonly string[] | null;
}

function localCommandIndex(
  args: readonly string[],
  operation: ShadowGitLocalOperation,
): number {
  if (args.length === 0 || args.length > 1_024) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      `Git ${operation} arguments exceed the ZSR broker limit`,
    );
  }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === operation) return index;
    if (ALLOWED_SCOPED_GIT_GLOBAL_FLAGS.has(value)) continue;
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      `Git global option ${value} requires an explicit Zeros adapter for ${operation}`,
    );
  }
  throw new ShadowGitPromotionError(
    "invalid-shadow-repository",
    `The ZSR Git broker expected a direct ${operation} command`,
  );
}

function localCommandTail(
  args: readonly string[],
  operation: ShadowGitLocalOperation,
): readonly string[] {
  return args.slice(localCommandIndex(args, operation) + 1);
}

function checkoutPreflight(
  args: readonly string[],
  operation: ShadowGitLocalOperation,
): CheckoutPreflight {
  const commandIndex = localCommandIndex(args, operation);
  const positionals: string[] = [];
  let explicitPathspecs: string[] | null = null;
  let branchStart: string | null = null;
  let force = false;
  let orphan = false;
  let pathMode = false;

  const consumeValue = (index: number, option: string): string => {
    const value = args[index + 1];
    if (!value || value.includes("\0")) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git ${operation} option ${option} is missing its value`,
      );
    }
    return value;
  };

  for (let index = commandIndex + 1; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--") {
      explicitPathspecs = args.slice(index + 1);
      break;
    }
    if (value === "-") {
      positionals.push(value);
      continue;
    }
    if (
      ["-b", "-B", "-c", "-C", "--create", "--force-create"].includes(value)
    ) {
      branchStart = consumeValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--create=") || value.startsWith("--force-create=")) {
      branchStart = value.slice(value.indexOf("=") + 1);
      if (!branchStart) consumeValue(index, value);
      continue;
    }
    if (value === "--orphan") {
      orphan = true;
      branchStart = consumeValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--orphan=")) {
      orphan = true;
      branchStart = value.slice("--orphan=".length);
      continue;
    }
    if (value === "--conflict") {
      consumeValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--conflict=")) continue;
    if (
      value === "--pathspec-from-file" ||
      value.startsWith("--pathspec-from-file=") ||
      value === "--pathspec-file-nul"
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git ${operation} pathspec files require an explicit Zeros adapter`,
      );
    }
    if (["-f", "--force", "--discard-changes"].includes(value)) {
      force = true;
      continue;
    }
    if (["-p", "--patch", "--ours", "--theirs", "-2", "-3"].includes(value)) {
      pathMode = true;
      continue;
    }
    if (
      [
        "-q",
        "--quiet",
        "--progress",
        "--no-progress",
        "-m",
        "--merge",
        "-d",
        "--detach",
        "-t",
        "--track",
        "--no-track",
        "--guess",
        "--no-guess",
        "--overlay",
        "--no-overlay",
        "--overwrite-ignore",
        "--ignore-other-worktrees",
        "--ignore-skip-worktree-bits",
        "--recurse-submodules",
        "--no-recurse-submodules",
      ].includes(value) ||
      value.startsWith("--track=") ||
      value.startsWith("--recurse-submodules=")
    ) {
      continue;
    }
    if (value.startsWith("-")) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git ${operation} option ${value} requires an explicit Zeros adapter`,
      );
    }
    positionals.push(value);
  }

  if (operation === "switch" && (pathMode || explicitPathspecs)) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      "Git switch does not accept a path checkout",
    );
  }
  if (explicitPathspecs) {
    if (positionals.length > 1) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git ${operation} contains an ambiguous tree and path selection`,
      );
    }
    return {
      force,
      orphan,
      target: positionals[0] ?? null,
      pathspecs: explicitPathspecs,
    };
  }
  if (operation === "checkout" && (pathMode || positionals.length > 1)) {
    return {
      force,
      orphan,
      target: positionals.length > 1 ? positionals.shift()! : null,
      pathspecs: positionals,
    };
  }
  return {
    force,
    orphan,
    target: positionals[0] ?? (branchStart ? "HEAD" : null),
    pathspecs: null,
  };
}

async function directoryQuota(root: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Shadow Git state contains a symbolic link",
        );
      }
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Shadow Git state contains non-regular or aliased data",
        );
      }
      files += 1;
      bytes += metadata.size;
      if (
        files > MAX_PRIVATE_OBJECT_FILES ||
        bytes > MAX_PRIVATE_OBJECT_BYTES
      ) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Shadow Git state exceeds the ZSR promotion quota",
        );
      }
    }
  }
}

interface ValidatedLfsObject {
  readonly oid: string;
  readonly source: string;
  readonly size: number;
}

interface LinkedWorktreeCandidate {
  readonly metadataRoot: string;
  readonly worktreeRoot: string;
  readonly gitEntry: string;
  readonly gitEntryDigest: string;
  readonly headRaw: Buffer;
  readonly headRef: string | null;
  readonly headOid: string | null;
}

interface ShadowGitRecoveryPointer {
  readonly gitEntry: string;
  readonly sourceMetadata: string;
  readonly recoveryMetadata: string;
  readonly beforeDigest: string;
  readonly afterDigest: string;
}

interface ShadowGitRecoveryManifest {
  readonly version: typeof SHADOW_RECOVERY_VERSION;
  readonly recoveryId: string;
  readonly workspaceRoot: string;
  readonly workspaceHash: string;
  readonly generation: TerritoryGeneration;
  readonly createdAt: number;
  readonly reason: ShadowGitPromotionError["code"] | "promotion-failed";
  readonly sessionRoot: string;
  readonly sourceRoot: string;
  readonly recoveryGitRoot: string;
  readonly state:
    | "copying"
    | "ready"
    | "pointers-updating"
    | "finalized"
    | "manual";
  readonly completedPointers: number;
  readonly pointers: readonly ShadowGitRecoveryPointer[];
}

export interface ShadowGitRecoveryResult {
  readonly discovered: number;
  readonly recovered: number;
  readonly active: number;
  readonly preserved: number;
}

async function hashRegularFile(
  file: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ digest: string; size: number }> {
  assertCapabilityActive(signal);
  const handle = await open(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size < 0 ||
      metadata.size > maximumBytes
    ) {
      throw new ShadowGitPromotionError(
        metadata.size > maximumBytes
          ? "quota-exceeded"
          : "invalid-shadow-repository",
        "Private Git LFS contains non-regular, aliased, or oversized media",
      );
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      assertCapabilityActive(signal);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, metadata.size - position),
        position,
      );
      if (bytesRead <= 0) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Private Git LFS media changed while it was validated",
        );
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.ctimeMs !== metadata.ctimeMs ||
      after.nlink !== 1
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Private Git LFS media changed while it was validated",
      );
    }
    return { digest: digest.digest("hex"), size: metadata.size };
  } finally {
    await handle.close();
  }
}

async function physicalDirectory(
  root: string,
  segments: readonly string[],
): Promise<string> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(current);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      realpathSync(current) !== current
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Canonical Git LFS storage is not a physical directory",
      );
    }
  }
  return current;
}

async function validatePrivateLfsObjects(
  shadowRoot: string,
  signal?: AbortSignal,
): Promise<ValidatedLfsObject[]> {
  const objectRoot = path.join(shadowRoot, "lfs", "objects");
  let firstLevel;
  try {
    const metadata = await lstat(objectRoot);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      realpathSync(objectRoot) !== objectRoot
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Private Git LFS object storage is not a physical directory",
      );
    }
    firstLevel = await readdir(objectRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const objects: ValidatedLfsObject[] = [];
  let totalBytes = 0;
  for (const first of firstLevel) {
    assertCapabilityActive(signal);
    if (!first.isDirectory() || !/^[0-9a-f]{2}$/.test(first.name)) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Private Git LFS object storage has a malformed layout",
      );
    }
    const secondRoot = path.join(objectRoot, first.name);
    const secondLevel = await readdir(secondRoot, { withFileTypes: true });
    for (const second of secondLevel) {
      if (!second.isDirectory() || !/^[0-9a-f]{2}$/.test(second.name)) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Private Git LFS object storage has a malformed layout",
        );
      }
      const leafRoot = path.join(secondRoot, second.name);
      for (const leaf of await readdir(leafRoot, { withFileTypes: true })) {
        const oid = leaf.name;
        if (
          !leaf.isFile() ||
          !/^[0-9a-f]{64}$/.test(oid) ||
          !oid.startsWith(`${first.name}${second.name}`)
        ) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Private Git LFS object storage contains malformed or aliased media",
          );
        }
        const source = path.join(leafRoot, oid);
        const validated = await hashRegularFile(
          source,
          MAX_PRIVATE_LFS_BYTES,
          signal,
        );
        if (validated.digest !== oid) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Private Git LFS media does not match its content address",
          );
        }
        totalBytes += validated.size;
        objects.push({ oid, source, size: validated.size });
        if (
          objects.length > MAX_PRIVATE_LFS_FILES ||
          totalBytes > MAX_PRIVATE_LFS_BYTES
        ) {
          throw new ShadowGitPromotionError(
            "quota-exceeded",
            "Private Git LFS media exceeds the ZSR promotion quota",
          );
        }
      }
    }
  }
  return objects;
}

async function copyLfsObjectAtomically(
  object: ValidatedLfsObject,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const verifyExisting = async (): Promise<boolean> => {
    try {
      const existing = await hashRegularFile(destination, object.size, signal);
      if (existing.size !== object.size || existing.digest !== object.oid) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Canonical Git LFS contains a corrupt content-addressed object",
        );
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  if (await verifyExisting()) return;
  const temporary = `${destination}.zeros-${randomUUID()}.tmp`;
  const source = await open(
    object.source,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const target = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    const before = await source.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== object.size) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Private Git LFS media changed before promotion",
      );
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < object.size) {
      assertCapabilityActive(signal);
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, object.size - position),
        position,
      );
      if (bytesRead <= 0) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Private Git LFS media changed during promotion",
        );
      }
      digest.update(buffer.subarray(0, bytesRead));
      await target.write(buffer, 0, bytesRead, position);
      position += bytesRead;
    }
    const after = await source.stat();
    if (
      digest.digest("hex") !== object.oid ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.nlink !== 1
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Private Git LFS media changed during promotion",
      );
    }
    await target.sync();
  } finally {
    await Promise.allSettled([source.close(), target.close()]);
  }
  try {
    await link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await verifyExisting();
  } finally {
    await rm(temporary, { force: true });
  }
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

async function withCrossProcessPromotionLock<T>(
  repository: CanonicalGitRepository,
  operation: () => Promise<T>,
): Promise<T> {
  const root = promotionJournalRoot(repository);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const databasePath = path.join(root, "promotion-lock.sqlite");
  const seed = await open(databasePath, "a", 0o600);
  await seed.close();
  await chmod(databasePath, 0o600);
  const database = openSqlite(databasePath);
  let acquired = false;
  try {
    database.pragma("busy_timeout = 0");
    const deadline = Date.now() + PROMOTION_LOCK_WAIT_MS;
    for (;;) {
      try {
        database.exec("BEGIN IMMEDIATE");
        acquired = true;
        break;
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        if (Date.now() >= deadline) {
          throw new ShadowGitPromotionError(
            "concurrent-git-change",
            "Another Zeros process is still promoting Git state",
          );
        }
        await delay(25);
      }
    }
    try {
      const result = await operation();
      database.exec("COMMIT");
      acquired = false;
      return result;
    } catch (error) {
      if (acquired) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Closing the connection below releases the OS-backed SQLite lock.
        }
        acquired = false;
      }
      throw error;
    }
  } finally {
    database.close();
  }
}

async function withPromotionLock<T>(
  repository: CanonicalGitRepository,
  operation: () => Promise<T>,
): Promise<T> {
  const key = repository.commonDir;
  const previous = promotionTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  promotionTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await withCrossProcessPromotionLock(repository, operation);
  } finally {
    release();
    if (promotionTails.get(key) === tail) promotionTails.delete(key);
  }
}

function promotionWorkspaceHash(repository: CanonicalGitRepository): string {
  return createHash("sha256")
    .update(`${repository.workspaceRoot}\0${repository.commonDir}`)
    .digest("hex");
}

function promotionJournalRoot(repository: CanonicalGitRepository): string {
  return path.join(
    zerosDataDir(),
    "git-promotion-journal",
    promotionWorkspaceHash(repository),
  );
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
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

async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await syncDirectory(directory);
}

async function copyShadowRecoveryTree(
  source: string,
  destination: string,
): Promise<void> {
  const sourceMetadata = await lstat(source);
  if (
    !sourceMetadata.isDirectory() ||
    sourceMetadata.isSymbolicLink() ||
    realpathSync(source) !== source
  ) {
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      "Shadow Git recovery source is not a physical directory",
    );
  }
  await mkdir(destination, { mode: 0o700 });
  let files = 0;
  let bytes = 0;
  const pending: Array<{ source: string; destination: string; depth: number }> =
    [{ source, destination, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > 64) {
      throw new ShadowGitPromotionError(
        "quota-exceeded",
        "Shadow Git recovery state is too deeply nested",
      );
    }
    for (const entry of await readdir(current.source, {
      withFileTypes: true,
    })) {
      const sourceEntry = path.join(current.source, entry.name);
      const destinationEntry = path.join(current.destination, entry.name);
      const metadata = await lstat(sourceEntry);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        await mkdir(destinationEntry, { mode: 0o700 });
        pending.push({
          source: sourceEntry,
          destination: destinationEntry,
          depth: current.depth + 1,
        });
        continue;
      }
      files += 1;
      if (metadata.isSymbolicLink()) {
        const target = await readlink(sourceEntry);
        bytes += Buffer.byteLength(target);
        if (Buffer.byteLength(target) > 16 * 1024) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Shadow Git recovery contains an oversized symbolic link",
          );
        }
        await symlink(target, destinationEntry);
      } else if (metadata.isFile()) {
        bytes += metadata.size;
        await copyFile(
          sourceEntry,
          destinationEntry,
          fsConstants.COPYFILE_FICLONE,
        );
        await chmod(destinationEntry, metadata.mode & 0o777);
      } else {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Shadow Git recovery contains a special filesystem entry",
        );
      }
      if (files > MAX_RECOVERY_FILES || bytes > MAX_RECOVERY_BYTES) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Shadow Git recovery state exceeds the bounded preservation quota",
        );
      }
    }
  }
  // Child directories are synced before their parents so the ready manifest
  // is never published while a copied metadata name is only in page cache.
  const directories: string[] = [destination];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory())
        directories.push(path.join(directory, entry.name));
    }
  }
  for (const directory of directories.reverse()) await syncDirectory(directory);
}

function sessionRootForShadowRoot(shadowRoot: string): string {
  const generationRoot = path.dirname(shadowRoot);
  const boundaryRoot = path.dirname(generationRoot);
  const sessionRoot = path.dirname(boundaryRoot);
  const sessions = path.join(zerosDataDir(), "sessions");
  if (
    path.basename(shadowRoot) !== "git" ||
    path.basename(boundaryRoot) !== "boundary" ||
    !pathInside(sessionRoot, sessions) ||
    sessionRoot === sessions
  ) {
    throw new Error("Shadow Git recovery source is outside session state");
  }
  return sessionRoot;
}

async function writeRecoveryHold(
  sessionRoot: string,
  recoveryId: string,
  manifestPath: string,
): Promise<void> {
  await writeAtomicJson(path.join(sessionRoot, SHADOW_GIT_RECOVERY_HOLD_FILE), {
    version: SHADOW_RECOVERY_VERSION,
    recoveryId,
    manifestPath,
  });
}

async function removeRecoveryHold(
  sessionRoot: string,
  recoveryId: string,
): Promise<void> {
  const hold = path.join(sessionRoot, SHADOW_GIT_RECOVERY_HOLD_FILE);
  const value = await readBoundedRegularFile(hold, 16 * 1024);
  if (!value) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    return;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as { recoveryId?: unknown }).recoveryId === recoveryId
  ) {
    await rm(hold, { force: true });
    await syncDirectory(sessionRoot);
  }
}

async function writePromotionJournal(
  journalPath: string,
  journal: GitPromotionJournal,
): Promise<void> {
  const directory = path.dirname(journalPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(
    directory,
    `.${path.basename(journalPath)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporary, journalPath);
  await syncDirectory(directory);
}

async function removePromotionJournal(journalPath: string): Promise<void> {
  await rm(journalPath, { force: true });
  await syncDirectory(path.dirname(journalPath));
}

function stagedReplacementRecord(
  replacement: StagedReplacement,
): Omit<StagedReplacement, "commit" | "abort"> {
  return {
    changed: replacement.changed,
    target: replacement.target,
    lockPath: replacement.lockPath,
    temporaryPath: replacement.temporaryPath,
    expectedDigest: replacement.expectedDigest,
    candidateDigest: replacement.candidateDigest,
  };
}

async function stageReplacement(
  target: string,
  expectedDigest: string | null,
  candidate: Buffer | null,
  maximum: number,
  transactionId: string,
): Promise<StagedReplacement> {
  const current = await readBoundedRegularFile(target, maximum);
  if (digest(current) !== expectedDigest) {
    throw new ShadowGitPromotionError(
      "concurrent-git-change",
      "Canonical Git control state changed before promotion",
    );
  }
  if (digest(candidate) === digest(current)) {
    return {
      changed: false,
      target,
      lockPath: null,
      temporaryPath: null,
      expectedDigest,
      candidateDigest: digest(candidate),
      commit: async () => undefined,
      abort: async () => undefined,
    };
  }
  const lockPath = `${target}.lock`;
  const temporaryPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.zeros-${transactionId}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  try {
    if (candidate) await handle.writeFile(candidate);
    await handle.sync();
    await close();
    await link(temporaryPath, lockPath);
  } catch (error) {
    await close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new ShadowGitPromotionError(
      "concurrent-git-change",
      "Canonical Git control state is locked by another process",
    );
  }
  let finished = false;
  const assertOwnedLock = async () => {
    const [temporaryStat, lockStat] = await Promise.all([
      lstat(temporaryPath),
      lstat(lockPath),
    ]);
    if (
      !temporaryStat.isFile() ||
      !lockStat.isFile() ||
      temporaryStat.dev !== lockStat.dev ||
      temporaryStat.ino !== lockStat.ino
    ) {
      throw new ShadowGitPromotionError(
        "concurrent-git-change",
        "Canonical Git lock ownership changed during promotion",
      );
    }
  };
  return {
    changed: true,
    target,
    lockPath,
    temporaryPath,
    expectedDigest,
    candidateDigest: digest(candidate),
    commit: async () => {
      if (finished) return;
      const rechecked = await readBoundedRegularFile(target, maximum);
      if (digest(rechecked) === digest(candidate)) {
        try {
          await assertOwnedLock();
          await rm(lockPath, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rm(temporaryPath, { force: true });
        finished = true;
        return;
      }
      await assertOwnedLock();
      if (digest(rechecked) !== expectedDigest) {
        throw new ShadowGitPromotionError(
          "concurrent-git-change",
          "Canonical Git control state changed during promotion",
        );
      }
      if (candidate) await rename(lockPath, target);
      else {
        await rm(lockPath, { force: true });
        await rm(target, { force: true });
      }
      await rm(temporaryPath, { force: true });
      await syncDirectory(path.dirname(target));
      finished = true;
    },
    abort: async () => {
      if (finished) return;
      finished = true;
      try {
        await assertOwnedLock();
        await rm(lockPath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },
  };
}

export class ShadowGitSession {
  readonly env: Readonly<Record<string, string>>;
  private readonly emptyHooks: string;
  private readonly validatorGitDir: string;
  private readonly protectedPaths: readonly string[];
  private refs = new Map<string, string>();
  private symbolicRefs = new Map<string, string>();
  private headRef: string | null = null;
  private headOid: string | null = null;
  private canonicalHeadDigest: string | null = null;
  private canonicalIndexDigest: string | null = null;
  private admittedRemotes = new Map<string, AdmittedRemoteUrls>();
  private readonly stagedFetches = new Map<string, string>();
  private remoteBroker: ShadowGitRemoteBroker | null = null;
  private stopped = false;
  private readonly filesystemProjectionValue: ShadowGitFilesystemProjection;

  private constructor(private readonly options: ShadowGitOptions) {
    if (options.trustedSshCommandForTesting) {
      if (
        process.env.NODE_ENV !== "test" ||
        !path.isAbsolute(options.trustedSshCommandForTesting) ||
        options.trustedSshCommandForTesting.includes("\0")
      ) {
        throw new Error("trusted SSH test transport is invalid");
      }
    }
    this.emptyHooks = path.join(options.commandsRoot, "trusted-empty-hooks");
    this.validatorGitDir = path.join(options.commandsRoot, "validator.git");
    this.protectedPaths = relativeProtectedPaths(
      options.territory,
      options.repository,
    );
    const gitEntryStat = lstatSync(options.repository.gitEntry);
    if (gitEntryStat.isSymbolicLink()) {
      throw new Error("Git worktree metadata entry must not be a symlink");
    }
    if (gitEntryStat.isDirectory()) {
      this.filesystemProjectionValue = Object.freeze({
        source: options.shadowRoot,
        destination: options.repository.gitEntry,
        readOnly: false,
      });
    } else if (gitEntryStat.isFile()) {
      this.filesystemProjectionValue = Object.freeze({
        source: path.join(options.toolsRoot, "git-worktree-entry"),
        destination: options.repository.gitEntry,
        readOnly: true,
      });
    } else {
      throw new Error(
        "Git worktree metadata entry must be a regular file or directory",
      );
    }
    this.env = Object.freeze({
      GIT_DIR: options.shadowRoot,
      GIT_COMMON_DIR: options.shadowRoot,
      GIT_WORK_TREE: options.repository.workspaceRoot,
      GIT_INDEX_FILE: path.join(options.shadowRoot, "index"),
      GIT_OBJECT_DIRECTORY: path.join(options.shadowRoot, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: options.repository.objectDir,
      GIT_OPTIONAL_LOCKS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(options.privateHome, ".gitconfig"),
      GIT_ASKPASS: path.join(options.toolsRoot, "git-askpass-denied"),
    });
  }

  static async create(options: ShadowGitOptions): Promise<ShadowGitSession> {
    const session = new ShadowGitSession(options);
    const remoteBroker =
      options.remoteBroker ?? (await ShadowGitRemoteBroker.reserve());
    try {
      await session.initialize();
      await remoteBroker.activate({
        toolsRoot: options.toolsRoot,
        runtime: options.toolRuntime,
        gitBinary: options.repository.gitBinary,
        generation: options.generation,
        handleRemote: (operation, args, cwd, signal) =>
          session.handleBrokeredGitCommand(operation, args, cwd, signal),
        handleCleanup: (cleanupId) => session.cleanupStagedFetch(cleanupId),
        handleTransport: (remoteName, remoteUrl, socket, signal) =>
          session.handlePromisorTransport(
            remoteName,
            remoteUrl,
            socket,
            signal,
          ),
      });
      session.remoteBroker = remoteBroker;
      return session;
    } catch (error) {
      await remoteBroker.close().catch(() => undefined);
      await session.stop().catch(() => undefined);
      throw error;
    }
  }

  childEnvironment(pathValue: string | undefined): Record<string, string> {
    return {
      ...this.env,
      PATH: `${this.options.toolsRoot}${path.delimiter}${
        pathValue ?? "/usr/local/bin:/usr/bin:/bin"
      }`,
    };
  }

  /** Linux bwrap can preserve ordinary Git discovery by projecting this
   * private view onto the checkout's existing .git entry. The trusted ZSR
   * supervisor validates the exact pair again before granting the mount. */
  filesystemProjection(): ShadowGitFilesystemProjection {
    return this.filesystemProjectionValue;
  }

  private git(
    args: readonly string[],
    overrides: {
      gitDir?: string;
      indexFile?: string;
      input?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return runTrustedGit({
      repository: this.options.repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd: this.options.repository.workspaceRoot,
      args,
      gitDir: overrides.gitDir ?? this.options.shadowRoot,
      workTree: this.options.repository.workspaceRoot,
      indexFile:
        overrides.indexFile ?? path.join(this.options.shadowRoot, "index"),
      input: overrides.input,
      timeoutMs: overrides.timeoutMs,
      signal: overrides.signal,
    });
  }

  private async snapshotRefState(
    gitDir = this.options.shadowRoot,
    signal?: AbortSignal,
  ): Promise<RefSnapshot> {
    const { stdout } = await runTrustedGit({
      repository: this.options.repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd: this.options.repository.workspaceRoot,
      args: ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"],
      gitDir,
      workTree: this.options.repository.workspaceRoot,
      signal,
    });
    return parseRefSnapshot(
      stdout,
      this.options.repository.objectFormat === "sha1" ? 40 : 64,
    );
  }

  private async snapshotRefs(
    gitDir = this.options.shadowRoot,
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    return (await this.snapshotRefState(gitDir, signal)).refs;
  }

  private async importCanonicalReflogs(): Promise<void> {
    const repository = this.options.repository;
    const listed = await runTrustedGit({
      repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd: repository.workspaceRoot,
      args: ["--no-pager", "reflog", "list"],
      gitDir: repository.gitDir,
      workTree: repository.workspaceRoot,
    }).catch((error: unknown) => {
      const code = (error as { code?: unknown }).code;
      if (code === 1 || code === "1") return { stdout: "", stderr: "" };
      throw error;
    });
    const refs = [...new Set(listed.stdout.split(/\r?\n/).filter(Boolean))];
    if (refs.length > MAX_REFLOGS) {
      throw new ShadowGitPromotionError(
        "quota-exceeded",
        "Canonical Git contains too many reflogs for a bounded session view",
      );
    }
    let remainingEntries = MAX_REFLOG_ENTRIES;
    const width = repository.objectFormat === "sha1" ? 40 : 64;
    const zero = repository.objectFormat === "sha1" ? ZERO_SHA1 : ZERO_SHA256;
    const timestamp = Math.floor(Date.now() / 1_000);
    for (const ref of refs) {
      if (ref !== "HEAD" && !allowedPromotedRef(ref)) continue;
      if (remainingEntries <= 0) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Canonical Git reflogs exceed the session entry limit",
        );
      }
      const shown = await runTrustedGit({
        repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: repository.workspaceRoot,
        args: [
          "--no-pager",
          "reflog",
          "show",
          `--max-count=${remainingEntries + 1}`,
          "--format=%H%x09%gs",
          ref,
        ],
        gitDir: repository.gitDir,
        workTree: repository.workspaceRoot,
      });
      const entries = shown.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("\t");
          const oid = separator >= 0 ? line.slice(0, separator) : line;
          const message = separator >= 0 ? line.slice(separator + 1) : "";
          if (!new RegExp(`^[0-9a-f]{${width}}$`).test(oid)) {
            throw new ShadowGitPromotionError(
              "invalid-shadow-repository",
              `Canonical Git reflog ${ref} contains an invalid object id`,
            );
          }
          return {
            oid,
            message: message.replaceAll(/[\0\r\n\t]/g, " ").slice(0, 4_096),
          };
        });
      if (entries.length > remainingEntries) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Canonical Git reflogs exceed the session entry limit",
        );
      }
      remainingEntries -= entries.length;
      if (entries.length === 0) continue;
      const expected =
        ref === "HEAD" ? this.headOid : (this.refs.get(ref) ?? null);
      if (!expected || entries[0]!.oid !== expected) {
        const symbolicTarget = this.symbolicRefs.get(ref);
        let admittedTrailingSymbolicReflog = false;
        if (expected && symbolicTarget) {
          const current = await this.snapshotRefState(repository.gitDir);
          admittedTrailingSymbolicReflog =
            current.refs.get(ref) === expected &&
            current.symbolicRefs.get(ref) === symbolicTarget;
        }
        if (!admittedTrailingSymbolicReflog) {
          throw new ShadowGitPromotionError(
            "concurrent-git-change",
            `Canonical Git reflog ${ref} changed during session admission`,
          );
        }
        // A symbolic ref's own reflog records changes to the symbolic pointer,
        // not updates to its target. `origin/HEAD` therefore commonly trails
        // `origin/main`. Re-attest both the resolved OID and pointer ownership,
        // then preserve that canonical trailing reflog in the private view.
      }
      let oldOid = zero;
      const records: string[] = [];
      for (const entry of [...entries].reverse()) {
        records.push(
          `${oldOid} ${entry.oid} Zeros Sandbox <sandbox@zeros.invalid> ${timestamp} +0000\t${entry.message || "session snapshot"}\n`,
        );
        oldOid = entry.oid;
      }
      const relative = ref === "HEAD" ? "HEAD" : ref;
      const destination = path.join(this.options.shadowRoot, "logs", relative);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, records.join(""), {
        encoding: "utf8",
        mode: 0o600,
        flag: "w",
      });
    }
  }

  private async readHead(
    gitDir = this.options.shadowRoot,
    signal?: AbortSignal,
  ): Promise<{
    ref: string | null;
    oid: string | null;
  }> {
    let ref: string | null = null;
    try {
      ref = (
        await runTrustedGit({
          repository: this.options.repository,
          privateHome: this.options.privateHome,
          emptyHooks: this.emptyHooks,
          cwd: this.options.repository.workspaceRoot,
          args: ["symbolic-ref", "-q", "HEAD"],
          gitDir,
          workTree: this.options.repository.workspaceRoot,
          signal,
        })
      ).stdout.trim();
    } catch (error) {
      if (signal?.aborted) throw error;
      // Detached or unborn HEAD.
    }
    let oid: string | null = null;
    try {
      oid = (
        await runTrustedGit({
          repository: this.options.repository,
          privateHome: this.options.privateHome,
          emptyHooks: this.emptyHooks,
          cwd: this.options.repository.workspaceRoot,
          args: ["rev-parse", "--verify", "HEAD"],
          gitDir,
          workTree: this.options.repository.workspaceRoot,
          signal,
        })
      ).stdout.trim();
    } catch (error) {
      if (signal?.aborted) throw error;
      // Unborn HEAD.
    }
    return { ref, oid };
  }

  private validatePromotionJournal(
    value: unknown,
    journalPath: string,
  ): GitPromotionJournal {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git promotion recovery journal is invalid",
      );
    }
    const journal = value as Partial<GitPromotionJournal>;
    if (
      journal.version !== 1 ||
      typeof journal.transactionId !== "string" ||
      !UUID_V4_PATTERN.test(journal.transactionId) ||
      journal.workspaceHash !==
        promotionWorkspaceHash(this.options.repository) ||
      typeof journal.generation !== "string" ||
      !UUID_V4_PATTERN.test(journal.generation) ||
      path.basename(journalPath) !== `${journal.transactionId}.json` ||
      !["prepared", "refs-committed", "head-committed"].includes(
        journal.state ?? "",
      ) ||
      !Array.isArray(journal.refs) ||
      journal.refs.length > MAX_REFS
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git promotion recovery journal ${path.basename(journalPath)} is invalid`,
      );
    }
    const oidLength = this.options.repository.objectFormat === "sha1" ? 40 : 64;
    const validOid = (oid: unknown) =>
      oid === null ||
      (typeof oid === "string" &&
        new RegExp(`^[0-9a-f]{${oidLength}}$`).test(oid));
    const seenRefs = new Set<string>();
    for (const ref of journal.refs) {
      if (
        !ref ||
        typeof ref.name !== "string" ||
        !allowedPromotedRef(ref.name) ||
        !validOid(ref.before) ||
        !validOid(ref.after) ||
        ref.before === ref.after ||
        seenRefs.has(ref.name)
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git promotion recovery journal contains an invalid ref transition",
        );
      }
      seenRefs.add(ref.name);
    }
    const expectedTargets = new Map([
      ["head", path.join(this.options.repository.gitDir, "HEAD")],
      ["index", this.options.repository.indexPath],
    ]);
    for (const [kind, replacement] of [
      ["head", journal.head],
      ["index", journal.index],
    ] as const) {
      const expectedTarget = expectedTargets.get(kind)!;
      if (
        !replacement ||
        typeof replacement.changed !== "boolean" ||
        replacement.target !== expectedTarget ||
        !validDigest(replacement.expectedDigest) ||
        !validDigest(replacement.candidateDigest) ||
        (replacement.changed
          ? replacement.expectedDigest === replacement.candidateDigest
          : replacement.expectedDigest !== replacement.candidateDigest)
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git promotion recovery journal contains an invalid replacement",
        );
      }
      if (!replacement.changed) {
        if (
          replacement.lockPath !== null ||
          replacement.temporaryPath !== null
        ) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Unchanged Git recovery state unexpectedly owns a lock",
          );
        }
        continue;
      }
      const expectedLock = `${expectedTarget}.lock`;
      const expectedTemporary = path.join(
        path.dirname(expectedTarget),
        `.${path.basename(expectedTarget)}.zeros-${journal.transactionId}.tmp`,
      );
      if (
        replacement.lockPath !== expectedLock ||
        replacement.temporaryPath !== expectedTemporary
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git promotion recovery journal points outside its canonical lock",
        );
      }
    }
    return journal as GitPromotionJournal;
  }

  private async replacementOwnsLock(
    replacement: Omit<StagedReplacement, "commit" | "abort">,
  ): Promise<boolean> {
    if (
      !replacement.changed ||
      !replacement.lockPath ||
      !replacement.temporaryPath
    ) {
      return false;
    }
    try {
      const [lockStat, temporaryStat] = await Promise.all([
        lstat(replacement.lockPath),
        lstat(replacement.temporaryPath),
      ]);
      return (
        lockStat.isFile() &&
        temporaryStat.isFile() &&
        lockStat.dev === temporaryStat.dev &&
        lockStat.ino === temporaryStat.ino
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async abortJournalReplacement(
    replacement: Omit<StagedReplacement, "commit" | "abort">,
  ): Promise<void> {
    if (!replacement.changed || !replacement.temporaryPath) return;
    if (await this.replacementOwnsLock(replacement)) {
      await rm(replacement.lockPath!, { force: true });
    }
    await rm(replacement.temporaryPath, { force: true });
  }

  private async commitJournalReplacement(
    replacement: Omit<StagedReplacement, "commit" | "abort">,
    maximum: number,
  ): Promise<void> {
    if (
      !replacement.changed ||
      !replacement.temporaryPath ||
      !replacement.lockPath
    ) {
      return;
    }
    const currentDigest = digest(
      await readBoundedRegularFile(replacement.target, maximum),
    );
    if (currentDigest === replacement.candidateDigest) {
      if (await this.replacementOwnsLock(replacement)) {
        await rm(replacement.lockPath, { force: true });
      }
      await rm(replacement.temporaryPath, { force: true });
      return;
    }
    if (currentDigest !== replacement.expectedDigest) {
      throw new ShadowGitPromotionError(
        "concurrent-git-change",
        "Canonical Git control state diverged during journal recovery",
      );
    }
    if (!(await this.replacementOwnsLock(replacement))) {
      throw new ShadowGitPromotionError(
        "concurrent-git-change",
        "Canonical Git promotion lock is missing or belongs to another process",
      );
    }
    const staged = await readBoundedRegularFile(
      replacement.temporaryPath,
      maximum,
    );
    if (
      replacement.candidateDigest === null
        ? !staged || staged.length !== 0
        : digest(staged) !== replacement.candidateDigest
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Canonical Git promotion lock content is invalid",
      );
    }
    if (replacement.candidateDigest === null) {
      await rm(replacement.lockPath, { force: true });
      await rm(replacement.target, { force: true });
    } else {
      await rename(replacement.lockPath, replacement.target);
    }
    await rm(replacement.temporaryPath, { force: true });
    await syncDirectory(path.dirname(replacement.target));
  }

  private async recoverPromotionJournal(
    journalPath: string,
    journal: GitPromotionJournal,
  ): Promise<void> {
    const canonicalRefs = await this.snapshotRefs(
      this.options.repository.gitDir,
    );
    const allBefore = journal.refs.every(
      (entry) => (canonicalRefs.get(entry.name) ?? null) === entry.before,
    );
    const allAfter = journal.refs.every(
      (entry) => (canonicalRefs.get(entry.name) ?? null) === entry.after,
    );
    if (journal.state === "prepared" && allBefore) {
      await Promise.all([
        this.abortJournalReplacement(journal.head),
        this.abortJournalReplacement(journal.index),
      ]);
      await removePromotionJournal(journalPath);
      return;
    }
    if (!allAfter) {
      throw new ShadowGitPromotionError(
        "concurrent-git-change",
        "Canonical Git refs diverged during promotion journal recovery",
      );
    }
    await this.commitJournalReplacement(journal.head, 4096);
    const headCommitted = { ...journal, state: "head-committed" as const };
    await writePromotionJournal(journalPath, headCommitted);
    await this.commitJournalReplacement(journal.index, MAX_INDEX_BYTES);
    await removePromotionJournal(journalPath);
  }

  private async cleanupOrphanedPromotionFiles(
    journalTransactions: ReadonlySet<string>,
  ): Promise<void> {
    const targets = [
      path.join(this.options.repository.gitDir, "HEAD"),
      this.options.repository.indexPath,
    ];
    for (const target of new Set(targets)) {
      const directory = path.dirname(target);
      const base = path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`^\\.${base}\\.zeros-([0-9a-f-]{36})\\.tmp$`);
      let changed = false;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const match = pattern.exec(entry.name);
        if (!match || !UUID_V4_PATTERN.test(match[1]!)) continue;
        if (journalTransactions.has(match[1]!)) continue;
        const temporaryPath = path.join(directory, entry.name);
        const temporaryStat = await lstat(temporaryPath);
        if (
          !entry.isFile() ||
          !temporaryStat.isFile() ||
          temporaryStat.nlink < 1 ||
          temporaryStat.nlink > 2 ||
          (temporaryStat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" &&
            temporaryStat.uid !== process.getuid())
        ) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Orphaned Git promotion state has unsafe filesystem metadata",
          );
        }
        const lockPath = `${target}.lock`;
        let ownsLock = false;
        try {
          const lockStat = await lstat(lockPath);
          ownsLock =
            lockStat.isFile() &&
            lockStat.dev === temporaryStat.dev &&
            lockStat.ino === temporaryStat.ino;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (ownsLock) {
          await rm(lockPath, { force: true });
          changed = true;
        } else if (temporaryStat.nlink !== 1) {
          throw new ShadowGitPromotionError(
            "concurrent-git-change",
            "An orphaned Git promotion file has an unrecognized hard link",
          );
        }
        await rm(temporaryPath, { force: true });
        changed = true;
      }
      if (changed) await syncDirectory(directory);
    }
  }

  private async cleanupJournalWriteTemporaries(root: string): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true });
    const temporaries = entries.filter((entry) => {
      const match = /^\.([0-9a-f-]{36})\.json\.([0-9a-f-]{36})\.tmp$/.exec(
        entry.name,
      );
      return Boolean(
        match &&
        UUID_V4_PATTERN.test(match[1]!) &&
        UUID_V4_PATTERN.test(match[2]!),
      );
    });
    if (temporaries.length > 32) {
      throw new ShadowGitPromotionError(
        "quota-exceeded",
        "Too many interrupted Git promotion journal writes",
      );
    }
    let changed = false;
    for (const entry of temporaries) {
      const file = path.join(root, entry.name);
      const metadata = await lstat(file);
      if (
        !entry.isFile() ||
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.size > 1024 * 1024 ||
        (metadata.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" &&
          metadata.uid !== process.getuid())
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Interrupted Git promotion journal has unsafe filesystem metadata",
        );
      }
      await rm(file, { force: true });
      changed = true;
    }
    if (changed) await syncDirectory(root);
  }

  private async recoverPendingPromotions(): Promise<void> {
    const root = promotionJournalRoot(this.options.repository);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const journals = entries.filter((entry) =>
      UUID_V4_PATTERN.test(entry.name.replace(/\.json$/, "")) &&
      entry.name.endsWith(".json")
        ? true
        : false,
    );
    const malformedJournal = entries.find(
      (entry) => entry.name.endsWith(".json") && !journals.includes(entry),
    );
    if (malformedJournal) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git promotion recovery directory contains an invalid journal name",
      );
    }
    if (journals.length > 16) {
      throw new ShadowGitPromotionError(
        "quota-exceeded",
        "Too many pending Git promotion recovery journals",
      );
    }
    const journalTransactions = new Set(
      journals.map((entry) => entry.name.slice(0, -".json".length)),
    );
    await this.cleanupOrphanedPromotionFiles(journalTransactions);
    for (const entry of journals.sort((a, b) => a.name.localeCompare(b.name))) {
      const journalPath = path.join(root, entry.name);
      const metadata = await lstat(journalPath);
      if (
        !entry.isFile() ||
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" &&
          metadata.uid !== process.getuid())
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git promotion recovery journal has unsafe filesystem metadata",
        );
      }
      const bytes = await readBoundedRegularFile(journalPath, 1024 * 1024);
      if (!bytes) continue;
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git promotion recovery journal is malformed",
        );
      }
      await this.recoverPromotionJournal(
        journalPath,
        this.validatePromotionJournal(value, journalPath),
      );
    }
    await this.cleanupJournalWriteTemporaries(root);
  }

  private async initialize(): Promise<void> {
    const repository = this.options.repository;
    await Promise.all([
      mkdir(this.emptyHooks, { recursive: true, mode: 0o700 }),
      mkdir(this.options.privateHome, { recursive: true, mode: 0o700 }),
      mkdir(this.options.toolsRoot, { recursive: true, mode: 0o700 }),
    ]);
    await chmod(this.emptyHooks, 0o700);
    await withPromotionLock(this.options.repository, () =>
      this.recoverPendingPromotions(),
    );
    await Promise.all([
      writeFile(
        path.join(this.options.toolsRoot, "git-askpass-denied"),
        '#!/bin/sh\nprintf "%s\\n" "Git credentials are available only through the Zeros remote broker." >&2\nexit 1\n',
        { encoding: "utf8", mode: 0o500, flag: "wx" },
      ),
      ...(this.filesystemProjectionValue.readOnly
        ? [
            writeFile(
              this.filesystemProjectionValue.source,
              `gitdir: ${this.options.shadowRoot}\n`,
              { encoding: "utf8", mode: 0o400, flag: "wx" },
            ),
          ]
        : []),
    ]);
    const globalConfig = await readAmbientGlobalConfig(
      repository,
      this.options.privateHome,
    );
    await writeSanitizedConfig({
      repository,
      privateHome: this.options.privateHome,
      destination: path.join(this.options.privateHome, ".gitconfig"),
      entries: globalConfig,
    });
    const initArgs = ["init", "--bare"];
    if (repository.objectFormat === "sha256") {
      initArgs.push("--object-format=sha256");
    }
    initArgs.push(this.options.shadowRoot);
    const validatorInitArgs = ["init", "--bare"];
    if (repository.objectFormat === "sha256") {
      validatorInitArgs.push("--object-format=sha256");
    }
    validatorInitArgs.push(this.validatorGitDir);
    await runTrustedGit({
      repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd: repository.workspaceRoot,
      args: initArgs,
    });
    await chmod(this.options.shadowRoot, 0o700);

    const canonicalConfig = await runTrustedGit({
      repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd: repository.workspaceRoot,
      args: ["config", "--local", "--no-includes", "--null", "--list"],
      gitDir: repository.gitDir,
      workTree: repository.workspaceRoot,
    });
    const canonicalConfigEntries = parseConfigList(canonicalConfig.stdout);
    this.admittedRemotes = admittedRemoteUrls(canonicalConfigEntries);
    const promisorRemotes = promisorTransports(
      canonicalConfigEntries,
      this.admittedRemotes,
    );
    const shadowConfigPath = path.join(this.options.shadowRoot, "config");
    const initializedConfig = parseConfigList(
      (
        await this.git([
          "config",
          "--local",
          "--no-includes",
          "--null",
          "--list",
        ])
      ).stdout,
    );
    await writeSanitizedConfig({
      repository,
      privateHome: this.options.privateHome,
      destination: shadowConfigPath,
      entries: [...initializedConfig, ...canonicalConfigEntries],
    });
    for (const [key, value] of [
      ["core.bare", "false"],
      ["core.worktree", repository.workspaceRoot],
      ["core.logAllRefUpdates", "true"],
      ["extensions.worktreeConfig", "false"],
    ] as const) {
      await this.git([
        "config",
        "--local",
        "--no-includes",
        "--replace-all",
        key,
        value,
      ]);
    }
    for (const [name] of promisorRemotes) {
      await this.git([
        "config",
        "--local",
        "--replace-all",
        `remote.${name}.vcs`,
        "zeros-zsr",
      ]);
    }
    // Credentials and host execution programs are brokered separately. The
    // repository's hooks/filters remain available and execute only inside ZSR.
    await this.git([
      "config",
      "--local",
      "--no-includes",
      "--unset-all",
      "credential.helper",
    ]).catch(() => undefined);

    const alternates = path.join(
      this.options.shadowRoot,
      "objects",
      "info",
      "alternates",
    );
    await mkdir(path.dirname(alternates), { recursive: true, mode: 0o700 });
    if (/\r|\n|\0/.test(repository.objectDir)) {
      throw new Error("Git object directory contains an unsupported newline");
    }
    await writeFile(alternates, `${repository.objectDir}\n`, {
      mode: 0o600,
      flag: "w",
    });

    const canonicalRefState = await this.snapshotRefState(repository.gitDir);
    this.refs = canonicalRefState.refs;
    this.symbolicRefs = canonicalRefState.symbolicRefs;
    const zero = repository.objectFormat === "sha1" ? ZERO_SHA1 : ZERO_SHA256;
    if (this.refs.size > 0) {
      const commands = [
        "start",
        ...[...this.refs].map(([ref, oid]) => `update ${ref} ${oid} ${zero}`),
        "prepare",
        "commit",
        "",
      ].join("\n");
      await this.git(["update-ref", "--stdin"], { input: commands });
    }
    for (const [ref, target] of this.symbolicRefs) {
      await this.git(["symbolic-ref", ref, target]);
    }
    const canonicalHead = await this.readHead(repository.gitDir);
    this.canonicalHeadDigest = digest(
      await readBoundedRegularFile(path.join(repository.gitDir, "HEAD"), 4096),
    );
    this.headRef = canonicalHead.ref;
    this.headOid = canonicalHead.oid;
    if (canonicalHead.ref) {
      await this.git(["symbolic-ref", "HEAD", canonicalHead.ref]);
    } else if (canonicalHead.oid) {
      await this.git(["update-ref", "--no-deref", "HEAD", canonicalHead.oid]);
    }
    await this.importCanonicalReflogs();

    const shadowIndex = path.join(this.options.shadowRoot, "index");
    const canonicalIndex = await readBoundedRegularFile(
      repository.indexPath,
      MAX_INDEX_BYTES,
    );
    this.canonicalIndexDigest = digest(canonicalIndex);
    if (canonicalIndex) {
      await writeFile(shadowIndex, canonicalIndex, { mode: 0o600, flag: "wx" });
      const parent = path.dirname(repository.indexPath);
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith("sharedindex.")) continue;
        await copyRegularFileIfPresent(
          path.join(parent, entry.name),
          path.join(this.options.shadowRoot, entry.name),
        );
      }
    } else if (canonicalHead.oid) {
      await this.git(["read-tree", canonicalHead.oid]);
    }
    await copySelectedGitState(repository.gitDir, this.options.shadowRoot);
    await copyContainedHooks(
      path.join(repository.commonDir, "hooks"),
      path.join(this.options.shadowRoot, "hooks"),
    );

    await runTrustedGit({
      repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd: repository.workspaceRoot,
      args: validatorInitArgs,
    });
    const validatorAlternates = path.join(
      this.validatorGitDir,
      "objects",
      "info",
      "alternates",
    );
    await mkdir(path.dirname(validatorAlternates), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      validatorAlternates,
      `${path.join(this.options.shadowRoot, "objects")}\n${repository.objectDir}\n`,
      { mode: 0o600 },
    );
  }

  private async protectedSnapshot(
    gitDir: string,
    revision: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.protectedPaths.length === 0) return "";
    try {
      const { stdout } = await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: this.options.repository.workspaceRoot,
        args: ["ls-tree", "-z", revision, "--", ...this.protectedPaths],
        gitDir,
        workTree: this.options.repository.workspaceRoot,
        signal,
      });
      return createHash("sha256").update(stdout).digest("hex");
    } catch (error) {
      if (signal?.aborted) throw error;
      return "<unresolvable>";
    }
  }

  private async protectedIndexSnapshot(
    gitDir: string,
    indexFile: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.protectedPaths.length === 0) return "";
    const { stdout } = await runTrustedGit({
      repository: this.options.repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd: this.options.repository.workspaceRoot,
      args: ["ls-files", "--stage", "-z", "--", ...this.protectedPaths],
      gitDir,
      workTree: this.options.repository.workspaceRoot,
      indexFile,
      signal,
    });
    return createHash("sha256").update(stdout).digest("hex");
  }

  private async peelCommit(
    gitDir: string,
    oid: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    try {
      const commit = (
        await runTrustedGit({
          repository: this.options.repository,
          privateHome: this.options.privateHome,
          emptyHooks: this.emptyHooks,
          cwd: this.options.repository.workspaceRoot,
          args: ["rev-parse", "--verify", `${oid}^{commit}`],
          gitDir,
          workTree: this.options.repository.workspaceRoot,
          signal,
        })
      ).stdout.trim();
      const width = this.options.repository.objectFormat === "sha1" ? 40 : 64;
      return new RegExp(`^[0-9a-f]{${width}}$`).test(commit) ? commit : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  private async validateDesign(
    changedRefs: ReadonlyArray<readonly [string, string | null, string | null]>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.protectedPaths.length === 0) return;
    const baseHead = this.headOid;
    for (const [ref, oldOid, newOid] of changedRefs) {
      if (
        !newOid ||
        (!ref.startsWith("refs/heads/") &&
          !ref.startsWith("refs/tags/") &&
          ref !== "refs/stash")
      ) {
        continue;
      }
      const candidate = await this.peelCommit(
        this.validatorGitDir,
        newOid,
        signal,
      );
      if (!candidate) {
        if (ref.startsWith("refs/heads/") || ref === "refs/stash") {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            `Shadow Git ${ref} does not resolve to a commit`,
          );
        }
        // Git permits tags of blobs and trees. They cannot carry a checkout
        // Design tree, so object/connectivity validation is sufficient.
        continue;
      }
      const expected = oldOid
        ? await this.peelCommit(this.validatorGitDir, oldOid, signal)
        : baseHead;
      if (!expected) continue;
      const [before, after] = await Promise.all([
        this.protectedSnapshot(this.validatorGitDir, expected, signal),
        this.protectedSnapshot(this.validatorGitDir, candidate, signal),
      ]);
      if (before !== after) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "The Git operation changes protected Design or repository policy state",
        );
      }
    }
    const shadowIndex = path.join(this.options.shadowRoot, "index");
    if (!existsSync(shadowIndex)) return;
    const [canonical, candidate] = await Promise.all([
      this.protectedIndexSnapshot(
        this.options.repository.gitDir,
        this.options.repository.indexPath,
        signal,
      ),
      this.protectedIndexSnapshot(this.options.shadowRoot, shadowIndex, signal),
    ]);
    if (canonical !== candidate) {
      throw new ShadowGitPromotionError(
        "design-impact",
        "The private Git index stages a protected Design or policy path",
      );
    }
  }

  private async validateHeadTransition(
    candidateHead: {
      ref: string | null;
      oid: string | null;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      candidateHead.ref === this.headRef &&
      candidateHead.oid === this.headOid
    ) {
      return;
    }
    if (
      !candidateHead.ref ||
      !candidateHead.ref.startsWith("refs/heads/") ||
      !candidateHead.oid
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Detached or unborn checkout transitions require an explicit repository-sync operation",
      );
    }
    if (this.headOid && this.protectedPaths.length > 0) {
      const [before, after] = await Promise.all([
        this.protectedSnapshot(
          this.options.repository.gitDir,
          this.headOid,
          signal,
        ),
        this.protectedSnapshot(this.validatorGitDir, candidateHead.oid, signal),
      ]);
      if (before !== after) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "The checkout transition would change protected Design or policy state",
        );
      }
    }
  }

  private async validateObjects(
    newOids: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (newOids.length === 0) return;
    await directoryQuota(path.join(this.options.shadowRoot, "objects"));
    await runTrustedGit({
      repository: this.options.repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd: this.options.repository.workspaceRoot,
      args: ["fsck", "--strict", "--no-reflogs", "--no-dangling", ...newOids],
      gitDir: this.validatorGitDir,
      timeoutMs: 120_000,
      signal,
    });
  }

  private async importObjects(
    changedRefs: ReadonlyArray<readonly [string, string | null, string | null]>,
    signal?: AbortSignal,
  ): Promise<void> {
    const sourceOids = [
      ...new Set(
        changedRefs.flatMap(([, , newOid]) => (newOid ? [newOid] : [])),
      ),
    ];
    if (sourceOids.length === 0) return;
    const missing: string[] = [];
    for (const [, , oid] of changedRefs) {
      if (!oid) continue;
      try {
        await runTrustedGit({
          repository: this.options.repository,
          privateHome: this.options.privateHome,
          emptyHooks: this.emptyHooks,
          cwd: this.options.repository.workspaceRoot,
          args: ["cat-file", "-e", `${oid}^{object}`],
          gitDir: this.options.repository.gitDir,
          signal,
        });
      } catch {
        if (signal?.aborted) throw signal.reason;
        missing.push(oid);
      }
    }
    if (missing.length === 0) return;

    // A bundle is an immutable, self-checking transfer. Creation reads only
    // the private repository and `unbundle` imports objects without advancing
    // a canonical ref or invoking repository hooks. Excluding all admission
    // tips prevents a one-commit ChangeSet from copying the entire history.
    const bundle = path.join(
      this.options.commandsRoot,
      `import-${this.options.generation}.bundle`,
    );
    const importPrefix = `refs/zeros/import/${this.options.generation}`;
    const importRefs = [...new Set(missing)].map(
      (oid, index) => [`${importPrefix}/candidate/${index}`, oid] as const,
    );
    const baseRefs = [...new Set(this.refs.values())].map(
      (oid, index) => [`${importPrefix}/base/${index}`, oid] as const,
    );
    const temporaryRefs = [...importRefs, ...baseRefs];
    const updateCommands = [
      "start",
      ...temporaryRefs.map(([ref, oid]) => `create ${ref} ${oid}`),
      "prepare",
      "commit",
      "",
    ].join("\n");
    const revisions = [
      ...importRefs.map(([ref]) => ref),
      ...baseRefs.map(([ref]) => `^${ref}`),
      "",
    ].join("\n");
    try {
      await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: this.options.repository.workspaceRoot,
        args: ["update-ref", "--stdin"],
        gitDir: this.validatorGitDir,
        input: updateCommands,
        signal,
      });
      await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: this.options.repository.workspaceRoot,
        args: ["bundle", "create", bundle, "--stdin"],
        gitDir: this.validatorGitDir,
        input: revisions,
        signal,
      });
      const bundleStat = await lstat(bundle);
      if (
        !bundleStat.isFile() ||
        bundleStat.isSymbolicLink() ||
        bundleStat.nlink !== 1 ||
        bundleStat.size > MAX_PRIVATE_OBJECT_BYTES
      ) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Shadow Git object bundle exceeds the ZSR promotion quota",
        );
      }
      await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: this.options.repository.workspaceRoot,
        args: ["bundle", "unbundle", bundle],
        gitDir: this.options.repository.gitDir,
        workTree: this.options.repository.workspaceRoot,
        timeoutMs: 120_000,
        signal,
      });
    } finally {
      if (temporaryRefs.length > 0) {
        const deleteCommands = [
          "start",
          ...temporaryRefs.map(([ref]) => `delete ${ref}`),
          "prepare",
          "commit",
          "",
        ].join("\n");
        await runTrustedGit({
          repository: this.options.repository,
          privateHome: this.options.privateHome,
          emptyHooks: this.emptyHooks,
          cwd: this.options.repository.workspaceRoot,
          args: ["update-ref", "--stdin"],
          gitDir: this.validatorGitDir,
          input: deleteCommands,
        }).catch(() => undefined);
      }
      await rm(bundle, { force: true }).catch(() => undefined);
    }
  }

  /** Promote only verified content-addressed LFS media. Git refs still remain
   * the transaction commit point: an interrupted or losing CAS may leave an
   * unreachable immutable LFS object, which is safe and can be pruned by the
   * normal LFS lifecycle; it can never leave a ref pointing at missing media. */
  private async promoteLfsObjects(signal?: AbortSignal): Promise<void> {
    const objects = await validatePrivateLfsObjects(
      this.options.shadowRoot,
      signal,
    );
    if (objects.length === 0) return;
    const canonicalObjects = await physicalDirectory(
      this.options.repository.commonDir,
      ["lfs", "objects"],
    );
    for (const object of objects) {
      assertCapabilityActive(signal);
      const directory = await physicalDirectory(canonicalObjects, [
        object.oid.slice(0, 2),
        object.oid.slice(2, 4),
      ]);
      await copyLfsObjectAtomically(
        object,
        path.join(directory, object.oid),
        signal,
      );
    }
  }

  private async updateCanonicalRefs(
    changedRefs: ReadonlyArray<readonly [string, string | null, string | null]>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (changedRefs.length === 0) return;
    // This is the promotion commit point. Check revocation immediately before
    // starting, then let Git's reference transaction finish atomically; killing
    // it between prepare/commit could leave the journal unable to distinguish
    // an aborted transaction from a committed one.
    assertCapabilityActive(signal);
    const zero =
      this.options.repository.objectFormat === "sha1" ? ZERO_SHA1 : ZERO_SHA256;
    const commands = ["start"];
    for (const [ref, oldOid, newOid] of changedRefs) {
      if (!allowedPromotedRef(ref)) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Shadow Git attempted to update unsupported ref ${ref}`,
        );
      }
      if (newOid) commands.push(`update ${ref} ${newOid} ${oldOid ?? zero}`);
      else if (oldOid) commands.push(`delete ${ref} ${oldOid}`);
    }
    commands.push("prepare", "commit", "");
    try {
      await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: this.options.repository.workspaceRoot,
        args: ["update-ref", "--stdin"],
        gitDir: this.options.repository.gitDir,
        workTree: this.options.repository.workspaceRoot,
        input: commands.join("\n"),
      });
    } catch (error) {
      const stderr = String(
        (error as { stderr?: unknown; cause?: { stderr?: unknown } }).stderr ??
          "",
      )
        .trim()
        .slice(0, 500);
      throw new ShadowGitPromotionError(
        "concurrent-git-change",
        `Canonical Git refs changed while the agent ChangeSet was promoted${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }
  }

  private async stageIndex(transactionId: string): Promise<StagedReplacement> {
    const shadowIndexPath = path.join(this.options.shadowRoot, "index");
    const shadowIndex = await readBoundedRegularFile(
      shadowIndexPath,
      MAX_INDEX_BYTES,
    );
    return stageReplacement(
      this.options.repository.indexPath,
      this.canonicalIndexDigest,
      shadowIndex,
      MAX_INDEX_BYTES,
      transactionId,
    );
  }

  private async configValue(key: string): Promise<string | null> {
    try {
      return (
        (
          await this.git(["config", "--local", "--no-includes", "--get", key])
        ).stdout.trim() || null
      );
    } catch {
      return null;
    }
  }

  private async configValues(key: string): Promise<string[]> {
    try {
      return (
        await this.git(["config", "--local", "--no-includes", "--get-all", key])
      ).stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, 64);
    } catch {
      return [];
    }
  }

  private async configuredRemoteNames(): Promise<string[]> {
    try {
      const output = (
        await this.git([
          "config",
          "--local",
          "--no-includes",
          "--name-only",
          "--get-regexp",
          "^remote\\..*\\.url$",
        ])
      ).stdout;
      return [
        ...new Set(
          output
            .split("\n")
            .map(
              (key) =>
                /^remote\.([A-Za-z0-9][A-Za-z0-9._-]{0,254})\.url$/i.exec(
                  key.trim(),
                )?.[1],
            )
            .filter((name): name is string => Boolean(name)),
        ),
      ].sort();
    } catch {
      return [];
    }
  }

  private async defaultPushRemote(headRef = this.headRef): Promise<string> {
    if (!headRef?.startsWith("refs/heads/")) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "A detached checkout needs an explicit HTTPS remote for Git push",
      );
    }
    const branch = headRef.slice("refs/heads/".length);
    const configured =
      (await this.configValue(`branch.${branch}.pushRemote`)) ??
      (await this.configValue("remote.pushDefault")) ??
      (await this.configValue(`branch.${branch}.remote`));
    if (configured && configured !== ".") return configured;
    const remotes = await this.configuredRemoteNames();
    if (remotes.includes("origin")) return "origin";
    if (remotes.length === 1) return remotes[0]!;
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      "Git push needs an explicit remote because no unambiguous default exists",
    );
  }

  private async defaultFetchRemote(headRef = this.headRef): Promise<string> {
    const branch = headRef?.startsWith("refs/heads/")
      ? headRef.slice("refs/heads/".length)
      : null;
    const configured = branch
      ? await this.configValue(`branch.${branch}.remote`)
      : null;
    if (configured && configured !== ".") return configured;
    const remotes = await this.configuredRemoteNames();
    if (remotes.includes("origin")) return "origin";
    if (remotes.length === 1) return remotes[0]!;
    throw new ShadowGitPromotionError(
      "invalid-shadow-repository",
      "Git fetch needs an explicit remote because no unambiguous default exists",
    );
  }

  private async resolveRemote(
    requested: string | null,
    direction: "fetch" | "push",
    headRef = this.headRef,
  ): Promise<ScopedGitRemote> {
    const remote =
      requested ??
      (direction === "push"
        ? await this.defaultPushRemote(headRef)
        : await this.defaultFetchRemote(headRef));
    let name: string | null = null;
    let rawUrl = remote;
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(remote)) {
      const admitted = this.admittedRemotes.get(remote);
      if (admitted) {
        const admittedUrl =
          direction === "push" ? admitted.push : admitted.fetch;
        if (admittedUrl) {
          const current =
            direction === "push"
              ? ((await this.configValue(`remote.${remote}.pushurl`)) ??
                (await this.configValue(`remote.${remote}.url`)))
              : await this.configValue(`remote.${remote}.url`);
          if (current && scopedBrokeredRemoteUrl(current) === admittedUrl) {
            name = remote;
            rawUrl = admittedUrl;
          } else {
            // The agent changed the URL after admission. Let the original Git
            // process use it under kernel network policy, without credentials.
            return { kind: "native", name: remote, url: remote };
          }
        } else {
          return { kind: "native", name: remote, url: remote };
        }
      } else {
        return { kind: "native", name: remote, url: remote };
      }
    } else {
      const normalized = scopedBrokeredRemoteUrl(remote);
      const isAdmitted = [...this.admittedRemotes.values()].some((urls) =>
        direction === "push"
          ? urls.push === normalized
          : urls.fetch === normalized,
      );
      if (!normalized || !isAdmitted) {
        // Direct/unconfigured URLs remain usable, but only in the contained
        // child where ZSR's DNS/network policy—not engine authority—applies.
        return { kind: "native", name: null, url: remote };
      }
      rawUrl = normalized;
    }
    const httpUrl = scopedHttpRemoteUrl(rawUrl);
    if (httpUrl) {
      const parsed = new URL(httpUrl);
      const protocol = parsed.protocol.slice(0, -1) as "http" | "https";
      return {
        kind: "http",
        name,
        url: parsed.toString(),
        protocol,
        host: parsed.hostname.toLowerCase(),
        authority: parsed.host.toLowerCase(),
      };
    }
    const sshUrl = scopedSshRemoteUrl(rawUrl);
    if (sshUrl) return { kind: "ssh", name, url: sshUrl };
    return { kind: "native", name, url: remote };
  }

  private resolvePushRemote(
    requested: string | null,
    headRef = this.headRef,
  ): Promise<ScopedGitRemote> {
    return this.resolveRemote(requested, "push", headRef);
  }

  private resolveFetchRemote(
    requested: string | null,
    headRef = this.headRef,
  ): Promise<ScopedGitRemote> {
    return this.resolveRemote(requested, "fetch", headRef);
  }

  private async checkedRef(ref: string, kind: "source" | "destination") {
    if (
      !ref ||
      ref.startsWith("-") ||
      /[\0-\x20\x7f~^:?*\\]/.test(ref) ||
      ref.includes("[") ||
      ref.includes("..") ||
      ref.includes("@{") ||
      ref.endsWith(".") ||
      ref.endsWith("/") ||
      ref.includes("//")
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git push ${kind} ref is invalid`,
      );
    }
    try {
      await this.git(["check-ref-format", ref]);
    } catch {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git push ${kind} ref is invalid`,
      );
    }
    return ref;
  }

  private async sourceRef(
    raw: string,
    headRef = this.headRef,
    refs: ReadonlyMap<string, string> = this.refs,
  ): Promise<string> {
    if (raw === "HEAD" || raw === "@") {
      if (!headRef) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git push cannot resolve HEAD in a detached or unborn checkout",
        );
      }
      return headRef;
    }
    const candidate = raw.startsWith("refs/")
      ? raw
      : refs.has(`refs/heads/${raw}`)
        ? `refs/heads/${raw}`
        : refs.has(`refs/tags/${raw}`)
          ? `refs/tags/${raw}`
          : `refs/heads/${raw}`;
    await this.checkedRef(candidate, "source");
    if (!allowedPromotedRef(candidate)) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git push source is outside the admitted branch, tag, note, remote, or stash namespaces",
      );
    }
    return candidate;
  }

  private async destinationRef(
    raw: string | null,
    source: string | null,
  ): Promise<string> {
    const candidate = raw
      ? raw.startsWith("refs/")
        ? raw
        : source?.startsWith("refs/tags/")
          ? `refs/tags/${raw}`
          : source?.startsWith("refs/notes/")
            ? `refs/notes/${raw}`
            : `refs/heads/${raw}`
      : source;
    if (!candidate) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "A deleting Git push needs an explicit destination ref",
      );
    }
    await this.checkedRef(candidate, "destination");
    if (!allowedPromotedRef(candidate)) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git push destination is outside the admitted branch, tag, note, remote, or stash namespaces",
      );
    }
    return candidate;
  }

  private async exactPushRefspecs(
    parsed: ParsedShadowGitPush,
    remoteName: string | null,
    refs: ReadonlyMap<string, string> = this.refs,
    headRef = this.headRef,
    remoteRefs: ReadonlyMap<string, string> = new Map(),
  ): Promise<{
    refspecs: string[];
    upstream: {
      localBranch: string;
      remoteName: string;
      remoteBranch: string;
    } | null;
    leaseFlags: string[];
  }> {
    let rawRefspecs = [...parsed.refspecs];
    if (parsed.allBranches) {
      rawRefspecs = [...refs.keys()]
        .filter((ref) => ref.startsWith("refs/heads/"))
        .map((ref) => `${ref}:${ref}`);
    } else if (parsed.allTags) {
      rawRefspecs = [...refs.keys()]
        .filter((ref) => ref.startsWith("refs/tags/"))
        .map((ref) => `${ref}:${ref}`);
    } else if (parsed.mirror) {
      rawRefspecs = [...refs.keys()]
        .filter(allowedPromotedRef)
        .map((ref) => `+${ref}:${ref}`);
    } else if (parsed.deleteMode) {
      if (rawRefspecs.length === 0) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git push --delete needs at least one exact branch",
        );
      }
      rawRefspecs = rawRefspecs.map((ref) => `:${ref}`);
    } else if (rawRefspecs.length === 0) {
      if (!headRef) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git push needs an explicit refspec from a detached checkout",
        );
      }
      rawRefspecs = [headRef];
    }

    const expandedRefspecs: string[] = [];
    for (const raw of rawRefspecs) {
      const forcePrefix = raw.startsWith("+") ? "+" : "";
      const value = forcePrefix ? raw.slice(1) : raw;
      const separator = value.indexOf(":");
      const sourcePattern = separator < 0 ? value : value.slice(0, separator);
      const destinationPattern =
        separator < 0 ? null : value.slice(separator + 1);
      if (!sourcePattern.includes("*") && !destinationPattern?.includes("*")) {
        expandedRefspecs.push(raw);
        continue;
      }
      if (
        !sourcePattern.includes("*") ||
        !destinationPattern?.includes("*") ||
        sourcePattern.split("*").length !== 2 ||
        destinationPattern.split("*").length !== 2
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git push wildcard refspec needs one wildcard on each side",
        );
      }
      const normalizedSource = sourcePattern.startsWith("refs/")
        ? sourcePattern
        : `refs/heads/${sourcePattern}`;
      const [sourcePrefix, sourceSuffix] = normalizedSource.split("*");
      const [destinationPrefix, destinationSuffix] =
        destinationPattern.split("*");
      const destinations = new Set<string>();
      for (const ref of refs.keys()) {
        if (!ref.startsWith(sourcePrefix!) || !ref.endsWith(sourceSuffix!)) {
          continue;
        }
        const middle = ref.slice(
          sourcePrefix!.length,
          ref.length - sourceSuffix!.length,
        );
        const destination = `${destinationPrefix}${middle}${destinationSuffix}`;
        expandedRefspecs.push(`${forcePrefix}${ref}:${destination}`);
        destinations.add(destination);
      }
      if (parsed.prune || parsed.mirror) {
        for (const remoteRef of remoteRefs.keys()) {
          if (
            remoteRef.startsWith(destinationPrefix!) &&
            remoteRef.endsWith(destinationSuffix!) &&
            !destinations.has(remoteRef) &&
            allowedPromotedRef(remoteRef)
          ) {
            expandedRefspecs.push(`:${remoteRef}`);
          }
        }
      }
    }
    if (parsed.mirror) {
      const localDestinations = new Set(
        expandedRefspecs.map((refspec) =>
          refspec.slice(refspec.indexOf(":") + 1),
        ),
      );
      for (const remoteRef of remoteRefs.keys()) {
        if (
          allowedPromotedRef(remoteRef) &&
          !localDestinations.has(remoteRef)
        ) {
          expandedRefspecs.push(`:${remoteRef}`);
        }
      }
    }
    if (parsed.prune && (parsed.allBranches || parsed.allTags)) {
      const namespace = parsed.allBranches ? "refs/heads/" : "refs/tags/";
      for (const remoteRef of remoteRefs.keys()) {
        if (remoteRef.startsWith(namespace) && !refs.has(remoteRef)) {
          expandedRefspecs.push(`:${remoteRef}`);
        }
      }
    }
    rawRefspecs = [...new Set(expandedRefspecs)];

    const refspecs: string[] = [];
    const leaseFlags: string[] = [];
    let upstream: {
      localBranch: string;
      remoteName: string;
      remoteBranch: string;
    } | null = null;
    for (const rawRefspec of rawRefspecs) {
      let refspec = rawRefspec;
      let forced = false;
      if (refspec.startsWith("+")) {
        forced = true;
        refspec = refspec.slice(1);
      }
      const separator = refspec.indexOf(":");
      if (separator >= 0 && refspec.indexOf(":", separator + 1) >= 0) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git push refspec contains multiple separators",
        );
      }
      const rawSource = separator < 0 ? refspec : refspec.slice(0, separator);
      const rawDestination =
        separator < 0 ? null : refspec.slice(separator + 1);
      const source = rawSource
        ? await this.sourceRef(rawSource, headRef, refs)
        : null;
      const destination = await this.destinationRef(rawDestination, source);
      const oid = source ? refs.get(source) : null;
      if (source && !oid) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git push source ${source} is not an admitted local branch`,
        );
      }
      refspecs.push(`${forced ? "+" : ""}${oid ?? ""}:${destination}`);
      if (parsed.forceWithLease) {
        const remoteTracking = remoteName
          ? `refs/remotes/${remoteName}/${destination.slice("refs/heads/".length)}`
          : null;
        const expected =
          remoteRefs.get(destination) ??
          (remoteTracking ? refs.get(remoteTracking) : null);
        leaseFlags.push(`--force-with-lease=${destination}:${expected ?? ""}`);
      }
      if (
        parsed.setUpstream &&
        remoteName &&
        source === headRef &&
        source?.startsWith("refs/heads/")
      ) {
        upstream = {
          localBranch: source.slice("refs/heads/".length),
          remoteName,
          remoteBranch: destination.slice("refs/heads/".length),
        };
      }
    }
    for (const lease of parsed.explicitLeases) {
      const separator = lease.indexOf(":");
      const rawDestination = separator < 0 ? lease : lease.slice(0, separator);
      const rawExpected = separator < 0 ? null : lease.slice(separator + 1);
      const destination = await this.destinationRef(rawDestination, null);
      const expected =
        rawExpected ??
        remoteRefs.get(destination) ??
        (remoteName && destination.startsWith("refs/heads/")
          ? refs.get(
              `refs/remotes/${remoteName}/${destination.slice("refs/heads/".length)}`,
            )
          : null) ??
        "";
      if (
        expected &&
        !new RegExp(
          `^[0-9a-f]{${this.options.repository.objectFormat === "sha1" ? 40 : 64}}$`,
        ).test(expected)
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git push force-with-lease expected value is not an exact object ID",
        );
      }
      leaseFlags.push(`--force-with-lease=${destination}:${expected}`);
    }
    if (parsed.setUpstream && !upstream) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git push --set-upstream must target the current branch on a named remote",
      );
    }
    return {
      refspecs: [...new Set(refspecs)],
      upstream,
      leaseFlags: [...new Set(leaseFlags)],
    };
  }

  private async followTagRefspecs(
    refs: ReadonlyMap<string, string>,
    existingRefspecs: readonly string[],
    remoteRefs: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<string[]> {
    const pushedTips = existingRefspecs
      .map((refspec) => refspec.replace(/^\+/, "").split(":", 1)[0] ?? "")
      .filter((oid) => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid));
    if (pushedTips.length === 0) return [];
    const tags = [...refs]
      .filter(
        ([ref, oid]) =>
          ref.startsWith("refs/tags/") && remoteRefs.get(ref) !== oid,
      )
      .slice(0, 2_049);
    if (tags.length > 2_048) {
      throw new ShadowGitPromotionError(
        "quota-exceeded",
        "Git push --follow-tags exceeds the annotated-tag validation limit",
      );
    }
    const followed: string[] = [];
    for (const [ref, oid] of tags) {
      assertCapabilityActive(signal);
      const type = (
        await runTrustedGit({
          repository: this.options.repository,
          privateHome: this.options.privateHome,
          emptyHooks: this.emptyHooks,
          cwd: this.options.repository.workspaceRoot,
          args: ["cat-file", "-t", oid],
          gitDir: this.validatorGitDir,
          signal,
        })
      ).stdout.trim();
      if (type !== "tag") continue;
      let commit: string;
      try {
        commit = (
          await runTrustedGit({
            repository: this.options.repository,
            privateHome: this.options.privateHome,
            emptyHooks: this.emptyHooks,
            cwd: this.options.repository.workspaceRoot,
            args: ["rev-parse", "--verify", `${oid}^{commit}`],
            gitDir: this.validatorGitDir,
            signal,
          })
        ).stdout.trim();
      } catch (error) {
        if (signal.aborted) throw error;
        continue;
      }
      let reachable = false;
      for (const tip of pushedTips) {
        try {
          await runTrustedGit({
            repository: this.options.repository,
            privateHome: this.options.privateHome,
            emptyHooks: this.emptyHooks,
            cwd: this.options.repository.workspaceRoot,
            args: ["merge-base", "--is-ancestor", commit, tip],
            gitDir: this.validatorGitDir,
            signal,
          });
          reachable = true;
          break;
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
      if (reachable) followed.push(`${oid}:${ref}`);
    }
    return followed;
  }

  private async validateOutboundPush(
    refspecs: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.headOid || this.protectedPaths.length === 0) return;
    const expected = await this.protectedSnapshot(
      this.validatorGitDir,
      this.headOid,
      signal,
    );
    const sourceOids = [
      ...new Set(
        refspecs
          .map((refspec) => {
            const normalized = refspec.replace(/^\+/, "");
            return normalized.slice(0, normalized.indexOf(":"));
          })
          .filter((oid) => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid)),
      ),
    ];
    for (const oid of sourceOids) {
      let commit: string;
      try {
        commit = (
          await runTrustedGit({
            repository: this.options.repository,
            privateHome: this.options.privateHome,
            emptyHooks: this.emptyHooks,
            cwd: this.options.repository.workspaceRoot,
            args: ["rev-parse", "--verify", `${oid}^{commit}`],
            gitDir: this.validatorGitDir,
            signal,
          })
        ).stdout.trim();
      } catch (error) {
        if (signal.aborted) throw error;
        continue;
      }
      const candidate = await this.protectedSnapshot(
        this.validatorGitDir,
        commit,
        signal,
      );
      if (candidate !== expected) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "Git push was refused because an outbound ref changes protected Design or repository policy state",
        );
      }
    }
  }

  private async runCredentialedRemote(
    remote: ScopedHttpRemote,
    args: readonly string[],
    options: {
      gitDir: string;
      timeoutMs: number;
      signal: AbortSignal;
      workTree?: string;
      indexFile?: string;
      input?: string;
    },
  ): Promise<{ stdout: string; stderr: string }> {
    assertCapabilityActive(options.signal);
    const credential = await this.prepareHttpCredential(remote);
    assertCapabilityActive(options.signal);
    const run = (invocation: GitCredentialInvocation | null) =>
      runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: this.options.repository.workspaceRoot,
        args: [...(invocation?.gitConfigArgs ?? []), ...args],
        gitDir: options.gitDir,
        workTree: options.workTree,
        indexFile: options.indexFile,
        input: options.input,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          ...(invocation?.env ?? {}),
        },
      });
    try {
      try {
        return await run(credential);
      } catch (error) {
        const stderr = String(
          (error as { stderr?: unknown; cause?: { stderr?: unknown } })
            .stderr ?? "",
        );
        if (
          credential &&
          /(?:authentication failed|invalid username or password|http basic: access denied|returned error: 40[13])/i.test(
            stderr,
          ) &&
          (await refreshGitCredentialAfterAuthenticationFailure(credential))
        ) {
          assertCapabilityActive(options.signal);
          return run(credential);
        }
        throw error;
      }
    } finally {
      credential?.release?.();
    }
  }

  private httpCredentialRequest(remote: ScopedHttpRemote) {
    const parsedRemoteUrl = new URL(remote.url);
    return {
      contextId: `zsr:${this.options.generation}`,
      protocol: remote.protocol,
      host: remote.host,
      authority: remote.authority,
      ...(parsedRemoteUrl.username
        ? { username: decodedUrlComponent(parsedRemoteUrl.username) }
        : {}),
      ...(parsedRemoteUrl.pathname && parsedRemoteUrl.pathname !== "/"
        ? {
            path: decodedUrlComponent(
              parsedRemoteUrl.pathname.replace(/^\/+/, ""),
            ),
          }
        : {}),
    } as const;
  }

  private prepareHttpCredential(remote: ScopedHttpRemote) {
    return prepareGitCredentialInvocation(this.httpCredentialRequest(remote), {
      ...(process.env.HOME && path.isAbsolute(process.env.HOME)
        ? {
            ambient: {
              gitBinary: this.options.repository.gitBinary,
              home: process.env.HOME,
              ...(process.env.XDG_CONFIG_HOME &&
              path.isAbsolute(process.env.XDG_CONFIG_HOME)
                ? { xdgConfigHome: process.env.XDG_CONFIG_HOME }
                : {}),
            },
          }
        : {}),
    });
  }

  private async handlePromisorTransport(
    remoteName: string,
    remoteUrl: string,
    socket: Socket,
    signal: AbortSignal,
  ): Promise<void> {
    assertCapabilityActive(signal);
    const normalized = scopedBrokeredRemoteUrl(remoteUrl);
    const remote = await this.resolveFetchRemote(remoteName);
    if (
      !normalized ||
      remote.kind === "native" ||
      remote.url !== normalized ||
      remote.name !== remoteName
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git promisor transport is not the exact admitted fetch remote",
      );
    }
    const credential =
      remote.kind === "http" ? await this.prepareHttpCredential(remote) : null;
    assertCapabilityActive(signal);
    const helperArgs =
      remote.kind === "http"
        ? ["remote-http", remoteName, remote.url]
        : [
            "remote-ext",
            remoteName,
            sshRemoteExtCommand(
              remote.url,
              this.options.trustedSshCommandForTesting ??
                executableOnTrustedHostPath("ssh") ??
                (() => {
                  throw new Error("SSH is unavailable for promisor hydration");
                })(),
            ),
          ];
    const child = spawn(
      this.options.repository.gitBinary,
      trustedGitArgs(this.emptyHooks, [
        ...(credential?.gitConfigArgs ?? []),
        ...helperArgs,
      ]),
      {
        cwd: this.options.repository.workspaceRoot,
        env: trustedGitEnvironment(this.options.privateHome, {
          // remote-http's fetch-pack/index-pack subprocess writes hydrated
          // promisor objects into GIT_DIR. Keep those writes in the
          // session-private object database; the fetch-only protocol filter
          // prevents the helper from accepting any ref-update operation.
          GIT_DIR: this.options.shadowRoot,
          ...(remote.kind === "ssh"
            ? this.sshTransportEnvironment()
            : (credential?.env ?? {})),
        }),
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already gone */
      }
    };
    let acknowledged = false;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          socket.off("close", disconnected);
          if (error && !acknowledged) reject(error);
          else resolve();
        };
        const abort = () => {
          kill();
          socket.destroy();
          settle();
        };
        const disconnected = () => {
          kill();
          settle();
        };
        signal.addEventListener("abort", abort, { once: true });
        socket.once("close", disconnected);
        child.once("error", (error) => settle(error));
        child.once("spawn", () => {
          if (signal.aborted || socket.destroyed) {
            abort();
            return;
          }
          const filter = fetchOnlyRemoteProtocol();
          filter.once("error", () => {
            kill();
            socket.destroy();
          });
          child.stdin.on("error", () => undefined);
          // Drain opaque transport diagnostics without returning them across
          // the credential boundary; helpers have historically echoed URLs or
          // headers in error text.
          child.stderr.on("data", () => undefined);
          acknowledged = true;
          socket.write(`${JSON.stringify({ ok: true })}\n`);
          socket.pipe(filter).pipe(child.stdin);
          child.stdout.pipe(socket, { end: false });
        });
        // `exit` may precede the final stdout bytes. Close the capability
        // only after all child stdio has closed so pack data cannot be
        // truncated on fast local or SSH transports.
        child.once("close", () => {
          if (!socket.destroyed) socket.end();
          settle();
        });
      });
    } finally {
      credential?.release?.();
    }
  }

  private sshTransportEnvironment(): Record<string, string> {
    const hostHome = process.env.HOME;
    const socket = process.env.SSH_AUTH_SOCK;
    return {
      ...(hostHome && path.isAbsolute(hostHome) && !hostHome.includes("\0")
        ? { HOME: hostHome }
        : {}),
      ...(process.env.XDG_CONFIG_HOME &&
      path.isAbsolute(process.env.XDG_CONFIG_HOME) &&
      !process.env.XDG_CONFIG_HOME.includes("\0")
        ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
        : {}),
      ...(socket && path.isAbsolute(socket) && !socket.includes("\0")
        ? { SSH_AUTH_SOCK: socket }
        : {}),
      ...(this.options.trustedSshCommandForTesting
        ? { GIT_SSH: this.options.trustedSshCommandForTesting }
        : {}),
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  private runSshRemote(
    remote: ScopedSshRemote,
    args: readonly string[],
    options: {
      gitDir: string;
      timeoutMs: number;
      signal: AbortSignal;
      workTree?: string;
      indexFile?: string;
      input?: string;
    },
  ): Promise<{ stdout: string; stderr: string }> {
    return runTrustedGit({
      repository: this.options.repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd: this.options.repository.workspaceRoot,
      args,
      gitDir: options.gitDir,
      workTree: options.workTree,
      indexFile: options.indexFile,
      input: options.input,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      env: this.sshTransportEnvironment(),
    });
  }

  private runScopedRemote(
    remote: ScopedBrokeredRemote,
    args: readonly string[],
    options: {
      gitDir: string;
      timeoutMs: number;
      signal: AbortSignal;
      workTree?: string;
      indexFile?: string;
      input?: string;
    },
  ): Promise<{ stdout: string; stderr: string }> {
    return remote.kind === "http"
      ? this.runCredentialedRemote(remote, args, options)
      : this.runSshRemote(remote, args, options);
  }

  private async advertisedRemoteRefs(
    remote: ScopedBrokeredRemote,
    signal: AbortSignal,
  ): Promise<Map<string, string>> {
    const { stdout } = await this.runScopedRemote(
      remote,
      ["ls-remote", "--refs", "--", remote.url],
      {
        gitDir: this.validatorGitDir,
        timeoutMs: 15 * 60_000,
        signal,
      },
    );
    const oidLength = this.options.repository.objectFormat === "sha1" ? 40 : 64;
    const refs = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [oid, ref, ...extra] = line.split("\t");
      if (
        extra.length > 0 ||
        !oid ||
        !new RegExp(`^[0-9a-f]{${oidLength}}$`).test(oid) ||
        !ref?.startsWith("refs/") ||
        /[\0-\x20\x7f]/.test(ref)
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git remote advertised an invalid reference",
        );
      }
      refs.set(ref, oid);
      if (refs.size > MAX_REFS) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Git remote advertises too many references",
        );
      }
    }
    return refs;
  }

  private lfsEndpoint(remote: ScopedHttpRemote): string {
    const endpoint = new URL(remote.url);
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/info/lfs`;
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString();
  }

  /** Run Git LFS's trusted upload path before the Git ref transfer. The
   * repository's pre-push hook is intentionally suppressed because hooks run
   * inside the agent boundary, while credentials remain engine-owned. Instead
   * Zeros reconstructs the exact pre-push input from already-authorized
   * refspecs and pins both storage and transport configuration. */
  private async pushLfsObjects(
    remote: ScopedBrokeredRemote,
    refspecs: readonly string[],
    remoteRefs: ReadonlyMap<string, string>,
    dryRun: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const privateObjects = await validatePrivateLfsObjects(
      this.options.shadowRoot,
      signal,
    );
    const zero =
      this.options.repository.objectFormat === "sha1" ? ZERO_SHA1 : ZERO_SHA256;
    const updates = refspecs
      .map((rawRefspec) => {
        const refspec = rawRefspec.replace(/^\+/, "");
        const separator = refspec.indexOf(":");
        const source = separator < 0 ? refspec : refspec.slice(0, separator);
        const destination =
          separator < 0 ? refspec : refspec.slice(separator + 1);
        if (!destination) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Git LFS push received an invalid destination ref",
          );
        }
        return `${destination} ${source || zero} ${destination} ${
          remoteRefs.get(destination) ?? zero
        }`;
      })
      .join("\n");
    if (!updates) return;

    const remoteName = remote.name ?? "zeros-scoped";
    const lfsStorage = dryRun
      ? path.join(this.options.shadowRoot, "lfs")
      : path.join(this.options.repository.commonDir, "lfs");
    const lfsEndpoint =
      remote.kind === "http" ? this.lfsEndpoint(remote) : null;
    try {
      await this.runScopedRemote(
        remote,
        [
          "-c",
          `remote.${remoteName}.url=${remote.url}`,
          "-c",
          `remote.${remoteName}.pushurl=${remote.url}`,
          "-c",
          `lfs.storage=${lfsStorage}`,
          ...(lfsEndpoint
            ? [
                "-c",
                `lfs.url=${lfsEndpoint}`,
                "-c",
                `lfs.pushurl=${lfsEndpoint}`,
                "-c",
                "lfs.basictransfersonly=true",
              ]
            : []),
          "-c",
          "lfs.tustransfers=false",
          "lfs",
          "pre-push",
          ...(dryRun ? ["--dry-run"] : []),
          remoteName,
          remote.url,
        ],
        {
          gitDir: this.validatorGitDir,
          workTree: this.options.repository.workspaceRoot,
          timeoutMs: 15 * 60_000,
          signal,
          input: `${updates}\n`,
        },
      );
    } catch (error) {
      const stderr = String(
        (error as { stderr?: unknown; cause?: { stderr?: unknown } }).stderr ??
          "",
      );
      if (
        privateObjects.length === 0 &&
        /(?:git: ['"]lfs['"] is not a git command|git-lfs: (?:command )?not found)/i.test(
          stderr,
        )
      ) {
        // Git LFS is optional for ordinary repositories. A session that
        // produced private LFS media may never silently publish without it.
        return;
      }
      throw error;
    }
  }

  private async cleanupStagedFetch(cleanupId: string): Promise<void> {
    const staged = this.stagedFetches.get(cleanupId);
    if (!staged) return;
    this.stagedFetches.delete(cleanupId);
    await removeReadOnlyTree(staged);
  }

  private async prepareStagedFetch(
    parsed: ParsedShadowGitFetch,
    signal: AbortSignal,
    requiredSources: readonly string[] = [],
  ): Promise<
    | { readonly delegateNative: true }
    | {
        readonly delegateNative: false;
        readonly result: { stdout: string; stderr: string };
        readonly cleanupId: string | null;
        readonly stageGitDir: string | null;
        readonly plan: StagedFetchRefspecPlan | null;
        readonly followUpCommand: readonly string[] | null;
      }
  > {
    if (this.stopped) throw new Error("shadow Git session is stopped");
    assertCapabilityActive(signal);
    const currentHead = await this.readHead(this.options.shadowRoot, signal);
    const remote = await this.resolveFetchRemote(
      parsed.remote,
      currentHead.ref,
    );
    if (remote.kind === "native") return { delegateNative: true };
    if (this.stagedFetches.size >= MAX_STAGED_FETCHES) {
      throw new ShadowGitPromotionError(
        "quota-exceeded",
        "Too many Git fetches are awaiting contained import",
      );
    }
    const admitted = remote.name ? this.admittedRemotes.get(remote.name) : null;
    const configuredRefspecs =
      parsed.refspecs.length > 0
        ? parsed.refspecs
        : (admitted?.fetchRefspecs ?? []);
    const requestedRefspecs = [...configuredRefspecs];
    for (const source of requiredSources) {
      if (
        !requestedRefspecs.some((refspec) =>
          fetchRefspecCoversSource(refspec, source),
        )
      ) {
        requestedRefspecs.push(source);
      }
    }
    const cleanupId = randomUUID();
    const stageRoot = path.join(this.options.toolsRoot, "remote-stages");
    const stageGitDir = path.join(stageRoot, `${cleanupId}.git`);
    const plan = stagedFetchRefspecPlan(requestedRefspecs, cleanupId);
    await mkdir(stageRoot, { recursive: true, mode: 0o700 });
    await mkdir(stageGitDir, { mode: 0o700 });
    try {
      const initArgs = ["init", "--bare"];
      if (this.options.repository.objectFormat === "sha256") {
        initArgs.push("--object-format=sha256");
      }
      initArgs.push(stageGitDir);
      await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: this.options.repository.workspaceRoot,
        args: initArgs,
        signal,
      });
      await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: this.options.repository.workspaceRoot,
        args: ["config", "--local", "uploadpack.allowFilter", "true"],
        gitDir: stageGitDir,
        signal,
      });
      const result = await this.runScopedRemote(
        remote,
        [
          "fetch",
          ...filterFetchFlags(parsed.flags, "network"),
          "--",
          remote.url,
          ...plan.networkRefspecs,
        ],
        {
          gitDir: stageGitDir,
          timeoutMs: 15 * 60_000,
          signal,
        },
      );
      if (parsed.flags.includes("--dry-run")) {
        await removeReadOnlyTree(stageGitDir);
        return {
          delegateNative: false,
          result,
          cleanupId: null,
          stageGitDir: null,
          plan: null,
          followUpCommand: null,
        };
      }
      assertCapabilityActive(signal);
      await directoryQuota(path.join(stageGitDir, "objects"));
      const stagedRefs = await this.snapshotRefs(stageGitDir, signal);
      if (stagedRefs.size > 0) {
        await runTrustedGit({
          repository: this.options.repository,
          privateHome: this.options.privateHome,
          emptyHooks: this.emptyHooks,
          cwd: this.options.repository.workspaceRoot,
          args: [
            "fsck",
            "--strict",
            "--no-reflogs",
            "--no-dangling",
            ...stagedRefs.values(),
          ],
          gitDir: stageGitDir,
          timeoutMs: 120_000,
          signal,
        });
      }
      await makeTreeReadOnly(stageGitDir);
      this.stagedFetches.set(cleanupId, stageGitDir);
      return {
        delegateNative: false,
        result,
        cleanupId,
        stageGitDir,
        plan,
        followUpCommand: [
          "fetch",
          ...filterFetchFlags(parsed.flags, "local"),
          "--",
          stageGitDir,
          ...plan.localRefspecs,
        ],
      };
    } catch (error) {
      await removeReadOnlyTree(stageGitDir).catch(() => undefined);
      throw error;
    }
  }

  private async fetch(
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    const parsed = parseShadowGitFetchArgs(args);
    const fetched = await this.prepareStagedFetch(parsed, signal);
    return fetched.delegateNative
      ? { stdout: "", stderr: "", delegateNative: true }
      : {
          ...fetched.result,
          ...(fetched.followUpCommand
            ? { followUpCommands: [fetched.followUpCommand] }
            : {}),
          ...(fetched.cleanupId ? { cleanupId: fetched.cleanupId } : {}),
        };
  }

  private async pullMergeSources(
    parsed: ParsedShadowGitPull,
    headRef: string | null,
  ): Promise<string[]> {
    let sources: string[];
    if (parsed.refspecs.length > 0) {
      sources = expandTagFetchSyntax(parsed.refspecs)
        .map(positiveFetchSource)
        .filter((source): source is string => Boolean(source));
    } else {
      const branch = headRef?.startsWith("refs/heads/")
        ? headRef.slice("refs/heads/".length)
        : null;
      const configured = branch
        ? await this.configValues(`branch.${branch}.merge`)
        : [];
      sources =
        configured.length > 0
          ? configured.map(normalizeRemoteFetchSource)
          : ["HEAD"];
    }
    const unique = [...new Set(sources)];
    if (unique.length === 0 || unique.length > 64) {
      throw new ShadowGitPromotionError(
        unique.length === 0 ? "invalid-shadow-repository" : "quota-exceeded",
        "Git pull requires between one and 64 exact merge sources",
      );
    }
    return unique;
  }

  private async resolveStagedMergeOids(
    stageGitDir: string,
    plan: StagedFetchRefspecPlan,
    sources: readonly string[],
    signal: AbortSignal,
  ): Promise<string[]> {
    const stagedRefs = await this.snapshotRefs(stageGitDir, signal);
    const revisions: string[] = [];
    for (const source of sources) {
      const staged = plan.stagedSource.get(source) ?? source;
      if (staged.includes("*")) {
        const [prefix, suffix] = staged.split("*");
        revisions.push(
          ...[...stagedRefs.keys()].filter(
            (ref) => ref.startsWith(prefix!) && ref.endsWith(suffix!),
          ),
        );
      } else {
        revisions.push(staged);
      }
    }
    const oids: string[] = [];
    for (const revision of [...new Set(revisions)]) {
      try {
        const oid = (
          await runTrustedGit({
            repository: this.options.repository,
            privateHome: this.options.privateHome,
            emptyHooks: this.emptyHooks,
            cwd: this.options.repository.workspaceRoot,
            args: ["rev-parse", "--verify", `${revision}^{commit}`],
            gitDir: stageGitDir,
            signal,
          })
        ).stdout.trim();
        oids.push(oid);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git pull could not resolve remote merge source ${revision}`,
        );
      }
      if (oids.length > 64) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Git pull produced too many merge candidates",
        );
      }
    }
    if (oids.length === 0) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git pull did not identify a branch to merge",
      );
    }
    return [...new Set(oids)];
  }

  private async configuredPullIntegration(
    parsed: ParsedShadowGitPull,
    headRef: string | null,
  ): Promise<{ kind: "merge" | "rebase"; flags: string[] }> {
    let kind = parsed.integration;
    const flags = [...parsed.integrationFlags];
    if (!kind) {
      const branch = headRef?.startsWith("refs/heads/")
        ? headRef.slice("refs/heads/".length)
        : null;
      const configured =
        (branch ? await this.configValue(`branch.${branch}.rebase`) : null) ??
        (await this.configValue("pull.rebase"));
      if (
        /^(?:true|yes|on|1|merges|preserve|interactive)$/i.test(
          configured ?? "",
        )
      ) {
        kind = "rebase";
        if (/^(?:merges|preserve)$/i.test(configured!)) {
          flags.push("--rebase-merges");
        } else if (/^interactive$/i.test(configured!)) {
          flags.push("--interactive");
        }
      } else {
        kind = "merge";
      }
    }
    if (
      kind === "merge" &&
      !flags.some((flag) => ["--ff", "--no-ff", "--ff-only"].includes(flag))
    ) {
      const configuredFf = await this.configValue("pull.ff");
      if (/^only$/i.test(configuredFf ?? "")) flags.push("--ff-only");
      else if (/^(?:false|no|off|0)$/i.test(configuredFf ?? "")) {
        flags.push("--no-ff");
      }
    }
    return { kind, flags };
  }

  private async validatePullTargets(
    currentOid: string | null,
    mergeOids: readonly string[],
    targetGitDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!currentOid || this.protectedPaths.length === 0) return;
    const current = await this.protectedSnapshot(
      this.validatorGitDir,
      currentOid,
      signal,
    );
    for (const oid of mergeOids) {
      const target = await this.protectedSnapshot(targetGitDir, oid, signal);
      if (current !== target) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "Git pull was refused because the remote branch changes protected Design or repository policy state",
        );
      }
    }
  }

  private async pull(
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    const parsed = parseShadowGitPullArgs(args);
    if (parsed.flags.includes("--no-write-fetch-head")) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git pull requires FETCH_HEAD; --no-write-fetch-head is not compatible with the scoped adapter",
      );
    }
    const currentHead = await this.readHead(this.options.shadowRoot, signal);
    const mergeSources = await this.pullMergeSources(parsed, currentHead.ref);
    const fetched = await this.prepareStagedFetch(
      {
        remote: parsed.remote,
        refspecs: parsed.refspecs,
        flags: parsed.flags,
      },
      signal,
      mergeSources,
    );
    if (fetched.delegateNative) {
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if (parsed.flags.includes("--dry-run")) return fetched.result;
    try {
      if (
        !fetched.stageGitDir ||
        !fetched.plan ||
        !fetched.followUpCommand ||
        !fetched.cleanupId
      ) {
        throw new Error("staged Git pull is missing its contained handoff");
      }
      const mergeOids = await this.resolveStagedMergeOids(
        fetched.stageGitDir,
        fetched.plan,
        mergeSources,
        signal,
      );
      await this.validatePullTargets(
        currentHead.oid,
        mergeOids,
        fetched.stageGitDir,
        signal,
      );
      const integration = await this.configuredPullIntegration(
        parsed,
        currentHead.ref,
      );
      assertCapabilityActive(signal);
      const ffOnly = integration.flags.includes("--ff-only");
      if (
        ffOnly &&
        integration.kind === "rebase" &&
        integration.flags.some((flag) =>
          ["--rebase-merges", "--interactive"].includes(flag),
        )
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git pull cannot combine --ff-only with an interactive or merge-preserving rebase in the scoped adapter",
        );
      }
      if (integration.kind === "rebase" && !ffOnly && mergeOids.length !== 1) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git pull --rebase requires one exact merge source",
        );
      }
      const integrationFlags =
        integration.kind === "rebase" && ffOnly
          ? integration.flags.filter(
              (flag) => !["--rebase-merges", "--interactive"].includes(flag),
            )
          : integration.flags;
      const integrationCommand =
        integration.kind === "merge" || ffOnly
          ? ["merge", ...integrationFlags, "--", ...mergeOids]
          : ["rebase", ...integrationFlags, "--", mergeOids[0]!];
      return {
        ...fetched.result,
        followUpCommands: [fetched.followUpCommand, integrationCommand],
        cleanupId: fetched.cleanupId,
      };
    } catch (error) {
      if (fetched.cleanupId) {
        await this.cleanupStagedFetch(fetched.cleanupId).catch(() => undefined);
      }
      throw error;
    }
  }

  private scopedCommandCwd(rawCwd: string): string {
    let cwd: string;
    try {
      cwd = realpathSync(rawCwd);
    } catch {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git command working directory is unavailable",
      );
    }
    if (!pathInside(cwd, this.options.repository.workspaceRoot)) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git command working directory is outside the scoped workspace",
      );
    }
    return cwd;
  }

  private repoPathIsProtected(value: string): boolean {
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
    return this.protectedPaths.some(
      (protectedPath) =>
        normalized === protectedPath ||
        normalized.startsWith(`${protectedPath}/`) ||
        protectedPath.startsWith(`${normalized}/`),
    );
  }

  private async selectedCheckoutPathsTouchDesign(
    cwd: string,
    pathspecs: readonly string[],
    source: string | null,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.protectedPaths.length === 0 || pathspecs.length === 0) {
      return false;
    }
    const shadowIndex = path.join(this.options.shadowRoot, "index");
    const selected = new Set<string>();
    const indexSelection = await runTrustedGit({
      repository: this.options.repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd,
      args: [
        "ls-files",
        "-z",
        "--full-name",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ...pathspecs,
      ],
      gitDir: this.options.shadowRoot,
      workTree: this.options.repository.workspaceRoot,
      indexFile: shadowIndex,
      signal,
    });
    for (const entry of indexSelection.stdout.split("\0")) {
      if (entry) selected.add(entry);
    }
    if (source) {
      const revision = source === "-" ? "@{-1}" : source;
      const treeSelection = await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd,
        args: [
          "ls-tree",
          "-r",
          "-z",
          "--name-only",
          "--full-tree",
          revision,
          "--",
          ...pathspecs,
        ],
        gitDir: this.options.shadowRoot,
        workTree: this.options.repository.workspaceRoot,
        signal,
      });
      for (const entry of treeSelection.stdout.split("\0")) {
        if (entry) selected.add(entry);
      }
    }
    return [...selected].some((entry) => this.repoPathIsProtected(entry));
  }

  private async resolveCheckoutCommit(
    target: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const revision = target === "-" ? "@{-1}" : target;
    try {
      const oid = (
        await runTrustedGit({
          repository: this.options.repository,
          privateHome: this.options.privateHome,
          emptyHooks: this.emptyHooks,
          cwd,
          args: [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${revision}^{commit}`,
          ],
          gitDir: this.options.shadowRoot,
          workTree: this.options.repository.workspaceRoot,
          signal,
        })
      ).stdout.trim();
      const width = this.options.repository.objectFormat === "sha1" ? 40 : 64;
      return new RegExp(`^[0-9a-f]{${width}}$`).test(oid) ? oid : null;
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    }
  }

  private async protectedWorktreeDiffersFrom(
    revision: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.protectedPaths.length === 0) return false;
    try {
      await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd,
        args: [
          "diff",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          revision,
          "--",
          ...this.protectedPaths,
        ],
        gitDir: this.options.shadowRoot,
        workTree: this.options.repository.workspaceRoot,
        indexFile: path.join(this.options.shadowRoot, "index"),
        signal,
      });
      return false;
    } catch (error) {
      if (signal.aborted) throw error;
      const code = (error as { code?: unknown }).code;
      if (code === 1 || code === "1") return true;
      throw error;
    }
  }

  private async protectedIndexDiffersFrom(
    revision: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.protectedPaths.length === 0) return false;
    try {
      await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd,
        args: [
          "diff",
          "--cached",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          revision,
          "--",
          ...this.protectedPaths,
        ],
        gitDir: this.options.shadowRoot,
        workTree: this.options.repository.workspaceRoot,
        indexFile: path.join(this.options.shadowRoot, "index"),
        signal,
      });
      return false;
    } catch (error) {
      if (signal.aborted) throw error;
      const code = (error as { code?: unknown }).code;
      if (code === 1 || code === "1") return true;
      throw error;
    }
  }

  private async revisionsDifferOnProtectedPaths(
    before: string,
    after: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: this.options.repository.workspaceRoot,
        args: [
          "diff",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          before,
          after,
          "--",
          ...this.protectedPaths,
        ],
        gitDir: this.options.shadowRoot,
        workTree: this.options.repository.workspaceRoot,
        signal,
      });
      return false;
    } catch (error) {
      if (signal.aborted) throw error;
      const code = (error as { code?: unknown }).code;
      if (code === 1 || code === "1") return true;
      throw error;
    }
  }

  private async preflightReset(
    args: readonly string[],
    rawCwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    const cwd = this.scopedCommandCwd(rawCwd);
    const tail = localCommandTail(args, "reset");
    type ResetMode = "soft" | "mixed" | "hard" | "merge" | "keep";
    const resetModeByOption = new Map<string, ResetMode>([
      ["--soft", "soft"],
      ["--mixed", "mixed"],
      ["--hard", "hard"],
      ["--merge", "merge"],
      ["--keep", "keep"],
    ]);
    let mode: ResetMode = "mixed";
    let explicitPathspecs: string[] | null = null;
    const positionals: string[] = [];
    for (let index = 0; index < tail.length; index += 1) {
      const value = tail[index]!;
      if (value === "--") {
        explicitPathspecs = tail.slice(index + 1);
        break;
      }
      const selectedMode = resetModeByOption.get(value);
      if (selectedMode) {
        mode = selectedMode;
        continue;
      }
      if (
        value === "--pathspec-from-file" ||
        value.startsWith("--pathspec-from-file=") ||
        value === "--pathspec-file-nul"
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git reset pathspec files require an explicit Zeros adapter",
        );
      }
      if (
        [
          "-q",
          "--quiet",
          "--no-refresh",
          "--refresh",
          "-N",
          "--intent-to-add",
          "--recurse-submodules",
          "--no-recurse-submodules",
        ].includes(value) ||
        value.startsWith("--recurse-submodules=")
      ) {
        if (
          value.includes("recurse-submodules") &&
          this.protectedPaths.length
        ) {
          throw new ShadowGitPromotionError(
            "design-impact",
            "Recursive Git reset requires an explicit repository-sync operation when Design is protected",
          );
        }
        continue;
      }
      if (value.startsWith("-")) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git reset option ${value} requires an explicit Zeros adapter`,
        );
      }
      positionals.push(value);
    }

    let target = "HEAD";
    let targetOid: string | null = null;
    let pathspecs: readonly string[] | null = explicitPathspecs;
    if (explicitPathspecs) {
      if (positionals.length > 1) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git reset contains an ambiguous tree and path selection",
        );
      }
      target = positionals[0] ?? "HEAD";
      targetOid = await this.resolveCheckoutCommit(target, cwd, signal);
    } else if (positionals.length > 0) {
      targetOid = await this.resolveCheckoutCommit(
        positionals[0]!,
        cwd,
        signal,
      );
      if (targetOid && positionals.length === 1) {
        target = positionals[0]!;
      } else if (targetOid) {
        target = positionals.shift()!;
        pathspecs = positionals;
      } else {
        pathspecs = positionals;
      }
    } else {
      targetOid = await this.resolveCheckoutCommit(target, cwd, signal);
    }

    if (pathspecs) {
      if (
        await this.selectedCheckoutPathsTouchDesign(
          cwd,
          pathspecs,
          targetOid ? target : null,
          signal,
        )
      ) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "Git reset was refused before mutation because its path selection includes protected Design or repository policy state",
        );
      }
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if (!targetOid || !this.headOid) {
      return { stdout: "", stderr: "", delegateNative: true };
    }
    const [expected, candidate] = await Promise.all([
      this.protectedSnapshot(
        this.options.repository.gitDir,
        this.headOid,
        signal,
      ),
      this.protectedSnapshot(this.validatorGitDir, targetOid, signal),
    ]);
    if (expected !== candidate) {
      throw new ShadowGitPromotionError(
        "design-impact",
        "Git reset was refused before mutation because the target changes protected Design or repository policy state",
      );
    }
    if (
      (mode === "hard" || mode === "merge" || mode === "keep") &&
      (await this.protectedWorktreeDiffersFrom(targetOid, cwd, signal))
    ) {
      throw new ShadowGitPromotionError(
        "design-impact",
        "Git reset was refused before mutation because it would overwrite live protected Design or repository policy state",
      );
    }
    return { stdout: "", stderr: "", delegateNative: true };
  }

  private async preflightRestore(
    args: readonly string[],
    rawCwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    const cwd = this.scopedCommandCwd(rawCwd);
    const tail = localCommandTail(args, "restore");
    let source: string | null = null;
    let staged = false;
    const pathspecs: string[] = [];
    let positionalOnly = false;
    for (let index = 0; index < tail.length; index += 1) {
      const value = tail[index]!;
      if (!positionalOnly && value === "--") {
        positionalOnly = true;
        continue;
      }
      if (!positionalOnly && (value === "-s" || value === "--source")) {
        const candidate = tail[index + 1];
        if (!candidate) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            `Git restore option ${value} is missing its source`,
          );
        }
        source = candidate;
        index += 1;
        continue;
      }
      if (!positionalOnly && value.startsWith("--source=")) {
        source = value.slice("--source=".length);
        continue;
      }
      if (
        !positionalOnly &&
        (value === "--pathspec-from-file" ||
          value.startsWith("--pathspec-from-file=") ||
          value === "--pathspec-file-nul")
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git restore pathspec files require an explicit Zeros adapter",
        );
      }
      if (!positionalOnly && (value === "-S" || value === "--staged")) {
        staged = true;
        continue;
      }
      if (
        !positionalOnly &&
        [
          "-W",
          "--worktree",
          "-p",
          "--patch",
          "--ours",
          "--theirs",
          "-m",
          "--merge",
          "--overlay",
          "--no-overlay",
          "--ignore-unmerged",
          "--ignore-skip-worktree-bits",
          "--recurse-submodules",
          "--no-recurse-submodules",
          "--progress",
          "--no-progress",
          "-q",
          "--quiet",
        ].includes(value)
      ) {
        continue;
      }
      if (!positionalOnly && value === "--conflict") {
        if (!tail[index + 1]) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Git restore --conflict is missing its style",
          );
        }
        index += 1;
        continue;
      }
      if (!positionalOnly && value.startsWith("--conflict=")) continue;
      if (!positionalOnly && /^-[SW]{2}$/.test(value)) {
        staged = value.includes("S");
        continue;
      }
      if (!positionalOnly && value.startsWith("-")) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git restore option ${value} requires an explicit Zeros adapter`,
        );
      }
      pathspecs.push(value);
    }
    const effectiveSource = source ?? (staged ? "HEAD" : null);
    if (
      await this.selectedCheckoutPathsTouchDesign(
        cwd,
        pathspecs,
        effectiveSource,
        signal,
      )
    ) {
      throw new ShadowGitPromotionError(
        "design-impact",
        "Git restore was refused before mutation because its path selection includes protected Design or repository policy state",
      );
    }
    return { stdout: "", stderr: "", delegateNative: true };
  }

  private async preflightClean(
    args: readonly string[],
    rawCwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    const cwd = this.scopedCommandCwd(rawCwd);
    const tail = localCommandTail(args, "clean");
    const pathspecs: string[] = [];
    const excludes: string[] = [];
    let ignoredMode: "normal" | "all" | "only" = "normal";
    let dryRun = false;
    let positionalOnly = false;
    for (let index = 0; index < tail.length; index += 1) {
      const value = tail[index]!;
      if (!positionalOnly && value === "--") {
        positionalOnly = true;
        continue;
      }
      if (!positionalOnly && (value === "-e" || value === "--exclude")) {
        const pattern = tail[index + 1];
        if (!pattern) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            `Git clean option ${value} is missing its pattern`,
          );
        }
        excludes.push(pattern);
        index += 1;
        continue;
      }
      if (!positionalOnly && value.startsWith("--exclude=")) {
        excludes.push(value.slice("--exclude=".length));
        continue;
      }
      if (!positionalOnly && /^-[dfinqxX]+$/.test(value)) {
        if (value.includes("x")) ignoredMode = "all";
        if (value.includes("X")) ignoredMode = "only";
        if (value.includes("n")) dryRun = true;
        continue;
      }
      if (
        !positionalOnly &&
        [
          "--force",
          "--interactive",
          "--quiet",
          "--no-quiet",
          "--dry-run",
        ].includes(value)
      ) {
        if (value === "--dry-run") dryRun = true;
        continue;
      }
      if (!positionalOnly && value.startsWith("-")) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git clean option ${value} requires an explicit Zeros adapter`,
        );
      }
      pathspecs.push(value);
    }
    if (dryRun || this.protectedPaths.length === 0) {
      return { stdout: "", stderr: "", delegateNative: true };
    }
    const listArgs = ["ls-files", "-z", "--full-name", "--others"];
    if (ignoredMode === "normal") listArgs.push("--exclude-standard");
    if (ignoredMode === "only") {
      listArgs.push("--ignored", "--exclude-standard");
    }
    for (const pattern of excludes) listArgs.push(`--exclude=${pattern}`);
    if (pathspecs.length > 0) listArgs.push("--", ...pathspecs);
    const selected = await runTrustedGit({
      repository: this.options.repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd,
      args: listArgs,
      gitDir: this.options.shadowRoot,
      workTree: this.options.repository.workspaceRoot,
      indexFile: path.join(this.options.shadowRoot, "index"),
      signal,
    });
    if (
      selected.stdout
        .split("\0")
        .some((entry) => entry && this.repoPathIsProtected(entry))
    ) {
      throw new ShadowGitPromotionError(
        "design-impact",
        "Git clean was refused before mutation because it would delete protected Design or repository policy state",
      );
    }
    return { stdout: "", stderr: "", delegateNative: true };
  }

  private async preflightPathMutation(
    operation: "rm" | "mv",
    args: readonly string[],
    rawCwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    const cwd = this.scopedCommandCwd(rawCwd);
    const tail = localCommandTail(args, operation);
    const operands: string[] = [];
    let positionalOnly = false;
    for (let index = 0; index < tail.length; index += 1) {
      const value = tail[index]!;
      if (!positionalOnly && value === "--") {
        positionalOnly = true;
        continue;
      }
      if (
        !positionalOnly &&
        operation === "rm" &&
        (value === "--pathspec-from-file" ||
          value.startsWith("--pathspec-from-file=") ||
          value === "--pathspec-file-nul")
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git rm pathspec files require an explicit Zeros adapter",
        );
      }
      const allowed =
        operation === "rm"
          ? new Set([
              "-f",
              "--force",
              "-n",
              "--dry-run",
              "-r",
              "--cached",
              "--ignore-unmatch",
              "-q",
              "--quiet",
              "--sparse",
            ])
          : new Set([
              "-f",
              "--force",
              "-k",
              "-n",
              "--dry-run",
              "-v",
              "--verbose",
              "--sparse",
            ]);
      if (!positionalOnly && allowed.has(value)) continue;
      if (!positionalOnly && operation === "rm" && /^-[fnrq]+$/.test(value)) {
        continue;
      }
      if (!positionalOnly && value.startsWith("-")) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git ${operation} option ${value} requires an explicit Zeros adapter`,
        );
      }
      operands.push(value);
    }
    const selectedSources =
      operation === "mv" && operands.length > 1
        ? operands.slice(0, -1)
        : operands;
    if (
      await this.selectedCheckoutPathsTouchDesign(
        cwd,
        selectedSources,
        null,
        signal,
      )
    ) {
      throw new ShadowGitPromotionError(
        "design-impact",
        `Git ${operation} was refused before mutation because its source selection includes protected Design or repository policy state`,
      );
    }
    if (operation === "mv" && operands.length > 1) {
      const destination = path.resolve(cwd, operands.at(-1)!);
      if (!pathInside(destination, this.options.repository.workspaceRoot)) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git mv destination is outside the scoped workspace",
        );
      }
      const relative = path
        .relative(this.options.repository.workspaceRoot, destination)
        .split(path.sep)
        .join("/");
      if (this.repoPathIsProtected(relative)) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "Git mv was refused before mutation because its destination is protected Design or repository policy state",
        );
      }
    }
    return { stdout: "", stderr: "", delegateNative: true };
  }

  private async assertTargetsPreserveDesign(
    targets: readonly string[],
    cwd: string,
    operation: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.protectedPaths.length === 0 || targets.length === 0) return;
    if (!this.headOid) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git merge from an unborn checkout requires an explicit repository-sync operation",
      );
    }
    const expected = await this.protectedSnapshot(
      this.options.repository.gitDir,
      this.headOid,
      signal,
    );
    for (const target of targets) {
      const targetOid = await this.resolveCheckoutCommit(target, cwd, signal);
      if (!targetOid) continue;
      const candidate = await this.protectedSnapshot(
        this.validatorGitDir,
        targetOid,
        signal,
      );
      if (candidate !== expected) {
        throw new ShadowGitPromotionError(
          "design-impact",
          `Git ${operation} was refused before mutation because a target changes protected Design or repository policy state`,
        );
      }
    }
  }

  private async preflightMerge(
    args: readonly string[],
    rawCwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    const cwd = this.scopedCommandCwd(rawCwd);
    const tail = localCommandTail(args, "merge");
    const targets: string[] = [];
    type MergeAction = "merge" | "continue" | "abort" | "quit";
    const mergeActionByOption = new Map<string, MergeAction>([
      ["--continue", "continue"],
      ["--abort", "abort"],
      ["--quit", "quit"],
    ]);
    let action: MergeAction = "merge";
    let strategy: string | null = null;
    let autostash = false;
    let positionalOnly = false;
    const consume = (index: number, option: string): string => {
      const value = tail[index + 1];
      if (!value) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git merge option ${option} is missing its value`,
        );
      }
      return value;
    };
    for (let index = 0; index < tail.length; index += 1) {
      const value = tail[index]!;
      if (!positionalOnly && value === "--") {
        positionalOnly = true;
        continue;
      }
      const selectedAction = !positionalOnly
        ? mergeActionByOption.get(value)
        : undefined;
      if (selectedAction) {
        action = selectedAction;
        continue;
      }
      if (!positionalOnly && (value === "-s" || value === "--strategy")) {
        strategy = consume(index, value);
        index += 1;
        continue;
      }
      if (!positionalOnly && value.startsWith("--strategy=")) {
        strategy = value.slice("--strategy=".length);
        continue;
      }
      if (
        !positionalOnly &&
        [
          "-m",
          "--message",
          "-F",
          "--file",
          "--cleanup",
          "--into-name",
          "-X",
          "--strategy-option",
        ].includes(value)
      ) {
        consume(index, value);
        index += 1;
        continue;
      }
      if (
        !positionalOnly &&
        (value.startsWith("--message=") ||
          value.startsWith("--file=") ||
          value.startsWith("--cleanup=") ||
          value.startsWith("--into-name=") ||
          value.startsWith("--strategy-option="))
      ) {
        continue;
      }
      if (!positionalOnly && value === "--autostash") {
        autostash = true;
        continue;
      }
      if (
        !positionalOnly &&
        ([
          "--ff",
          "--no-ff",
          "--ff-only",
          "--commit",
          "--no-commit",
          "-e",
          "--edit",
          "--no-edit",
          "--log",
          "--no-log",
          "--signoff",
          "--no-signoff",
          "--stat",
          "-n",
          "--no-stat",
          "--compact-summary",
          "--squash",
          "--no-squash",
          "--verify",
          "--no-verify",
          "--verify-signatures",
          "--no-verify-signatures",
          "--no-autostash",
          "--allow-unrelated-histories",
          "--overwrite-ignore",
          "--no-overwrite-ignore",
          "--rerere-autoupdate",
          "--no-rerere-autoupdate",
          "--progress",
          "--no-progress",
          "-q",
          "--quiet",
          "-v",
          "--verbose",
          "-S",
          "--gpg-sign",
          "--no-gpg-sign",
        ].includes(value) ||
          value.startsWith("--log=") ||
          value.startsWith("--gpg-sign=") ||
          /^-S.+/.test(value))
      ) {
        continue;
      }
      if (!positionalOnly && value.startsWith("-")) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git merge option ${value} requires an explicit Zeros adapter`,
        );
      }
      targets.push(value);
    }
    if (
      strategy &&
      !new Set([
        "ort",
        "recursive",
        "resolve",
        "octopus",
        "ours",
        "subtree",
      ]).has(strategy)
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git merge strategy ${strategy} requires an explicit contained adapter`,
      );
    }
    if (action === "quit") {
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if (action === "continue") {
      const raw = await readBoundedRegularFile(
        path.join(this.options.shadowRoot, "MERGE_HEAD"),
        64 * 1024,
      );
      const width = this.options.repository.objectFormat === "sha1" ? 40 : 64;
      const mergeHeads = (raw?.toString("utf8") ?? "")
        .split(/\r?\n/)
        .filter(Boolean);
      if (
        mergeHeads.length === 0 ||
        mergeHeads.some((oid) => !new RegExp(`^[0-9a-f]{${width}}$`).test(oid))
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git merge continuation has no valid private MERGE_HEAD",
        );
      }
      targets.push(...mergeHeads);
    } else if (action === "abort") {
      targets.push("ORIG_HEAD");
    }
    if (strategy !== "ours") {
      await this.assertTargetsPreserveDesign(targets, cwd, "merge", signal);
    }
    if (
      (autostash || action === "abort") &&
      this.headOid &&
      (await this.protectedWorktreeDiffersFrom(this.headOid, cwd, signal))
    ) {
      throw new ShadowGitPromotionError(
        "design-impact",
        "Git merge was refused before mutation because it would stash or overwrite live protected Design state",
      );
    }
    return { stdout: "", stderr: "", delegateNative: true };
  }

  private async commitTouchesProtectedPaths(
    oid: string,
    mainline: number | null,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.protectedPaths.length === 0) return false;
    const resolved = await this.resolveCheckoutCommit(
      oid,
      this.options.repository.workspaceRoot,
      signal,
    );
    if (!resolved) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git could not resolve replay candidate ${oid}`,
      );
    }
    const parentsLine = (
      await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: this.options.repository.workspaceRoot,
        args: ["rev-list", "--parents", "-n", "1", resolved],
        gitDir: this.options.shadowRoot,
        workTree: this.options.repository.workspaceRoot,
        signal,
      })
    ).stdout.trim();
    const [, ...parents] = parentsLine.split(/\s+/);
    if (mainline !== null && (mainline < 1 || mainline > parents.length)) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git replay mainline ${mainline} does not name a parent`,
      );
    }
    if (parents.length === 0) {
      const changed = await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd: this.options.repository.workspaceRoot,
        args: [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--name-only",
          "--no-renames",
          "-r",
          "-z",
          resolved,
          "--",
          ...this.protectedPaths,
        ],
        gitDir: this.options.shadowRoot,
        workTree: this.options.repository.workspaceRoot,
        signal,
      });
      return changed.stdout.length > 0;
    }
    const comparedParents =
      mainline === null ? parents : [parents[mainline - 1]!];
    for (const parentOid of comparedParents) {
      try {
        await runTrustedGit({
          repository: this.options.repository,
          privateHome: this.options.privateHome,
          emptyHooks: this.emptyHooks,
          cwd: this.options.repository.workspaceRoot,
          args: [
            "diff",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            parentOid,
            resolved,
            "--",
            ...this.protectedPaths,
          ],
          gitDir: this.options.shadowRoot,
          workTree: this.options.repository.workspaceRoot,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        const code = (error as { code?: unknown }).code;
        if (code === 1 || code === "1") return true;
        throw error;
      }
    }
    return false;
  }

  private async expandReplayCandidates(
    operands: readonly string[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (operands.length > 10_000) {
      throw new ShadowGitPromotionError(
        "quota-exceeded",
        "Git replay contains too many candidates",
      );
    }
    if (
      operands.some(
        (value) =>
          value.includes("..") ||
          value.startsWith("^") ||
          /\^(?:!|@)$/.test(value),
      )
    ) {
      const output = await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd,
        args: [
          "rev-list",
          "--reverse",
          "--topo-order",
          "--max-count=10001",
          ...operands,
          "--",
        ],
        gitDir: this.options.shadowRoot,
        workTree: this.options.repository.workspaceRoot,
        signal,
      });
      const candidates = output.stdout.split(/\r?\n/).filter(Boolean);
      if (candidates.length > 10_000) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Git replay contains too many candidates",
        );
      }
      return candidates;
    }
    const candidates: string[] = [];
    for (const operand of operands) {
      const oid = await this.resolveCheckoutCommit(operand, cwd, signal);
      if (!oid) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git could not resolve replay candidate ${operand}`,
        );
      }
      candidates.push(oid);
    }
    return candidates;
  }

  private async sequencerReplayCandidates(
    signal: AbortSignal,
  ): Promise<string[]> {
    const todo = await readBoundedRegularFile(
      path.join(this.options.shadowRoot, "sequencer", "todo"),
      4 * 1024 * 1024,
    );
    if (!todo) return [];
    const candidates: string[] = [];
    for (const rawLine of todo.toString("utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^(?:pick|p|revert)\s+([^\s]+)/.exec(line);
      if (!match) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git replay todo contains an unsupported command",
        );
      }
      const oid = await this.resolveCheckoutCommit(
        match[1]!,
        this.options.repository.workspaceRoot,
        signal,
      );
      if (!oid) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git replay todo contains an invalid commit",
        );
      }
      candidates.push(oid);
      if (candidates.length > 10_000) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Git replay todo contains too many commits",
        );
      }
    }
    return candidates;
  }

  private async preflightReplay(
    operation: "cherry-pick" | "revert",
    args: readonly string[],
    rawCwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    const cwd = this.scopedCommandCwd(rawCwd);
    const tail = localCommandTail(args, operation);
    const operands: string[] = [];
    type ReplayAction = "start" | "continue" | "abort" | "quit" | "skip";
    const replayActionByOption = new Map<string, ReplayAction>([
      ["--continue", "continue"],
      ["--abort", "abort"],
      ["--quit", "quit"],
      ["--skip", "skip"],
    ]);
    let action: ReplayAction = "start";
    let mainline: number | null = null;
    let positionalOnly = false;
    const consume = (index: number, option: string): string => {
      const value = tail[index + 1];
      if (!value) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git ${operation} option ${option} is missing its value`,
        );
      }
      return value;
    };
    for (let index = 0; index < tail.length; index += 1) {
      const value = tail[index]!;
      if (!positionalOnly && value === "--") {
        positionalOnly = true;
        continue;
      }
      const selectedAction = !positionalOnly
        ? replayActionByOption.get(value)
        : undefined;
      if (selectedAction) {
        action = selectedAction;
        continue;
      }
      if (!positionalOnly && (value === "-m" || value === "--mainline")) {
        const parsed = Number.parseInt(consume(index, value), 10);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            `Git ${operation} mainline must be a positive integer`,
          );
        }
        mainline = parsed;
        index += 1;
        continue;
      }
      if (!positionalOnly && value.startsWith("--mainline=")) {
        const parsed = Number.parseInt(value.slice("--mainline=".length), 10);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            `Git ${operation} mainline must be a positive integer`,
          );
        }
        mainline = parsed;
        continue;
      }
      if (
        !positionalOnly &&
        ["--strategy", "--strategy-option", "-X", "--cleanup"].includes(value)
      ) {
        consume(index, value);
        index += 1;
        continue;
      }
      if (
        !positionalOnly &&
        (value.startsWith("--strategy=") ||
          value.startsWith("--strategy-option=") ||
          value.startsWith("--cleanup="))
      ) {
        continue;
      }
      if (!positionalOnly && value === "--stdin") {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git ${operation} --stdin requires an explicit Zeros adapter`,
        );
      }
      if (
        !positionalOnly &&
        ([
          "-e",
          "--edit",
          "--no-edit",
          "-n",
          "--no-commit",
          "-x",
          "-s",
          "--signoff",
          "--no-signoff",
          "--ff",
          "--allow-empty",
          "--allow-empty-message",
          "--keep-redundant-commits",
          "--rerere-autoupdate",
          "--no-rerere-autoupdate",
          "-S",
          "--gpg-sign",
          "--no-gpg-sign",
        ].includes(value) ||
          value.startsWith("--empty=") ||
          value.startsWith("--gpg-sign=") ||
          /^-S.+/.test(value))
      ) {
        continue;
      }
      if (!positionalOnly && value.startsWith("-")) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git ${operation} option ${value} requires an explicit Zeros adapter`,
        );
      }
      operands.push(value);
    }
    if (action === "quit") {
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if (action === "abort") {
      await this.assertTargetsPreserveDesign(
        ["ORIG_HEAD"],
        cwd,
        operation,
        signal,
      );
      if (
        this.headOid &&
        (await this.protectedWorktreeDiffersFrom(this.headOid, cwd, signal))
      ) {
        throw new ShadowGitPromotionError(
          "design-impact",
          `Git ${operation} --abort would overwrite live protected Design state`,
        );
      }
      return { stdout: "", stderr: "", delegateNative: true };
    }
    let candidates =
      action === "start"
        ? await this.expandReplayCandidates(operands, cwd, signal)
        : await this.sequencerReplayCandidates(signal);
    if (action === "continue") {
      const activeRef =
        operation === "cherry-pick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD";
      const active = await this.resolveCheckoutCommit(activeRef, cwd, signal);
      if (active) candidates = [active, ...candidates];
    }
    for (const oid of [...new Set(candidates)]) {
      if (await this.commitTouchesProtectedPaths(oid, mainline, signal)) {
        throw new ShadowGitPromotionError(
          "design-impact",
          `Git ${operation} was refused before mutation because a replayed commit changes protected Design or repository policy state`,
        );
      }
    }
    return { stdout: "", stderr: "", delegateNative: true };
  }

  private async rebaseStateCandidates(
    signal: AbortSignal,
  ): Promise<{ candidates: string[]; onto: string | null }> {
    const stateRoots = [
      path.join(this.options.shadowRoot, "rebase-merge"),
      path.join(this.options.shadowRoot, "rebase-apply"),
    ];
    const candidates: string[] = [];
    let onto: string | null = null;
    for (const stateRoot of stateRoots) {
      const ontoRaw = await readBoundedRegularFile(
        path.join(stateRoot, "onto"),
        4_096,
      );
      if (ontoRaw) {
        const resolved = await this.resolveCheckoutCommit(
          ontoRaw.toString("utf8").trim(),
          this.options.repository.workspaceRoot,
          signal,
        );
        if (!resolved) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Git rebase state contains an invalid onto commit",
          );
        }
        onto = resolved;
      }
      for (const name of ["stopped-sha", "original-commit", "current-commit"]) {
        const raw = await readBoundedRegularFile(
          path.join(stateRoot, name),
          4_096,
        );
        if (!raw) continue;
        const resolved = await this.resolveCheckoutCommit(
          raw.toString("utf8").trim(),
          this.options.repository.workspaceRoot,
          signal,
        );
        if (!resolved) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            `Git rebase state contains an invalid ${name}`,
          );
        }
        candidates.push(resolved);
      }
      const todo = await readBoundedRegularFile(
        path.join(stateRoot, "git-rebase-todo"),
        4 * 1024 * 1024,
      );
      if (!todo) continue;
      for (const rawLine of todo.toString("utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const replay =
          /^(?:pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d)\s+([^\s]+)/.exec(
            line,
          );
        const merge = /^merge\s+(?:-[Cc]\s+)?([^\s]+)/.exec(line);
        const candidate = replay?.[1] ?? merge?.[1] ?? null;
        if (
          !candidate &&
          !/^(?:exec|x|break|b|label|l|reset|t|noop|update-ref)\b/.test(line)
        ) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Git rebase todo contains an unsupported command",
          );
        }
        if (!candidate) continue;
        const resolved = await this.resolveCheckoutCommit(
          candidate,
          this.options.repository.workspaceRoot,
          signal,
        );
        if (!resolved) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            "Git rebase todo contains an invalid commit",
          );
        }
        candidates.push(resolved);
        if (candidates.length > 10_000) {
          throw new ShadowGitPromotionError(
            "quota-exceeded",
            "Git rebase todo contains too many commits",
          );
        }
      }
    }
    return { candidates: [...new Set(candidates)], onto };
  }

  private async preflightRebase(
    args: readonly string[],
    rawCwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    const cwd = this.scopedCommandCwd(rawCwd);
    const tail = localCommandTail(args, "rebase");
    const positionals: string[] = [];
    type RebaseAction =
      | "start"
      | "continue"
      | "abort"
      | "quit"
      | "skip"
      | "edit-todo"
      | "show-current-patch";
    const rebaseActionByOption = new Map<string, RebaseAction>([
      ["--continue", "continue"],
      ["--abort", "abort"],
      ["--quit", "quit"],
      ["--skip", "skip"],
      ["--edit-todo", "edit-todo"],
      ["--show-current-patch", "show-current-patch"],
    ]);
    let action: RebaseAction = "start";
    let onto: string | null = null;
    let root = false;
    let keepBase = false;
    let rebaseMerges = false;
    let autostash = false;
    let strategy: string | null = null;
    let positionalOnly = false;
    const consume = (index: number, option: string): string => {
      const value = tail[index + 1];
      if (!value) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git rebase option ${option} is missing its value`,
        );
      }
      return value;
    };
    for (let index = 0; index < tail.length; index += 1) {
      const value = tail[index]!;
      if (!positionalOnly && value === "--") {
        positionalOnly = true;
        continue;
      }
      const selectedAction = !positionalOnly
        ? rebaseActionByOption.get(value)
        : undefined;
      if (selectedAction) {
        action = selectedAction;
        continue;
      }
      if (!positionalOnly && value === "--onto") {
        onto = consume(index, value);
        index += 1;
        continue;
      }
      if (!positionalOnly && value.startsWith("--onto=")) {
        onto = value.slice("--onto=".length);
        continue;
      }
      if (!positionalOnly && value === "--root") {
        root = true;
        continue;
      }
      if (!positionalOnly && value === "--keep-base") {
        keepBase = true;
        continue;
      }
      if (
        !positionalOnly &&
        (value === "-r" ||
          value === "--rebase-merges" ||
          value.startsWith("--rebase-merges="))
      ) {
        rebaseMerges = true;
        continue;
      }
      if (!positionalOnly && value === "--autostash") {
        autostash = true;
        continue;
      }
      if (!positionalOnly && (value === "-s" || value === "--strategy")) {
        strategy = consume(index, value);
        index += 1;
        continue;
      }
      if (!positionalOnly && value.startsWith("--strategy=")) {
        strategy = value.slice("--strategy=".length);
        continue;
      }
      if (
        !positionalOnly &&
        ["-X", "--strategy-option", "-x", "--exec", "--whitespace"].includes(
          value,
        )
      ) {
        consume(index, value);
        index += 1;
        continue;
      }
      if (
        !positionalOnly &&
        (value.startsWith("--strategy-option=") ||
          value.startsWith("--exec=") ||
          value.startsWith("--whitespace=") ||
          value.startsWith("--empty="))
      ) {
        continue;
      }
      if (
        !positionalOnly &&
        ([
          "--apply",
          "-m",
          "--merge",
          "-i",
          "--interactive",
          "-p",
          "--preserve-merges",
          "--fork-point",
          "--no-fork-point",
          "--keep-empty",
          "--no-keep-empty",
          "--reapply-cherry-picks",
          "--no-reapply-cherry-picks",
          "--allow-empty-message",
          "--autosquash",
          "--no-autosquash",
          "--no-autostash",
          "--update-refs",
          "--no-update-refs",
          "--reschedule-failed-exec",
          "--no-reschedule-failed-exec",
          "--committer-date-is-author-date",
          "--reset-author-date",
          "--ignore-whitespace",
          "--signoff",
          "--no-signoff",
          "--stat",
          "--no-stat",
          "--verify",
          "--no-verify",
          "--rerere-autoupdate",
          "--no-rerere-autoupdate",
          "-f",
          "--force-rebase",
          "--no-ff",
          "-q",
          "--quiet",
          "-v",
          "--verbose",
          "-S",
          "--gpg-sign",
          "--no-gpg-sign",
        ].includes(value) ||
          value.startsWith("--gpg-sign=") ||
          /^-S.+/.test(value))
      ) {
        continue;
      }
      if (!positionalOnly && value.startsWith("-")) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git rebase option ${value} requires an explicit Zeros adapter`,
        );
      }
      positionals.push(value);
    }
    if (
      strategy &&
      !new Set(["ort", "recursive", "resolve", "subtree"]).has(strategy)
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git rebase strategy ${strategy} requires an explicit contained adapter`,
      );
    }
    if (
      action === "quit" ||
      action === "edit-todo" ||
      action === "show-current-patch"
    ) {
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if (action === "abort") {
      await this.assertTargetsPreserveDesign(
        ["ORIG_HEAD"],
        cwd,
        "rebase",
        signal,
      );
      if (
        this.headOid &&
        (await this.protectedWorktreeDiffersFrom(this.headOid, cwd, signal))
      ) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "Git rebase --abort would overwrite live protected Design state",
        );
      }
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if (action === "continue" || action === "skip") {
      const state = await this.rebaseStateCandidates(signal);
      if (state.onto) {
        await this.assertTargetsPreserveDesign(
          [state.onto],
          cwd,
          "rebase",
          signal,
        );
      }
      for (const oid of state.candidates) {
        if (await this.commitTouchesProtectedPaths(oid, null, signal)) {
          throw new ShadowGitPromotionError(
            "design-impact",
            "Git rebase continuation was refused because its todo changes protected Design or repository policy state",
          );
        }
      }
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if ((!root && positionals.length > 2) || (root && positionals.length > 1)) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git rebase contains too many revision operands",
      );
    }
    const upstreamName = root ? null : (positionals[0] ?? "@{upstream}");
    const branchName = root
      ? (positionals[0] ?? "HEAD")
      : (positionals[1] ?? "HEAD");
    const branchOid = await this.resolveCheckoutCommit(branchName, cwd, signal);
    const upstreamOid = upstreamName
      ? await this.resolveCheckoutCommit(upstreamName, cwd, signal)
      : null;
    if (!branchOid || (!root && !upstreamOid)) {
      return { stdout: "", stderr: "", delegateNative: true };
    }
    let ontoOid = onto
      ? await this.resolveCheckoutCommit(onto, cwd, signal)
      : upstreamOid;
    if (keepBase && upstreamOid) {
      const mergeBase = await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd,
        args: ["merge-base", upstreamOid, branchOid],
        gitDir: this.options.shadowRoot,
        workTree: this.options.repository.workspaceRoot,
        signal,
      });
      ontoOid = mergeBase.stdout.trim();
    }
    await this.assertTargetsPreserveDesign(
      [branchOid, ...(ontoOid ? [ontoOid] : [])],
      cwd,
      "rebase",
      signal,
    );
    const revisions = [
      "rev-list",
      "--reverse",
      "--topo-order",
      "--max-count=10001",
      ...(rebaseMerges ? [] : ["--no-merges"]),
      branchOid,
      ...(upstreamOid ? ["--not", upstreamOid] : []),
      "--",
    ];
    const replay = await runTrustedGit({
      repository: this.options.repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd,
      args: revisions,
      gitDir: this.options.shadowRoot,
      workTree: this.options.repository.workspaceRoot,
      signal,
    });
    const candidates = replay.stdout.split(/\r?\n/).filter(Boolean);
    if (candidates.length > 10_000) {
      throw new ShadowGitPromotionError(
        "quota-exceeded",
        "Git rebase contains too many replayed commits",
      );
    }
    for (const oid of candidates) {
      if (await this.commitTouchesProtectedPaths(oid, null, signal)) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "Git rebase was refused before mutation because an intermediate commit changes protected Design or repository policy state",
        );
      }
    }
    if (
      autostash &&
      this.headOid &&
      (await this.protectedWorktreeDiffersFrom(this.headOid, cwd, signal))
    ) {
      throw new ShadowGitPromotionError(
        "design-impact",
        "Git rebase --autostash would capture or overwrite live protected Design state",
      );
    }
    return { stdout: "", stderr: "", delegateNative: true };
  }

  private async selectedUntrackedPathsTouchDesign(
    cwd: string,
    pathspecs: readonly string[],
    includeIgnored: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.protectedPaths.length === 0) return false;
    const listArgs = ["ls-files", "-z", "--full-name", "--others"];
    if (!includeIgnored) listArgs.push("--exclude-standard");
    if (pathspecs.length > 0) listArgs.push("--", ...pathspecs);
    const selected = await runTrustedGit({
      repository: this.options.repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd,
      args: listArgs,
      gitDir: this.options.shadowRoot,
      workTree: this.options.repository.workspaceRoot,
      indexFile: path.join(this.options.shadowRoot, "index"),
      signal,
    });
    return selected.stdout
      .split("\0")
      .some((entry) => entry && this.repoPathIsProtected(entry));
  }

  private async validateStashDelta(
    revision: string,
    cwd: string,
    operation: "apply" | "pop" | "branch" | "store",
    signal: AbortSignal,
  ): Promise<void> {
    const stashOid = await this.resolveCheckoutCommit(revision, cwd, signal);
    if (!stashOid) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git stash could not resolve ${revision}`,
      );
    }
    const parentsLine = (
      await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd,
        args: ["rev-list", "--parents", "-n", "1", stashOid],
        gitDir: this.options.shadowRoot,
        workTree: this.options.repository.workspaceRoot,
        signal,
      })
    ).stdout.trim();
    const [, base, indexParent, untrackedParent, ...extraParents] =
      parentsLine.split(/\s+/);
    if (!base || !indexParent || extraParents.length > 0) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git stash candidate does not have the expected bounded commit shape",
      );
    }
    if (
      (await this.revisionsDifferOnProtectedPaths(base, stashOid, signal)) ||
      (await this.revisionsDifferOnProtectedPaths(base, indexParent, signal))
    ) {
      throw new ShadowGitPromotionError(
        "design-impact",
        `Git stash ${operation} was refused before mutation because the stash changes protected Design or repository policy state`,
      );
    }
    if (untrackedParent) {
      const protectedUntracked = await runTrustedGit({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        emptyHooks: this.emptyHooks,
        cwd,
        args: [
          "ls-tree",
          "-r",
          "-z",
          "--name-only",
          untrackedParent,
          "--",
          ...this.protectedPaths,
        ],
        gitDir: this.options.shadowRoot,
        workTree: this.options.repository.workspaceRoot,
        signal,
      });
      if (protectedUntracked.stdout.length > 0) {
        throw new ShadowGitPromotionError(
          "design-impact",
          `Git stash ${operation} was refused before mutation because it contains untracked protected Design state`,
        );
      }
    }
    if (operation === "branch") {
      await this.assertTargetsPreserveDesign(
        [base],
        cwd,
        "stash branch",
        signal,
      );
    }
  }

  private async preflightStash(
    args: readonly string[],
    rawCwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    const cwd = this.scopedCommandCwd(rawCwd);
    const tail = [...localCommandTail(args, "stash")];
    const actions = new Set([
      "push",
      "save",
      "apply",
      "pop",
      "branch",
      "list",
      "show",
      "drop",
      "clear",
      "create",
      "store",
    ]);
    const action = actions.has(tail[0] ?? "") ? tail.shift()! : "push";
    if (["list", "show", "drop", "clear", "create"].includes(action)) {
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if (action === "apply" || action === "pop") {
      const operands = tail.filter(
        (value) => !["--index", "-q", "--quiet"].includes(value),
      );
      if (
        operands.some((value) => value.startsWith("-")) ||
        operands.length > 1
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git stash ${action} contains an unsupported option`,
        );
      }
      await this.validateStashDelta(
        operands[0] ?? "refs/stash",
        cwd,
        action,
        signal,
      );
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if (action === "branch") {
      const operands = tail.filter(
        (value) => !["-q", "--quiet"].includes(value),
      );
      if (operands.length < 1 || operands.length > 2) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git stash branch requires a branch name and at most one stash",
        );
      }
      await this.validateStashDelta(
        operands[1] ?? "refs/stash",
        cwd,
        "branch",
        signal,
      );
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if (action === "store") {
      const operands: string[] = [];
      for (let index = 0; index < tail.length; index += 1) {
        const value = tail[index]!;
        if (value === "-m" || value === "--message") {
          if (!tail[index + 1]) {
            throw new ShadowGitPromotionError(
              "invalid-shadow-repository",
              "Git stash store message is missing",
            );
          }
          index += 1;
          continue;
        }
        if (
          value.startsWith("--message=") ||
          value === "-q" ||
          value === "--quiet"
        ) {
          continue;
        }
        if (value.startsWith("-")) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            `Git stash store option ${value} requires an explicit Zeros adapter`,
          );
        }
        operands.push(value);
      }
      if (operands.length !== 1) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git stash store requires exactly one stash commit",
        );
      }
      await this.validateStashDelta(operands[0]!, cwd, "store", signal);
      return { stdout: "", stderr: "", delegateNative: true };
    }

    const pathspecs: string[] = [];
    let includeUntracked = false;
    let includeIgnored = false;
    let stagedOnly = false;
    let positionalOnly = false;
    for (let index = 0; index < tail.length; index += 1) {
      const value = tail[index]!;
      if (!positionalOnly && value === "--") {
        positionalOnly = true;
        continue;
      }
      if (!positionalOnly && (value === "-m" || value === "--message")) {
        if (!tail[index + 1]) {
          throw new ShadowGitPromotionError(
            "invalid-shadow-repository",
            `Git stash ${action} message is missing`,
          );
        }
        index += 1;
        continue;
      }
      if (!positionalOnly && value.startsWith("--message=")) continue;
      if (
        !positionalOnly &&
        (value === "--pathspec-from-file" ||
          value.startsWith("--pathspec-from-file=") ||
          value === "--pathspec-file-nul")
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Git stash pathspec files require an explicit Zeros adapter",
        );
      }
      if (
        !positionalOnly &&
        (value === "-u" || value === "--include-untracked")
      ) {
        includeUntracked = true;
        continue;
      }
      if (!positionalOnly && (value === "-a" || value === "--all")) {
        includeUntracked = true;
        includeIgnored = true;
        continue;
      }
      if (!positionalOnly && (value === "-S" || value === "--staged")) {
        stagedOnly = true;
        continue;
      }
      if (
        !positionalOnly &&
        [
          "-p",
          "--patch",
          "-k",
          "--keep-index",
          "--no-keep-index",
          "-q",
          "--quiet",
          "--only-untracked",
        ].includes(value)
      ) {
        continue;
      }
      if (!positionalOnly && value.startsWith("-")) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Git stash ${action} option ${value} requires an explicit Zeros adapter`,
        );
      }
      if (action === "save") continue;
      pathspecs.push(value);
    }
    if (pathspecs.length > 0) {
      if (
        await this.selectedCheckoutPathsTouchDesign(
          cwd,
          pathspecs,
          null,
          signal,
        )
      ) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "Git stash was refused before mutation because its path selection includes protected Design or repository policy state",
        );
      }
    } else if (
      stagedOnly
        ? await this.protectedIndexDiffersFrom("HEAD", cwd, signal)
        : await this.protectedWorktreeDiffersFrom("HEAD", cwd, signal)
    ) {
      throw new ShadowGitPromotionError(
        "design-impact",
        "Git stash was refused before mutation because it would capture or overwrite protected Design or repository policy state",
      );
    }
    if (
      includeUntracked &&
      (await this.selectedUntrackedPathsTouchDesign(
        cwd,
        pathspecs,
        includeIgnored,
        signal,
      ))
    ) {
      throw new ShadowGitPromotionError(
        "design-impact",
        "Git stash was refused before mutation because it would capture untracked protected Design state",
      );
    }
    return { stdout: "", stderr: "", delegateNative: true };
  }

  private async preflightCheckout(
    operation: ShadowGitLocalOperation,
    args: readonly string[],
    rawCwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    if (this.protectedPaths.length === 0) {
      return { stdout: "", stderr: "", delegateNative: true };
    }
    const cwd = this.scopedCommandCwd(rawCwd);
    const parsed = checkoutPreflight(args, operation);
    if (parsed.orphan || parsed.force) {
      throw new ShadowGitPromotionError(
        "design-impact",
        `Git ${operation} was refused before mutation because this mode can rewrite protected Design or repository policy paths`,
      );
    }
    if (parsed.pathspecs) {
      if (
        await this.selectedCheckoutPathsTouchDesign(
          cwd,
          parsed.pathspecs,
          parsed.target,
          signal,
        )
      ) {
        throw new ShadowGitPromotionError(
          "design-impact",
          `Git ${operation} was refused before mutation because its path selection includes protected Design or repository policy state`,
        );
      }
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if (!parsed.target) {
      return { stdout: "", stderr: "", delegateNative: true };
    }
    const targetOid = await this.resolveCheckoutCommit(
      parsed.target,
      cwd,
      signal,
    );
    if (!targetOid) {
      // A single checkout operand can also be a path. Expand it using Git's
      // own pathspec rules before allowing the native command to decide.
      if (
        operation === "checkout" &&
        (await this.selectedCheckoutPathsTouchDesign(
          cwd,
          [parsed.target],
          null,
          signal,
        ))
      ) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "Git checkout was refused before mutation because it selects protected Design or repository policy state",
        );
      }
      return { stdout: "", stderr: "", delegateNative: true };
    }
    if (!this.headOid) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        `Git ${operation} from an unborn checkout requires an explicit repository-sync operation`,
      );
    }
    const [expected, candidate] = await Promise.all([
      this.protectedSnapshot(
        this.options.repository.gitDir,
        this.headOid,
        signal,
      ),
      this.protectedSnapshot(this.validatorGitDir, targetOid, signal),
    ]);
    if (expected !== candidate) {
      throw new ShadowGitPromotionError(
        "design-impact",
        `Git ${operation} was refused before mutation because the target changes protected Design or repository policy state`,
      );
    }
    return { stdout: "", stderr: "", delegateNative: true };
  }

  private handleBrokeredGitCommand(
    operation: ShadowGitBrokerOperation,
    args: readonly string[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    if (operation === "checkout" || operation === "switch") {
      return this.preflightCheckout(operation, args, cwd, signal);
    }
    if (operation === "reset") {
      return this.preflightReset(args, cwd, signal);
    }
    if (operation === "restore") {
      return this.preflightRestore(args, cwd, signal);
    }
    if (operation === "clean") {
      return this.preflightClean(args, cwd, signal);
    }
    if (operation === "merge") {
      return this.preflightMerge(args, cwd, signal);
    }
    if (operation === "rm" || operation === "mv") {
      return this.preflightPathMutation(operation, args, cwd, signal);
    }
    if (operation === "cherry-pick" || operation === "revert") {
      return this.preflightReplay(operation, args, cwd, signal);
    }
    if (operation === "rebase") {
      return this.preflightRebase(args, cwd, signal);
    }
    if (operation === "stash") {
      return this.preflightStash(args, cwd, signal);
    }
    return this.handleRemote(operation, args, cwd, signal);
  }

  private handleRemote(
    operation: ShadowGitRemoteOperation,
    args: readonly string[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    if (operation === "push") return this.push(args, cwd, signal);
    if (operation === "fetch") return this.fetch(args, signal);
    return this.pull(args, signal);
  }

  private async recordUpstream(upstream: {
    localBranch: string;
    remoteName: string;
    remoteBranch: string;
  }): Promise<string> {
    const operations = [
      [`branch.${upstream.localBranch}.remote`, upstream.remoteName] as const,
      [
        `branch.${upstream.localBranch}.merge`,
        `refs/heads/${upstream.remoteBranch}`,
      ] as const,
    ];
    try {
      for (const [key, value] of operations) {
        await Promise.all([
          this.git([
            "config",
            "--local",
            "--no-includes",
            "--replace-all",
            key,
            value,
          ]),
          runTrustedGit({
            repository: this.options.repository,
            privateHome: this.options.privateHome,
            emptyHooks: this.emptyHooks,
            cwd: this.options.repository.workspaceRoot,
            args: [
              "config",
              "--local",
              "--no-includes",
              "--replace-all",
              key,
              value,
            ],
            gitDir: this.options.repository.gitDir,
            workTree: this.options.repository.workspaceRoot,
          }),
        ]);
      }
      return "";
    } catch {
      return "warning: push succeeded, but the upstream configuration could not be recorded concurrently\n";
    }
  }

  private async linkedWorktreeCandidates(
    signal?: AbortSignal,
    expectedRefs: ReadonlyMap<string, string> = this.refs,
  ): Promise<LinkedWorktreeCandidate[]> {
    const metadataParent = path.join(this.options.shadowRoot, "worktrees");
    const entries = await readdir(metadataParent, {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (entries.length > MAX_LINKED_WORKTREES) {
      throw new ShadowGitPromotionError(
        "quota-exceeded",
        "The agent created too many linked Git worktrees",
      );
    }
    const boundaryPrivateRoot = path.dirname(this.options.shadowRoot);
    const persistentRoots = [
      this.options.repository.workspaceRoot,
      ...(this.options.additionalWriteRoots ?? []),
    ].map((root) => {
      const absolute = path.resolve(root);
      try {
        return realpathSync(absolute);
      } catch {
        return absolute;
      }
    });
    const denied = (this.options.territory?.writeCapabilities.deniedPaths ?? [])
      .map((candidate) => path.resolve(candidate))
      .map((candidate) => {
        try {
          return realpathSync(candidate);
        } catch {
          return candidate;
        }
      });
    const oidLength = this.options.repository.objectFormat === "sha1" ? 40 : 64;
    const candidates: LinkedWorktreeCandidate[] = [];
    for (const entry of entries) {
      assertCapabilityActive(signal);
      const metadataRoot = path.join(metadataParent, entry.name);
      const metadata = await lstat(metadataRoot);
      if (
        !entry.isDirectory() ||
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        realpathSync(metadataRoot) !== metadataRoot
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Linked Git worktree metadata is not a physical directory",
        );
      }
      const gitdirRaw = await readBoundedRegularFile(
        path.join(metadataRoot, "gitdir"),
        16 * 1024,
      );
      if (!gitdirRaw) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Linked Git worktree metadata has no gitdir backlink",
        );
      }
      const gitdirText = gitdirRaw.toString("utf8");
      if (/\0|\r(?!\n)|\n.+/s.test(gitdirText)) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Linked Git worktree backlink is malformed",
        );
      }
      const gitEntry = path.resolve(
        metadataRoot,
        gitdirText.replace(/\r?\n$/, ""),
      );
      if (path.basename(gitEntry) !== ".git") {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Linked Git worktree backlink does not name a .git entry",
        );
      }
      const worktreeRoot = path.dirname(gitEntry);
      if (pathInside(worktreeRoot, boundaryPrivateRoot)) {
        // A worktree in HOME or scratch is intentionally session-ephemeral.
        continue;
      }
      let canonicalWorktree: string;
      try {
        canonicalWorktree = realpathSync(worktreeRoot);
      } catch {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "A durable linked Git worktree no longer exists",
        );
      }
      if (
        canonicalWorktree !== worktreeRoot ||
        !persistentRoots.some((root) => pathInside(canonicalWorktree, root)) ||
        canonicalWorktree === this.options.repository.workspaceRoot ||
        denied.some(
          (protectedPath) =>
            pathInside(canonicalWorktree, protectedPath) ||
            pathInside(protectedPath, canonicalWorktree),
        )
      ) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "A linked Git worktree is outside durable code territory or overlaps protected Design state",
        );
      }
      const gitEntryMetadata = await lstat(gitEntry);
      if (
        !gitEntryMetadata.isFile() ||
        gitEntryMetadata.isSymbolicLink() ||
        gitEntryMetadata.nlink !== 1 ||
        gitEntryMetadata.size > 16 * 1024
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Linked Git worktree .git state is aliased or malformed",
        );
      }
      const gitEntryRaw = await readFile(gitEntry);
      const pointer = /^gitdir: (.+)\r?\n?$/.exec(gitEntryRaw.toString("utf8"));
      if (
        !pointer ||
        realpathSync(path.resolve(worktreeRoot, pointer[1]!)) !== metadataRoot
      ) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Linked Git worktree .git state does not match its private metadata",
        );
      }
      const headRaw = await readBoundedRegularFile(
        path.join(metadataRoot, "HEAD"),
        4_096,
      );
      if (!headRaw) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Linked Git worktree has no HEAD",
        );
      }
      const headText = headRaw.toString("utf8");
      const symbolic = /^ref: (refs\/heads\/[^\r\n]+)\r?\n?$/.exec(headText);
      const detached = new RegExp(`^([0-9a-f]{${oidLength}})\\r?\\n?$`).exec(
        headText,
      );
      if (!symbolic && !detached) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Linked Git worktree HEAD is malformed",
        );
      }
      const resolved = await this.readHead(metadataRoot, signal);
      const headRef = symbolic?.[1] ?? null;
      const headOid = resolved.oid;
      if (
        resolved.ref !== headRef ||
        (detached && headOid !== detached[1]) ||
        (headRef && headOid && expectedRefs.get(headRef) !== headOid)
      ) {
        throw new ShadowGitPromotionError(
          "concurrent-git-change",
          "Linked Git worktree HEAD changed outside its admitted private refs",
        );
      }
      if (headRef) await this.checkedRef(headRef, "source");
      candidates.push({
        metadataRoot,
        worktreeRoot: canonicalWorktree,
        gitEntry,
        gitEntryDigest: digest(gitEntryRaw)!,
        headRaw,
        headRef,
        headOid,
      });
    }
    return candidates;
  }

  private async pushHeadForCwd(
    rawCwd: string,
    refs: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<{ ref: string | null; oid: string | null }> {
    let cwd: string;
    try {
      cwd = realpathSync(rawCwd);
    } catch {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git push working directory is unavailable",
      );
    }
    const candidates = (await this.linkedWorktreeCandidates(signal, refs))
      .filter((candidate) => pathInside(cwd, candidate.worktreeRoot))
      .sort(
        (left, right) => right.worktreeRoot.length - left.worktreeRoot.length,
      );
    if (candidates.length > 1) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git push working directory belongs to ambiguous linked worktrees",
      );
    }
    if (candidates[0]) {
      return { ref: candidates[0].headRef, oid: candidates[0].headOid };
    }
    if (!pathInside(cwd, this.options.repository.workspaceRoot)) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Git push working directory is outside an admitted worktree",
      );
    }
    const head = await this.readHead(this.options.shadowRoot, signal);
    if (head.ref && head.oid && refs.get(head.ref) !== head.oid) {
      throw new ShadowGitPromotionError(
        "concurrent-git-change",
        "Git push HEAD changed outside its admitted private refs",
      );
    }
    return head;
  }

  private async prepareLinkedWorktreeIndex(
    candidate: LinkedWorktreeCandidate,
    signal?: AbortSignal,
  ): Promise<Buffer | null> {
    const indexPath = path.join(candidate.metadataRoot, "index");
    const original = await readBoundedRegularFile(indexPath, MAX_INDEX_BYTES);
    if (!original) return null;
    if (this.protectedPaths.length > 0) {
      const result = candidate.headOid
        ? await runTrustedGit({
            repository: this.options.repository,
            privateHome: this.options.privateHome,
            emptyHooks: this.emptyHooks,
            cwd: candidate.worktreeRoot,
            args: [
              "diff-index",
              "--cached",
              "--name-only",
              "-z",
              "--no-renames",
              "--ignore-submodules=all",
              candidate.headOid,
              "--",
              ...this.protectedPaths,
            ],
            gitDir: candidate.metadataRoot,
            workTree: candidate.worktreeRoot,
            indexFile: indexPath,
            signal,
          })
        : await runTrustedGit({
            repository: this.options.repository,
            privateHome: this.options.privateHome,
            emptyHooks: this.emptyHooks,
            cwd: candidate.worktreeRoot,
            args: ["ls-files", "--stage", "-z", "--", ...this.protectedPaths],
            gitDir: candidate.metadataRoot,
            workTree: candidate.worktreeRoot,
            indexFile: indexPath,
            signal,
          });
      if (result.stdout.length > 0) {
        throw new ShadowGitPromotionError(
          "design-impact",
          "A linked Git worktree index stages protected Design or policy state",
        );
      }
    }
    await runTrustedGit({
      repository: this.options.repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd: candidate.worktreeRoot,
      args: ["update-index", "--no-split-index"],
      gitDir: candidate.metadataRoot,
      workTree: candidate.worktreeRoot,
      indexFile: indexPath,
      signal,
    });
    const { stdout } = await runTrustedGit({
      repository: this.options.repository,
      privateHome: this.options.privateHome,
      emptyHooks: this.emptyHooks,
      cwd: candidate.worktreeRoot,
      args: ["ls-files", "--stage", "-z"],
      gitDir: candidate.metadataRoot,
      workTree: candidate.worktreeRoot,
      indexFile: indexPath,
      signal,
    });
    const oidLength = this.options.repository.objectFormat === "sha1" ? 40 : 64;
    const syntheticEntries: string[] = [];
    for (const record of stdout.split("\0")) {
      if (!record) continue;
      const match = new RegExp(
        `^([0-7]{6}) ([0-9a-f]{${oidLength}}) ([0-3])\\t`,
      ).exec(record);
      if (!match) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Linked Git worktree index contains malformed entries",
        );
      }
      const mode = match[1]!;
      const type = mode === "160000" ? "commit" : "blob";
      syntheticEntries.push(
        `${mode} ${type} ${match[2]}\titem-${String(syntheticEntries.length).padStart(8, "0")}`,
      );
      if (syntheticEntries.length > MAX_PRIVATE_OBJECT_FILES) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Linked Git worktree index contains too many entries",
        );
      }
    }
    if (syntheticEntries.length > 0) {
      const tree = (
        await runTrustedGit({
          repository: this.options.repository,
          privateHome: this.options.privateHome,
          emptyHooks: this.emptyHooks,
          cwd: candidate.worktreeRoot,
          args: ["mktree", "--missing"],
          gitDir: candidate.metadataRoot,
          input: `${syntheticEntries.join("\n")}\n`,
          signal,
        })
      ).stdout.trim();
      const carrier = (
        await runTrustedGit({
          repository: this.options.repository,
          privateHome: this.options.privateHome,
          emptyHooks: this.emptyHooks,
          cwd: candidate.worktreeRoot,
          args: ["commit-tree", tree],
          gitDir: candidate.metadataRoot,
          input: "Zeros linked-worktree index carrier\n",
          env: {
            GIT_AUTHOR_NAME: "Zeros",
            GIT_AUTHOR_EMAIL: "noreply@zeros.local",
            GIT_AUTHOR_DATE: "@0 +0000",
            GIT_COMMITTER_NAME: "Zeros",
            GIT_COMMITTER_EMAIL: "noreply@zeros.local",
            GIT_COMMITTER_DATE: "@0 +0000",
          },
          signal,
        })
      ).stdout.trim();
      await this.validateObjects([carrier], signal);
      await this.importObjects(
        [["linked-worktree-index", null, carrier]],
        signal,
      );
    }
    const metadata = await lstat(indexPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > MAX_INDEX_BYTES
    ) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Linked Git worktree index is aliased or oversized",
      );
    }
    return readFile(indexPath);
  }

  private async copyLinkedWorktreeState(
    candidate: LinkedWorktreeCandidate,
    destination: string,
  ): Promise<void> {
    const allowed = new Set([
      "ORIG_HEAD",
      "MERGE_HEAD",
      "MERGE_MSG",
      "MERGE_MODE",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "AUTO_MERGE",
      "SQUASH_MSG",
      "REBASE_HEAD",
      "BISECT_LOG",
      "BISECT_START",
      "locked",
      "logs",
      "info",
      "sequencer",
      "rebase-merge",
      "rebase-apply",
    ]);
    let files = 0;
    let bytes = 0;
    const copyEntry = async (
      source: string,
      target: string,
      depth: number,
    ): Promise<void> => {
      if (depth > 16) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Linked Git worktree metadata is too deep",
        );
      }
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink()) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Linked Git worktree metadata contains a symbolic link",
        );
      }
      if (metadata.isDirectory()) {
        await mkdir(target, { mode: 0o700 });
        for (const entry of await readdir(source, { withFileTypes: true })) {
          if (entry.name.endsWith(".lock")) continue;
          await copyEntry(
            path.join(source, entry.name),
            path.join(target, entry.name),
            depth + 1,
          );
        }
        return;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          "Linked Git worktree metadata contains aliased or non-regular state",
        );
      }
      files += 1;
      bytes += metadata.size;
      if (
        files > MAX_LINKED_WORKTREE_METADATA_FILES ||
        bytes > MAX_LINKED_WORKTREE_METADATA_BYTES
      ) {
        throw new ShadowGitPromotionError(
          "quota-exceeded",
          "Linked Git worktree metadata exceeds the promotion quota",
        );
      }
      await writeFile(target, await readFile(source), {
        mode: 0o600,
        flag: "wx",
      });
    };
    for (const name of allowed) {
      const source = path.join(candidate.metadataRoot, name);
      try {
        await copyEntry(source, path.join(destination, name), 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const worktreeConfig = path.join(candidate.metadataRoot, "config.worktree");
    if (existsSync(worktreeConfig)) {
      const { stdout } = await runFile(
        this.options.repository.gitBinary,
        ["config", "--file", worktreeConfig, "--null", "--list"],
        {
          cwd: candidate.worktreeRoot,
          timeoutMs: 10_000,
          maxBufferBytes: MAX_CONFIG_BYTES,
          env: trustedGitEnvironment(this.options.privateHome),
        },
      );
      await writeSanitizedConfig({
        repository: this.options.repository,
        privateHome: this.options.privateHome,
        destination: path.join(destination, "config.worktree"),
        entries: parseConfigList(stdout),
      });
    }
  }

  /** Promote linked-worktree identity only after the owning process domain is
   * proven empty. Ref/object promotion remains available after each turn, but
   * rewriting a live worktree's .git pointer would otherwise make subsequent
   * commands escape the session-private common directory. */
  async finalizeLinkedWorktrees(signal?: AbortSignal): Promise<number> {
    if (this.stopped) throw new Error("shadow Git session is stopped");
    assertCapabilityActive(signal);
    return withPromotionLock(this.options.repository, async () => {
      const candidates = await this.linkedWorktreeCandidates(signal);
      if (candidates.length === 0) return 0;
      const worktreesRoot = await physicalDirectory(
        this.options.repository.commonDir,
        ["worktrees"],
      );
      let finalized = 0;
      for (const candidate of candidates) {
        assertCapabilityActive(signal);
        if (candidate.headOid) {
          const commit = await this.peelCommit(
            this.validatorGitDir,
            candidate.headOid,
            signal,
          );
          if (commit !== candidate.headOid) {
            throw new ShadowGitPromotionError(
              "invalid-shadow-repository",
              "Linked Git worktree HEAD is not a commit",
            );
          }
          if (this.headOid && this.protectedPaths.length > 0) {
            const [expected, actual] = await Promise.all([
              this.protectedSnapshot(
                this.options.repository.gitDir,
                this.headOid,
                signal,
              ),
              this.protectedSnapshot(
                this.validatorGitDir,
                candidate.headOid,
                signal,
              ),
            ]);
            if (expected !== actual) {
              throw new ShadowGitPromotionError(
                "design-impact",
                "A linked Git worktree HEAD changes protected Design or policy state",
              );
            }
          }
          await this.validateObjects([candidate.headOid], signal);
          await this.importObjects(
            [["linked-worktree-head", null, candidate.headOid]],
            signal,
          );
        }
        const index = await this.prepareLinkedWorktreeIndex(candidate, signal);
        const identity = createHash("sha256")
          .update(candidate.worktreeRoot)
          .update("\0")
          .update(this.options.generation)
          .digest("hex")
          .slice(0, 24);
        const destination = path.join(worktreesRoot, `zeros-${identity}`);
        const pointer = await stageReplacement(
          candidate.gitEntry,
          candidate.gitEntryDigest,
          Buffer.from(`gitdir: ${destination}\n`),
          16 * 1024,
          randomUUID(),
        );
        let destinationCreated = false;
        try {
          await mkdir(destination, { mode: 0o700 });
          destinationCreated = true;
          await Promise.all([
            writeFile(path.join(destination, "commondir"), "../..\n", {
              mode: 0o600,
              flag: "wx",
            }),
            writeFile(
              path.join(destination, "gitdir"),
              `${candidate.gitEntry}\n`,
              { mode: 0o600, flag: "wx" },
            ),
            writeFile(path.join(destination, "HEAD"), candidate.headRaw, {
              mode: 0o600,
              flag: "wx",
            }),
            ...(index
              ? [
                  writeFile(path.join(destination, "index"), index, {
                    mode: 0o600,
                    flag: "wx",
                  }),
                ]
              : []),
          ]);
          await this.copyLinkedWorktreeState(candidate, destination);
          await syncDirectory(destination);
          await syncDirectory(worktreesRoot);
          await pointer.commit();
          finalized += 1;
        } catch (error) {
          await pointer.abort().catch(() => undefined);
          if (destinationCreated) {
            await rm(destination, { recursive: true, force: true }).catch(
              () => undefined,
            );
          }
          throw error;
        }
      }
      return finalized;
    });
  }

  private async inspectCandidate(signal?: AbortSignal): Promise<{
    candidateRefs: Map<string, string>;
    candidateHead: { ref: string | null; oid: string | null };
    changedRefs: Array<readonly [string, string | null, string | null]>;
  }> {
    assertCapabilityActive(signal);
    const candidateRefState = await this.snapshotRefState(
      this.options.shadowRoot,
      signal,
    );
    const candidateRefs = candidateRefState.refs;
    if (!sameStringMap(candidateRefState.symbolicRefs, this.symbolicRefs)) {
      throw new ShadowGitPromotionError(
        "invalid-shadow-repository",
        "Shadow Git attempted to change symbolic ref ownership",
      );
    }
    const allNames = new Set([...this.refs.keys(), ...candidateRefs.keys()]);
    const changedRefs: Array<readonly [string, string | null, string | null]> =
      [];
    for (const ref of [...allNames].sort()) {
      const before = this.refs.get(ref) ?? null;
      const after = candidateRefs.get(ref) ?? null;
      if (before !== after && !this.symbolicRefs.has(ref)) {
        changedRefs.push([ref, before, after]);
      }
    }
    const candidateHead = await this.readHead(this.options.shadowRoot, signal);
    for (const [ref] of changedRefs) {
      if (!allowedPromotedRef(ref)) {
        throw new ShadowGitPromotionError(
          "invalid-shadow-repository",
          `Shadow Git attempted to update unsupported ref ${ref}`,
        );
      }
    }
    const newOids = [
      ...new Set(changedRefs.flatMap(([, , oid]) => (oid ? [oid] : []))),
    ];
    await this.validateObjects(newOids, signal);
    await this.validateDesign(changedRefs, signal);
    await this.validateHeadTransition(candidateHead, signal);
    return { candidateRefs, candidateHead, changedRefs };
  }

  private async push(
    args: readonly string[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<ShadowGitRemoteResult> {
    if (this.stopped) throw new Error("shadow Git session is stopped");
    assertCapabilityActive(signal);
    const parsed = parseShadowGitPushArgs(args);
    const dryRun =
      parsed.flags.includes("--dry-run") || parsed.flags.includes("-n");
    // Validation is the mandatory authorization point. A real push CAS-promotes
    // first; a dry-run performs the identical object/index/Design validation
    // but deliberately leaves canonical refs, HEAD, and index untouched.
    const inspected = dryRun
      ? await withPromotionLock(this.options.repository, () =>
          this.inspectCandidate(signal),
        )
      : null;
    if (!dryRun) await this.synchronize(signal);
    assertCapabilityActive(signal);
    const refs = inspected?.candidateRefs ?? this.refs;
    const commandHead = await this.pushHeadForCwd(cwd, refs, signal);
    const headRef = commandHead.ref;
    const remote = await this.resolvePushRemote(parsed.remote, headRef);
    if (remote.kind === "native") {
      return { stdout: "", stderr: "", delegateNative: true };
    }
    // LFS pre-push needs the exact old remote tips to compute the same bounded
    // object ranges as a native Git hook. Reuse that advertisement for leases,
    // prune, mirror, and follow-tags validation too.
    const remoteRefs = await this.advertisedRemoteRefs(remote, signal);
    const exact = await this.exactPushRefspecs(
      parsed,
      remote.name,
      refs,
      headRef,
      remoteRefs,
    );
    const refspecs = parsed.followTags
      ? [
          ...exact.refspecs,
          ...(await this.followTagRefspecs(
            refs,
            exact.refspecs,
            remoteRefs,
            signal,
          )),
        ]
      : exact.refspecs;
    await this.validateOutboundPush(refspecs, signal);
    await this.pushLfsObjects(remote, refspecs, remoteRefs, dryRun, signal);
    const result = await this.runScopedRemote(
      remote,
      [
        "push",
        ...parsed.flags,
        ...exact.leaseFlags,
        "--",
        remote.url,
        ...refspecs,
      ],
      {
        gitDir: this.validatorGitDir,
        timeoutMs: 15 * 60_000,
        signal,
      },
    );
    assertCapabilityActive(signal);
    const warning =
      exact.upstream && !dryRun
        ? await this.recordUpstream(exact.upstream)
        : "";
    return { stdout: result.stdout, stderr: `${result.stderr}${warning}` };
  }

  async synchronize(signal?: AbortSignal): Promise<ShadowGitPromotionResult> {
    if (this.stopped) throw new Error("shadow Git session is stopped");
    assertCapabilityActive(signal);
    return withPromotionLock(this.options.repository, async () => {
      const { candidateRefs, candidateHead, changedRefs } =
        await this.inspectCandidate(signal);
      assertCapabilityActive(signal);
      await this.importObjects(changedRefs, signal);
      await this.promoteLfsObjects(signal);
      assertCapabilityActive(signal);
      const candidateHeadRaw = candidateHead.ref
        ? Buffer.from(`ref: ${candidateHead.ref}\n`)
        : candidateHead.oid
          ? Buffer.from(`${candidateHead.oid}\n`)
          : null;
      const transactionId = randomUUID();
      const headReplacement = await stageReplacement(
        path.join(this.options.repository.gitDir, "HEAD"),
        this.canonicalHeadDigest,
        candidateHeadRaw,
        4096,
        transactionId,
      );
      let indexReplacement: StagedReplacement;
      try {
        indexReplacement = await this.stageIndex(transactionId);
      } catch (error) {
        await headReplacement.abort();
        throw error;
      }
      const journalPath = path.join(
        promotionJournalRoot(this.options.repository),
        `${transactionId}.json`,
      );
      const journal: GitPromotionJournal = {
        version: 1,
        transactionId,
        workspaceHash: promotionWorkspaceHash(this.options.repository),
        generation: this.options.generation,
        state: "prepared",
        refs: changedRefs.map(([name, before, after]) => ({
          name,
          before,
          after,
        })),
        head: stagedReplacementRecord(headReplacement),
        index: stagedReplacementRecord(indexReplacement),
      };
      try {
        await this.options.promotionCheckpointForTesting?.(
          "replacements-staged",
        );
        await writePromotionJournal(journalPath, journal);
        await this.options.promotionCheckpointForTesting?.("journal-prepared");
        assertCapabilityActive(signal);
      } catch (error) {
        if (isSimulatedCrash(error)) throw error;
        await Promise.all([headReplacement.abort(), indexReplacement.abort()]);
        await removePromotionJournal(journalPath).catch(() => undefined);
        throw error;
      }
      try {
        await this.updateCanonicalRefs(changedRefs, signal);
      } catch (error) {
        await Promise.all([headReplacement.abort(), indexReplacement.abort()]);
        await removePromotionJournal(journalPath).catch(() => undefined);
        throw error;
      }
      try {
        await this.options.promotionCheckpointForTesting?.("refs-committed");
        const refsCommitted = { ...journal, state: "refs-committed" as const };
        await writePromotionJournal(journalPath, refsCommitted);
        await headReplacement.commit();
        await this.options.promotionCheckpointForTesting?.("head-committed");
        const headCommitted = {
          ...journal,
          state: "head-committed" as const,
        };
        await writePromotionJournal(journalPath, headCommitted);
        await indexReplacement.commit();
        await this.options.promotionCheckpointForTesting?.("index-committed");
        await removePromotionJournal(journalPath);
      } catch (error) {
        if (isSimulatedCrash(error)) throw error;
        try {
          // Re-read/infer canonical ref state and idempotently finish the exact
          // journal. Never roll refs back after their atomic CAS committed.
          await this.recoverPromotionJournal(journalPath, journal);
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "Git promotion requires journal recovery",
          );
        }
      }
      const indexUpdated = indexReplacement.changed;
      this.refs = candidateRefs;
      this.headRef = candidateHead.ref;
      this.headOid = candidateHead.oid;
      this.canonicalHeadDigest = digest(candidateHeadRaw);
      this.canonicalIndexDigest = digest(
        await readBoundedRegularFile(
          path.join(this.options.shadowRoot, "index"),
          MAX_INDEX_BYTES,
        ),
      );
      return {
        state: changedRefs.length > 0 || indexUpdated ? "promoted" : "clean",
        updatedRefs: changedRefs.length,
        indexUpdated,
      };
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.revokeRemoteCapability();
  }

  async revokeRemoteCapability(): Promise<void> {
    const broker = this.remoteBroker;
    this.remoteBroker = null;
    if (broker) await broker.close();
    const cleanupResults = await Promise.allSettled(
      [...this.stagedFetches.keys()].map((cleanupId) =>
        this.cleanupStagedFetch(cleanupId),
      ),
    );
    const failures = cleanupResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "staged Git fetch cleanup failed");
    }
  }

  async preserveForRecovery(reason: unknown): Promise<string> {
    this.stopped = true;
    const workspaceKey = createHash("sha256")
      .update(this.options.repository.workspaceRoot)
      .digest("hex")
      .slice(0, 24);
    const recoveryId = `${workspaceKey}-${this.options.generation}`;
    const recoveryRoot = path.join(zerosDataDir(), "recovery", "shadow-git");
    const destination = path.join(recoveryRoot, recoveryId);
    const recoveryGitRoot = path.join(destination, "git");
    const manifestPath = path.join(destination, "manifest.json");
    const sessionRoot = sessionRootForShadowRoot(this.options.shadowRoot);
    await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
    await chmod(recoveryRoot, 0o700);
    await mkdir(destination, { recursive: false, mode: 0o700 });
    await chmod(destination, 0o700);
    await writeRecoveryHold(sessionRoot, recoveryId, manifestPath);
    const base = {
      version: SHADOW_RECOVERY_VERSION,
      recoveryId,
      workspaceRoot: this.options.repository.workspaceRoot,
      workspaceHash: promotionWorkspaceHash(this.options.repository),
      generation: this.options.generation,
      createdAt: Date.now(),
      reason:
        reason instanceof ShadowGitPromotionError
          ? reason.code
          : ("promotion-failed" as const),
      sessionRoot,
      sourceRoot: this.options.shadowRoot,
      recoveryGitRoot,
    } as const;
    await withPromotionLock(this.options.repository, async () => {
      let candidates: LinkedWorktreeCandidate[];
      try {
        candidates = await this.linkedWorktreeCandidates();
      } catch {
        // Unknown or malicious metadata can make it impossible to enumerate
        // every external .git pointer safely. Preserve the original session
        // tree in place and leave a durable hold; deleting or renaming it here
        // would turn a recoverable worktree into a broken one.
        const manual: ShadowGitRecoveryManifest = {
          ...base,
          state: "manual",
          completedPointers: 0,
          pointers: [],
        };
        await writeAtomicJson(manifestPath, manual);
        return;
      }
      const pointers: ShadowGitRecoveryPointer[] = candidates.map(
        (candidate) => {
          const relative = path.relative(
            this.options.shadowRoot,
            candidate.metadataRoot,
          );
          if (
            !relative ||
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            throw new ShadowGitPromotionError(
              "invalid-shadow-repository",
              "Linked worktree recovery metadata escaped private Git state",
            );
          }
          const recoveryMetadata = path.join(recoveryGitRoot, relative);
          const after = Buffer.from(`gitdir: ${recoveryMetadata}\n`);
          return {
            gitEntry: candidate.gitEntry,
            sourceMetadata: candidate.metadataRoot,
            recoveryMetadata,
            beforeDigest: candidate.gitEntryDigest,
            afterDigest: digest(after)!,
          };
        },
      );
      let manifest: ShadowGitRecoveryManifest = {
        ...base,
        state: "copying",
        completedPointers: 0,
        pointers,
      };
      await writeAtomicJson(manifestPath, manifest);
      if (pointers.length === 0) {
        await rename(this.options.shadowRoot, recoveryGitRoot);
        await syncDirectory(destination);
      } else {
        await copyShadowRecoveryTree(this.options.shadowRoot, recoveryGitRoot);
      }
      manifest = { ...manifest, state: "ready" };
      await writeAtomicJson(manifestPath, manifest);
      await this.options.promotionCheckpointForTesting?.("recovery-copy-ready");
      for (let index = 0; index < pointers.length; index += 1) {
        const record = pointers[index]!;
        const replacement = await stageReplacement(
          record.gitEntry,
          record.beforeDigest,
          Buffer.from(`gitdir: ${record.recoveryMetadata}\n`),
          16 * 1024,
          randomUUID(),
        );
        try {
          await replacement.commit();
        } catch (error) {
          await replacement.abort().catch(() => undefined);
          throw error;
        }
        manifest = {
          ...manifest,
          state: "pointers-updating",
          completedPointers: index + 1,
        };
        await writeAtomicJson(manifestPath, manifest);
        await this.options.promotionCheckpointForTesting?.(
          "recovery-pointer-committed",
        );
      }
      if (existsSync(this.options.shadowRoot)) {
        await rm(this.options.shadowRoot, { recursive: true, force: true });
        await syncDirectory(path.dirname(this.options.shadowRoot));
      }
      await this.options.promotionCheckpointForTesting?.(
        "recovery-source-removed",
      );
      manifest = { ...manifest, state: "finalized" };
      await writeAtomicJson(manifestPath, manifest);
      await removeRecoveryHold(sessionRoot, recoveryId);
    });
    return recoveryId;
  }
}

function validateShadowRecoveryManifest(
  value: unknown,
  entryRoot: string,
): ShadowGitRecoveryManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Shadow Git recovery manifest is invalid");
  }
  const manifest = value as Partial<ShadowGitRecoveryManifest>;
  const states = new Set([
    "copying",
    "ready",
    "pointers-updating",
    "finalized",
    "manual",
  ]);
  const expectedGitRoot = path.join(entryRoot, "git");
  const sessionsRoot = path.join(zerosDataDir(), "sessions");
  if (
    manifest.version !== SHADOW_RECOVERY_VERSION ||
    manifest.recoveryId !== path.basename(entryRoot) ||
    typeof manifest.workspaceRoot !== "string" ||
    !path.isAbsolute(manifest.workspaceRoot) ||
    typeof manifest.workspaceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.workspaceHash) ||
    typeof manifest.generation !== "string" ||
    !UUID_V4_PATTERN.test(manifest.generation) ||
    !Number.isSafeInteger(manifest.createdAt) ||
    Number(manifest.createdAt) < 0 ||
    !new Set([
      "concurrent-git-change",
      "design-impact",
      "invalid-shadow-repository",
      "quota-exceeded",
      "promotion-failed",
    ]).has(manifest.reason ?? "") ||
    typeof manifest.sessionRoot !== "string" ||
    !path.isAbsolute(manifest.sessionRoot) ||
    !pathInside(manifest.sessionRoot, sessionsRoot) ||
    manifest.sessionRoot === sessionsRoot ||
    typeof manifest.sourceRoot !== "string" ||
    !path.isAbsolute(manifest.sourceRoot) ||
    !pathInside(manifest.sourceRoot, manifest.sessionRoot) ||
    path.basename(manifest.sourceRoot) !== "git" ||
    manifest.recoveryGitRoot !== expectedGitRoot ||
    !states.has(manifest.state ?? "") ||
    !Number.isSafeInteger(manifest.completedPointers) ||
    Number(manifest.completedPointers) < 0 ||
    !Array.isArray(manifest.pointers) ||
    manifest.pointers.length > MAX_LINKED_WORKTREES ||
    Number(manifest.completedPointers) > manifest.pointers.length
  ) {
    throw new Error("Shadow Git recovery manifest has an unsupported contract");
  }
  const seen = new Set<string>();
  for (const pointer of manifest.pointers) {
    if (
      !pointer ||
      typeof pointer !== "object" ||
      typeof pointer.gitEntry !== "string" ||
      !path.isAbsolute(pointer.gitEntry) ||
      path.basename(pointer.gitEntry) !== ".git" ||
      seen.has(pointer.gitEntry) ||
      typeof pointer.sourceMetadata !== "string" ||
      !pathInside(pointer.sourceMetadata, manifest.sourceRoot) ||
      pointer.sourceMetadata === manifest.sourceRoot ||
      typeof pointer.recoveryMetadata !== "string" ||
      !pathInside(pointer.recoveryMetadata, expectedGitRoot) ||
      pointer.recoveryMetadata === expectedGitRoot ||
      path.relative(manifest.sourceRoot, pointer.sourceMetadata) !==
        path.relative(expectedGitRoot, pointer.recoveryMetadata) ||
      !/^[a-f0-9]{64}$/.test(pointer.beforeDigest) ||
      !/^[a-f0-9]{64}$/.test(pointer.afterDigest)
    ) {
      throw new Error("Shadow Git recovery pointer is invalid");
    }
    const expectedAfter = digest(
      Buffer.from(`gitdir: ${pointer.recoveryMetadata}\n`),
    );
    if (pointer.afterDigest !== expectedAfter) {
      throw new Error("Shadow Git recovery pointer digest is invalid");
    }
    seen.add(pointer.gitEntry);
  }
  return manifest as ShadowGitRecoveryManifest;
}

async function recoverShadowGitManifest(
  manifestPath: string,
  initial: ShadowGitRecoveryManifest,
): Promise<"recovered" | "preserved" | "settled"> {
  if (initial.state === "manual") return "preserved";
  if (initial.state === "finalized") {
    if (!existsSync(initial.recoveryGitRoot)) return "preserved";
    for (const pointer of initial.pointers) {
      const current = await readBoundedRegularFile(pointer.gitEntry, 16 * 1024);
      if (digest(current) !== pointer.afterDigest) return "preserved";
    }
    await removeRecoveryHold(initial.sessionRoot, initial.recoveryId);
    return "settled";
  }
  const repository = await discoverCanonicalGitRepository(
    initial.workspaceRoot,
  ).catch(() => null);
  if (
    !repository ||
    promotionWorkspaceHash(repository) !== initial.workspaceHash
  ) {
    return "preserved";
  }
  return withPromotionLock(repository, async () => {
    let manifest = initial;
    const sourceExists = () => existsSync(manifest.sourceRoot);
    const recoveryExists = () => existsSync(manifest.recoveryGitRoot);
    if (manifest.state === "copying") {
      if (manifest.pointers.length === 0) {
        if (sourceExists()) {
          if (recoveryExists()) {
            await rm(manifest.recoveryGitRoot, {
              recursive: true,
              force: true,
            });
          }
          await rename(manifest.sourceRoot, manifest.recoveryGitRoot);
          await syncDirectory(path.dirname(manifest.recoveryGitRoot));
        } else if (!recoveryExists()) {
          return "preserved";
        }
      } else {
        if (!sourceExists()) return "preserved";
        if (recoveryExists()) {
          await rm(manifest.recoveryGitRoot, {
            recursive: true,
            force: true,
          });
        }
        await copyShadowRecoveryTree(
          manifest.sourceRoot,
          manifest.recoveryGitRoot,
        );
      }
      manifest = { ...manifest, state: "ready", completedPointers: 0 };
      await writeAtomicJson(manifestPath, manifest);
    }
    if (!recoveryExists()) return "preserved";
    for (let index = 0; index < manifest.pointers.length; index += 1) {
      const pointer = manifest.pointers[index]!;
      const current = await readBoundedRegularFile(pointer.gitEntry, 16 * 1024);
      const currentDigest = digest(current);
      if (currentDigest === pointer.afterDigest) continue;
      if (currentDigest !== pointer.beforeDigest) return "preserved";
      const replacement = await stageReplacement(
        pointer.gitEntry,
        pointer.beforeDigest,
        Buffer.from(`gitdir: ${pointer.recoveryMetadata}\n`),
        16 * 1024,
        randomUUID(),
      );
      try {
        await replacement.commit();
      } catch (error) {
        await replacement.abort().catch(() => undefined);
        throw error;
      }
      manifest = {
        ...manifest,
        state: "pointers-updating",
        completedPointers: Math.max(manifest.completedPointers, index + 1),
      };
      await writeAtomicJson(manifestPath, manifest);
    }
    if (sourceExists()) {
      await rm(manifest.sourceRoot, { recursive: true, force: true });
      await syncDirectory(path.dirname(manifest.sourceRoot));
    }
    manifest = {
      ...manifest,
      state: "finalized",
      completedPointers: manifest.pointers.length,
    };
    await writeAtomicJson(manifestPath, manifest);
    await removeRecoveryHold(manifest.sessionRoot, manifest.recoveryId);
    return "recovered";
  });
}

/** Finish crash-consistent linked-worktree preservation before dead session
 * GC runs. At every persisted phase either the original private Git tree or
 * its recovery copy remains reachable from every durable worktree. Malformed
 * evidence is retained for manual recovery and never deleted automatically. */
export async function recoverShadowGitPreservations(): Promise<ShadowGitRecoveryResult> {
  const root = path.join(zerosDataDir(), "recovery", "shadow-git");
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  let recovered = 0;
  let preserved = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      preserved += 1;
      continue;
    }
    const entryRoot = path.join(root, entry.name);
    const manifestPath = path.join(entryRoot, "manifest.json");
    try {
      const rootMetadata = await lstat(entryRoot);
      const manifestMetadata = await lstat(manifestPath);
      if (
        !rootMetadata.isDirectory() ||
        rootMetadata.isSymbolicLink() ||
        realpathSync(entryRoot) !== entryRoot ||
        (rootMetadata.mode & 0o077) !== 0 ||
        !manifestMetadata.isFile() ||
        manifestMetadata.isSymbolicLink() ||
        manifestMetadata.nlink !== 1 ||
        (manifestMetadata.mode & 0o077) !== 0
      ) {
        throw new Error("Shadow Git recovery metadata is unsafe");
      }
      const bytes = await readBoundedRegularFile(manifestPath, 1024 * 1024);
      if (!bytes) throw new Error("Shadow Git recovery manifest is absent");
      const manifest = validateShadowRecoveryManifest(
        JSON.parse(bytes.toString("utf8")),
        entryRoot,
      );
      const outcome = await recoverShadowGitManifest(manifestPath, manifest);
      if (outcome === "recovered") recovered += 1;
      else if (outcome === "preserved") preserved += 1;
      // An atomic manifest rewrite can leave only pre-rename temporaries after
      // a crash. Once a valid canonical manifest exists, they are orphans.
      for (const candidate of await readdir(entryRoot, {
        withFileTypes: true,
      })) {
        if (!/^\.manifest\.json\.[0-9a-f-]+\.tmp$/.test(candidate.name)) {
          continue;
        }
        const temporary = path.join(entryRoot, candidate.name);
        const metadata = await lstat(temporary);
        if (metadata.isFile() && !metadata.isSymbolicLink()) {
          await rm(temporary, { force: true });
        }
      }
    } catch {
      preserved += 1;
    }
  }
  return {
    discovered: entries.length,
    recovered,
    active: 0,
    preserved,
  };
}

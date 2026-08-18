import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, lstatSync, type BigIntStats } from "node:fs";
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
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

import {
  zerosChannelDataDir,
  zerosDataDir,
  zerosStateRoot,
} from "../../db/paths";
import { openSqlite } from "../../db/sqlite";
import { defaultMacClaudeOAuthAuthority } from "./claude-oauth-authority";
import { PROVIDER_HOME_RECOVERY_HOLD_FILE } from "../session-paths";

const MAX_FILES = 20_000;
const MAX_TREE_ENTRIES = 50_000;
const MAX_TREE_DEPTH = 128;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const LOCK_WAIT_MS = 60_000;
const LOCK_RETRY_MS = 25;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const CREDENTIAL_SOURCE_FILE = "credential-source.json";
const MAX_RESUME_SCAN_ENTRIES = 50_000;
const MAX_RESUME_SEED_FILES = 64;
const MAX_DURABLE_RESUME_METADATA_READS = 512;
const MAX_SESSION_META_BYTES = 256 * 1024;
const MAX_RECOVERY_HOLD_BYTES = 64 * 1024 * 1024;
const MAX_RECOVERY_SNAPSHOT_ENTRIES = 100_000;
const MAX_RECOVERY_MANAGED_PATHS = 16;
const MAX_RECOVERY_DENIED_ROOTS = 16_384;
const ARCHIVE_DIRECTORIES = ["conflicts", "recovery"] as const;
const ARCHIVE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ARCHIVES_PER_ROOT = 32;
const UNUSED_PROJECTION_RETENTION_MS = 24 * 60 * 60 * 1000;
const DIGEST_MANIFEST_FILE = "digest-manifest.json";
const MAX_DIGEST_MANIFEST_ENTRIES = 50_000;
const MAX_DIGEST_MANIFEST_BYTES = 32 * 1024 * 1024;
/** A file whose timestamps are this fresh could still be rewritten inside the
 * same clock tick that produced them, so its digest is recomputed instead of
 * remembered. Steady-state provider state is far older than this. */
const DIGEST_SETTLE_MS = 2_000;

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
  /** Paths relative to this managed root that are rebuildable runtime state.
   * They are never imported, persisted, or included in merge accounting. */
  readonly excluded?: readonly string[];
  /** Additional host-only exclusions. Session/project stores created inside a
   * ZSR HOME remain durable, but an unrelated global history is not cloned
   * into every workspace or short-lived authentication probe. */
  readonly seedExcluded?: readonly string[];
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
  /** Canonical engine/private roots that host-seed symlinks may never enter. */
  readonly deniedSourceRoots: readonly string[];
  /** Canonical host roots exposed read-only through links in the private HOME.
   * These are compatibility inputs, never promotion destinations. */
  readonly readOnlyHostRoots: readonly string[];
  readonly baselineLocal: ReadonlyMap<string, EntrySnapshot>;
  readonly baselineHost: ReadonlyMap<string, EntrySnapshot>;
  readonly baselinePersistent: ReadonlyMap<string, DurableEntrySnapshot>;
  /** Filesystem identities proven while this generation's private HOME was
   * materialized, so promotion re-hashes only what the session actually
   * changed. Deliberately not part of the crash-recovery marker: a rebuilt
   * overlay simply hashes everything again. */
  readonly projectedDigests?: ReadonlyMap<string, string>;
  readonly preparationConflicts: readonly string[];
  /** The identity of the reusable world this projection was built from — every
   * input to its content, and nothing belonging to one session. `undefined`
   * means no build identity was resolvable, so parking is unavailable. */
  readonly stamp?: string;
  /** Whether a prewarmed world for `stamp` was waiting to be adopted. Reported
   * per admission, because a park rate that quietly falls to zero is the whole
   * failure mode of this optimization. */
  readonly parked?: "hit" | "miss";
  readonly env: Readonly<Record<string, string>>;
  /** Engine-only capability. It never crosses into the child environment. */
  readonly credentialSource?: ActiveCredentialSource;
  /** Credential-file path omitted for an explicit API-key/token generation.
   * Provider writes at this path must not cross back into CLI-auth state. */
  readonly suppressedCredentialRelative?: string;
}

export interface ProviderHomePromotionResult {
  readonly conflicts: readonly string[];
  readonly updatedFiles: number;
}

interface ProviderHomeRecoveryHold {
  readonly version: 1;
  readonly providerId: string;
  readonly workspaceRoot: string;
  readonly persistentKey: string;
  readonly managed: readonly ManagedPath[];
  readonly deniedSourceRoots: readonly string[];
  readonly baselineLocal: readonly (readonly [string, EntrySnapshot])[];
  readonly baselineHost: readonly (readonly [string, EntrySnapshot])[];
  readonly baselinePersistent: readonly (readonly [
    string,
    DurableEntrySnapshot,
  ])[];
  readonly credentialSource?: {
    readonly relative: string;
    readonly fallbackSnapshot?: EntrySnapshot;
  };
  readonly suppressedCredentialRelative?: string;
}

export interface ProviderHomeRecoveryResult {
  readonly discovered: number;
  readonly recovered: number;
  readonly preserved: number;
  readonly conflicts: number;
}

export interface ProviderHomeStorageSweepResult {
  readonly archivesRemoved: number;
  readonly projectionsReclaimed: number;
  /** Projections left untouched because their state could not be read well
   * enough to prove reclaiming them would lose nothing. */
  readonly retained: number;
  /** Parked provider worlds reclaimed: crash debris from an interrupted build
   * or claim, and worlds nothing has adopted for longer than the retention. */
  readonly parkedWorldsReclaimed: number;
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
    // OAuth token store for remote MCP servers, shared by every provider: an
    // `npx mcp-remote <url>` entry in a provider's MCP config keeps its tokens
    // in `$HOME/.mcp-auth/mcp-remote-<version>/` (getConfigDir(), overridable
    // only by MCP_REMOTE_CONFIG_DIR).
    //
    // A contained session is HEADLESS, and this store is what decides whether
    // that matters. With valid tokens the bridge connects and the turn proceeds.
    // Without them the server raises UnauthorizedError, starts a browser
    // authorization flow, and blocks in `waitForAuthCode()` for a redirect that
    // can never arrive — so the provider's MCP connect budget (60s in
    // @cursor/sdk, `connectTimeoutMs`) expires, the server is SIGTERMed, and the
    // user's FIRST message waits the whole 60s for a server that then isn't
    // there. Measured at 62.0s per session, every session.
    //
    // Projected read-WRITE and promoted, not linked read-only like the caches
    // below, because the flow rewrites this directory: refreshed tokens, a code
    // verifier, and a coordination lockfile. Promotion is the point — it is what
    // makes authorizing ONCE on the host stick. Without it a re-auth would land
    // in a per-session HOME and be discarded at teardown, so every session would
    // pay the timeout forever no matter how often the user re-authenticated.
    //
    // This does place MCP bearer tokens inside the boundary. That is the same
    // class of secret `.cursor/mcp.json` already carries there (an `http` server
    // entry holds its credentials in `headers`), and it is the credential for
    // precisely the server the user configured this agent to call — so it grants
    // the capability that was already intended, not a wider one. Contrast
    // `.cursor/sdk/auth.json` below, which stays excluded because Zeros supplies
    // Cursor's own credential itself and no session needs the account key.
    //
    // Note the version namespacing: tokens written by mcp-remote X are invisible
    // to mcp-remote Y. Pair this with the `.npm` cache links below, which keep a
    // session resolving the same cached copy the host authorized with.
    { source: path.join(hostHome, ".mcp-auth"), relative: ".mcp-auth" },
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
        excluded: [
          // Housekeeping bookkeeping, both regenerated on demand and both
          // observed in this engine's own conflict archives: `.last-cleanup`
          // is the timestamp of the CLI's transcript prune, and the MCP cache
          // records which servers asked for authentication.
          ".last-cleanup",
          "cache",
          "debug",
          "downloads",
          "mcp-needs-auth-cache.json",
          "shell-snapshots",
          "statsig",
          "telemetry",
        ],
        seedExcluded: ["projects"],
      },
      { source: path.join(hostHome, ".claude.json"), relative: ".claude.json" },
    );
  } else if (providerId === "codex") {
    paths.push({
      source: absoluteEnvPath(env, "CODEX_HOME", path.join(hostHome, ".codex")),
      relative: ".codex",
      excluded: [
        ".tmp",
        "cache",
        "log",
        "logs.sqlite",
        "logs.sqlite-shm",
        "logs.sqlite-wal",
        "logs_2.sqlite",
        "logs_2.sqlite-shm",
        "logs_2.sqlite-wal",
        // Regenerated by `model/list`; two live Codex app-servers rewrite it
        // with request-time metadata and would otherwise create a false
        // same-file promotion conflict on every concurrent admission.
        "models_cache.json",
        "packages",
        path.join("plugins", ".plugin-appserver"),
        path.join("plugins", ".remote-plugin-install-staging"),
        "tmp",
        "worktrees",
        "state_5.sqlite",
        "state_5.sqlite-shm",
        "state_5.sqlite-wal",
      ],
      seedExcluded: ["archived_sessions", "sessions"],
    });
  } else if (providerId === "cursor") {
    paths.push(
      {
        source: path.join(hostHome, ".cursor"),
        relative: ".cursor",
        excluded: [
          "ai-tracking",
          "cache",
          "extensions",
          "logs",
          "tmp",
          "worktrees",
          // @cursor/sdk 1.0.28 added `Cursor.auth.login()`, which mints a
          // 90-day account API key and persists it here
          // (getDefaultSdkAuthPath). Zeros authenticates Cursor from its own
          // settings (CURSOR_API_KEY) and never calls that flow, so projecting
          // the file would only ever COPY an account credential into Zeros'
          // durable provider-state store — and promoting one back would let a
          // contained agent write a credential into it. Neither is anything the
          // product needs, so the path is excluded in both directions.
          path.join("sdk", "auth.json"),
          // The cursor-agent CLI's own conversation history. Zeros' Cursor
          // sessions are SDK local agents whose conversation state lives in the
          // private JSONL store (adapters/cursor-sdk/state-overlay.ts), and
          // `Agent.resume` addresses it by agent id — nothing on any Zeros path
          // reads these two directories. They were merely NOT SEEDED from the
          // host, which still left the accumulated durable copy to be projected
          // (and re-hashed) into every session HOME: measured at ~35 MiB, the
          // single largest per-admission Cursor cost, for state no session can
          // use. Excluded outright, in both directions.
          //
          // Claude and Codex keep their history projected-on-resume instead
          // (`scopedHistory` below) because for them the transcript IS the
          // resume source and must be present for the exact conversation.
          "acp-sessions",
          "chats",
        ],
        // `projects/<slug(cwd)>` is real SDK project state (settings scope plus
        // the `agent-transcripts` a session's subagents write), so it stays
        // durable and projected. It is not seeded from the host: a session must
        // start from Zeros' own durable copy, not the user's editor scratch.
        seedExcluded: ["projects"],
      },
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
    paths.push(
      { source: path.join(config, "opencode"), relative: ".config/opencode" },
      {
        source: path.join(data, "opencode"),
        relative: ".local/share/opencode",
        excluded: ["log", "logs"],
      },
      {
        source: path.join(state, "opencode"),
        relative: ".local/state/opencode",
      },
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
    const authority = defaultMacClaudeOAuthAuthority(hostHome);
    return authority ? () => authority.readProjectedCredential() : undefined;
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

function normalizedCredentialBytes(raw: string, providerId?: string): Buffer {
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
  if (providerId === "claude") {
    const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
    if (oauth && typeof oauth === "object" && !Array.isArray(oauth)) {
      const projectedOauth = { ...(oauth as Record<string, unknown>) };
      delete projectedOauth.refreshToken;
      parsed = {
        ...(parsed as Record<string, unknown>),
        claudeAiOauth: projectedOauth,
      };
    }
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
    // npm's package caches, for the same reason as .cargo/registry — but this
    // one is load-bearing rather than a convenience. A stdio MCP server is
    // conventionally declared as `npx <package>` (the user's ~/.cursor/mcp.json
    // and its Claude/Codex equivalents all take that shape), and a provider
    // spawns them while the user's FIRST message waits. With no cache reachable
    // from the projected HOME, that npx re-resolves and re-downloads the package
    // from the registry through the boundary's proxy on EVERY session; measured
    // against `npx mcp-remote`, it overran the provider's 60s MCP startup budget
    // and was SIGTERMed, so the server never started AND the first turn paid 62s
    // for it. Warm, it is ~3s and the server actually comes up.
    //
    // Only the two caches are linked, never `.npm` itself: npm writes `_logs`
    // and `_update-notifier-last-checked` into `$HOME/.npm`, which must stay an
    // ordinary writable directory in the contained HOME. Same split as
    // `.cargo/{bin,registry,git}` above, and it keeps every write inside the
    // boundary while reads come from the host's already-populated cache.
    path.join(".npm", "_npx"),
    path.join(".npm", "_cacache"),
    path.join(".local", "bin"),
    path.join(".local", "share", "mise"),
    path.join(".local", "share", "pnpm"),
    path.join(".local", "share", "zinit"),
  ].map((relative) => ({ source: path.join(hostHome, relative), relative }));
}

function workspaceKey(
  providerId: string,
  stateScope: string,
  hostHome: string,
): string {
  return createHash("sha256")
    .update(`${providerId}\0${stateScope}\0${path.resolve(hostHome)}`)
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

/** What a managed root deliberately keeps out of the merge. `paths` are
 * prefixes relative to the managed root — the shape a specific directory or
 * file needs. `names` match a basename wherever it appears beneath the root,
 * which is what a *family* of provider-generated sidecars needs: enumerating
 * paths has already fallen behind reality once (see `CHURN_ARTIFACT_NAMES`). */
interface ManagedExclusions {
  readonly paths: readonly string[];
  readonly names: readonly RegExp[];
}

const NO_MANAGED_EXCLUSIONS: ManagedExclusions = { paths: [], names: [] };

/** Basenames that are rebuildable runtime state under any managed root.
 *
 * SQLite's write-ahead log, shared-memory index and rollback journal are state
 * of an *open* database rather than state in their own right: a clean close
 * checkpoints `-wal` into the database and removes both sidecars, and SQLite's
 * own guidance is that they must never be copied beside a live database.
 * Projecting them is therefore the *unsafe* option, not the faithful one — a
 * database plus a sidecar captured at a different instant can be torn, while
 * the database alone is always valid at its last checkpoint.
 *
 * They are also, measured on the Mac, **92 % of every "concurrent provider HOME
 * conflict" this engine has ever reported** (102 of 111 archived conflicts
 * across two data dirs, including all four distinct tombstone conflicts). The
 * cycle is structural: a session's provider opens the database, SQLite creates
 * the sidecars, and on close deletes them — so promotion records a tombstone for
 * a path the host still holds, and the next admission finds host != recorded
 * base with a durable tombstone. That is a conflict, an archive copy and a reset
 * of private descendants on every admission, forever. Enumerated paths cannot
 * fix it: the list already carries `logs.sqlite*`, `logs_2.sqlite*` and
 * `state_5.sqlite*`, and Codex has since added `goals_1`, `memories_1` and
 * `queue_1`. The family is the unit, so the family is what is matched.
 *
 * Deliberately anchored to a database extension so an ordinary file that merely
 * ends in `-journal` is untouched. Never global: a `RegExp` with `g` carries
 * `lastIndex` across `test` calls and would match every other candidate. */
const CHURN_ARTIFACT_NAMES: readonly RegExp[] = [
  /\.(?:sqlite|sqlite3|db)-(?:wal|shm|journal)$/,
];

function managedExclusions(
  item: ManagedPath,
  includeSeedExclusions: boolean,
): ManagedExclusions {
  return {
    paths: [
      ...(item.excluded ?? []),
      ...(includeSeedExclusions ? (item.seedExcluded ?? []) : []),
    ]
      .map((relative) => assertSafeRelative(relative))
      .sort((left, right) => left.localeCompare(right)),
    names: CHURN_ARTIFACT_NAMES,
  };
}

function withExcludedPaths(
  exclusions: ManagedExclusions,
  extra: readonly string[],
): ManagedExclusions {
  if (extra.length === 0) return exclusions;
  return {
    paths: [...exclusions.paths, ...extra.map(assertSafeRelative)].sort(
      (left, right) => left.localeCompare(right),
    ),
    names: exclusions.names,
  };
}

/** Per-conversation history stores. They are never seeded from the host, stay
 * durable once created inside a boundary, and are projected only for the
 * conversation a session actually resumes: a brand-new session must not pay to
 * copy — or hash — every transcript the workspace has ever accumulated. */
function historyRoots(item: ManagedPath): readonly string[] {
  return (item.seedExcluded ?? []).map((relative) =>
    assertSafeRelative(relative),
  );
}

function isExcludedManagedPath(
  relative: string,
  exclusions: ManagedExclusions,
): boolean {
  if (!relative) return false;
  const normalized = assertSafeRelative(relative);
  if (
    exclusions.paths.some(
      (excluded) =>
        normalized === excluded ||
        normalized.startsWith(`${excluded}${path.sep}`),
    )
  ) {
    return true;
  }
  const name = path.basename(normalized);
  return exclusions.names.some((pattern) => pattern.test(name));
}

/** Change detection for provider-state hashing. A content digest is remembered
 * against the exact filesystem identity that produced it, so an admission
 * re-reads only what actually changed instead of re-hashing the whole provider
 * tree — including every accumulated transcript — on every session.
 *
 * This is a cache, never an authority. A miss recomputes the real digest, and
 * the worst a stale hit can do is make a merge treat an already-private change
 * as unchanged; it never chooses the bytes written to any destination, and it
 * lives inside the same engine-private directory as the state it describes. */
interface ContentDigests {
  lookup(identity: string): string | undefined;
  remember(identity: string, digest: string): void;
}

interface PersistentContentDigests extends ContentDigests {
  persist(): Promise<void>;
}

/** The identity a remembered digest is keyed by.
 *
 * ctime is part of it because a contained child may move mtime backwards, but
 * any write also moves ctime forward, so modified content can never present the
 * identity recorded for its previous bytes.
 *
 * The timestamps are **nanoseconds**, which is why this needs `bigint` stats:
 * the millisecond fields cannot distinguish two writes inside one clock tick,
 * and a projection that is reused across sessions trusts its recorded identities
 * across time rather than for the few milliseconds between one copy and the
 * snapshot that immediately follows it. The same millisecond trap was caught by
 * a test in the OrbStack bundle memo. `v2:` makes every millisecond-keyed entry
 * left in a persisted manifest provably non-matching instead of relying on the
 * two magnitudes never colliding. */
function contentIdentity(stat: BigIntStats): string {
  return [
    "v2",
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.mode,
  ].join(":");
}

function knownContentDigests(
  record: ReadonlyMap<string, string>,
): ContentDigests {
  return {
    lookup: (identity) => record.get(identity),
    remember: () => undefined,
  };
}

async function readDigestManifest(root: string): Promise<Map<string, string>> {
  const manifestPath = path.join(root, DIGEST_MANIFEST_FILE);
  try {
    const metadata = await lstat(manifestPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > MAX_DIGEST_MANIFEST_BYTES ||
      (metadata.mode & 0o077) !== 0
    ) {
      await rm(manifestPath, { force: true });
      return new Map();
    }
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version?: unknown;
      entries?: unknown;
    };
    if (
      parsed.version !== 1 ||
      !parsed.entries ||
      typeof parsed.entries !== "object" ||
      Array.isArray(parsed.entries)
    ) {
      return new Map();
    }
    const entries = new Map<string, string>();
    for (const [identity, digest] of Object.entries(
      parsed.entries as Record<string, unknown>,
    )) {
      if (entries.size >= MAX_DIGEST_MANIFEST_ENTRIES) break;
      if (typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)) {
        entries.set(identity, digest);
      }
    }
    return entries;
  } catch {
    // Change detection must never fail an admission. An unreadable or
    // malformed manifest simply means everything is hashed again this time.
    return new Map();
  }
}

async function writeDigestManifest(
  root: string,
  observed: ReadonlyMap<string, string>,
): Promise<void> {
  const entries = [...observed];
  const retained =
    entries.length > MAX_DIGEST_MANIFEST_ENTRIES
      ? entries.slice(entries.length - MAX_DIGEST_MANIFEST_ENTRIES)
      : entries;
  const target = path.join(root, DIGEST_MANIFEST_FILE);
  const temporary = path.join(root, `.digest-manifest.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ version: 1, entries: Object.fromEntries(retained) })}\n`,
      "utf8",
    );
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporary, target);
}

/** Open the durable projection's change-detection manifest. Entries are only
 * retained while they are still observed, so the manifest tracks the provider
 * tree instead of growing with every file that ever existed. */
async function openDigestManifest(
  root: string,
): Promise<PersistentContentDigests> {
  const loaded = await readDigestManifest(root);
  const observed = new Map<string, string>();
  return {
    lookup(identity) {
      const digest = loaded.get(identity) ?? observed.get(identity);
      if (digest) observed.set(identity, digest);
      return digest;
    },
    remember(identity, digest) {
      observed.set(identity, digest);
    },
    async persist() {
      if (observed.size === 0) return;
      if (
        observed.size === loaded.size &&
        [...observed].every(
          ([identity, digest]) => loaded.get(identity) === digest,
        )
      ) {
        return;
      }
      await writeDigestManifest(root, observed);
    },
  };
}

/** How many sibling entries a tree walk may have in flight.
 *
 * The walkers are syscall-bound, not CPU-bound: a warm admission re-materializes
 * thousands of small provider-state files and the digest manifest has already
 * removed the hashing, so what remains is one `lstat`/`copyFile`/`chmod` round
 * trip at a time. Overlapping siblings keeps the queue full without becoming
 * the kind of unbounded fan-out that would starve the rest of the engine. */
const TREE_WALK_CONCURRENCY = 32;

/** How many managed ROOTS (`.claude`, `.codex`, `.cursor`, …) are projected at
 * once. Each root is an independent walk that is itself `TREE_WALK_CONCURRENCY`
 * wide, so this multiplies: 4 × 32 is a full queue without becoming the
 * unbounded fan-out the walker bound exists to prevent. Overlapping roots is
 * safe because `providerManagedPaths` returns mutually disjoint relatives — no
 * root is a prefix of another — so two walks never write the same destination,
 * and the only paths they share are ancestors created with a recursive `mkdir`
 * that tolerates losing the race. Kept smaller than the walker bound because
 * the win is queue depth on one disk, not parallelism. */
const MANAGED_ROOT_CONCURRENCY = 4;

/** Run `work` over `items` with at most `limit` in flight, preserving input
 * order in the result. The first rejection wins and the remaining work is
 * abandoned, which matches the old sequential behaviour of throwing out of the
 * loop. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length <= 1) {
    return items.length === 0 ? [] : [await work(items[0]!, 0)];
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (!failed) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        try {
          results[index] = await work(items[index]!, index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Sibling entries of one directory, at the walker's own bound. */
function mapTreeEntries<T, R>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return mapBounded(items, TREE_WALK_CONCURRENCY, work);
}

/** The chain of directories currently being walked ABOVE this node.
 *
 * This used to be one shared `Set` mutated on the way down and cleaned up on
 * the way out, which is only equivalent to an ancestor chain while the walk is
 * strictly sequential. With siblings overlapping, two of them resolving to the
 * same directory — entirely legal, e.g. two symlinks into one plugin dir —
 * would see each other in that set and report a cycle that does not exist. A
 * cycle means an ANCESTOR repeats, so the chain is passed down explicitly. */
type WalkAncestors = ReadonlySet<string>;

function descendInto(ancestors: WalkAncestors, key: string): WalkAncestors {
  const next = new Set(ancestors);
  next.add(key);
  return next;
}

async function copyTree(
  source: string,
  destination: string,
  exclusions: ManagedExclusions = NO_MANAGED_EXCLUSIONS,
  options: {
    readonly materializeSymlinks?: boolean;
    readonly deniedRoots?: readonly string[];
    /** Digests already proven for the source tree. Every file copied from a
     * proven source records its written identity, so the private HOME's merge
     * baseline is derived from work already done instead of a second full
     * hashing pass over bytes this process just wrote. */
    readonly known?: {
      readonly digests: ReadonlyMap<string, DurableEntrySnapshot>;
      readonly prefix: string;
      readonly record: Map<string, string>;
    };
  } = {},
): Promise<void> {
  let files = 0;
  let entriesSeen = 0;
  let totalBytes = 0;
  // Destinations this walk created itself. A directory it just made is known
  // to be empty, so the per-file `rm` that used to guard against a stale
  // destination is a guaranteed miss — one wasted syscall on every file of
  // every admission. Keep it only where the destination could pre-exist.
  const freshDestinations = new Set<string>();
  const visit = async (
    from: string,
    to: string,
    relative = "",
    depth = 0,
    ancestors: WalkAncestors = new Set<string>(),
  ): Promise<void> => {
    if (isExcludedManagedPath(relative, exclusions)) return;
    if (depth > MAX_TREE_DEPTH) {
      throw new Error("provider overlay exceeds its bounded directory depth");
    }
    let stat;
    try {
      stat = await lstat(from);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    entriesSeen += 1;
    if (entriesSeen > MAX_TREE_ENTRIES) {
      throw new Error("provider overlay has too many filesystem entries");
    }
    if (stat.isSymbolicLink()) {
      if (options.materializeSymlinks) {
        let target: string;
        try {
          target = await realpath(from);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (
          path.dirname(target) === target ||
          (options.deniedRoots ?? []).some(
            (denied) =>
              pathIsInsideOrEqual(target, denied) ||
              pathIsInsideOrEqual(denied, target),
          )
        ) {
          throw new Error(
            "provider state symlink overlaps a denied or filesystem root",
          );
        }
        if (ancestors.has(comparisonPath(target))) {
          throw new Error("provider state contains a symbolic-link cycle");
        }
        await visit(target, to, relative, depth, ancestors);
        return;
      }
      files += 1;
      if (files > MAX_FILES)
        throw new Error("provider overlay has too many files");
      await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      if (!freshDestinations.has(path.dirname(to))) {
        await rm(to, { recursive: true, force: true });
      }
      await symlink(await readlink(from), to);
      return;
    }
    if (stat.isDirectory()) {
      const directoryKey = comparisonPath(await realpath(from));
      if (ancestors.has(directoryKey)) {
        throw new Error("provider state contains a directory cycle");
      }
      const descendants = descendInto(ancestors, directoryKey);
      let destinationExisted = true;
      try {
        const destinationStat = await lstat(to);
        if (
          !destinationStat.isDirectory() ||
          destinationStat.isSymbolicLink()
        ) {
          await rm(to, { recursive: true, force: true });
          destinationExisted = false;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        destinationExisted = false;
      }
      await mkdir(to, { recursive: true, mode: 0o700 });
      await chmod(to, 0o700);
      if (!destinationExisted) freshDestinations.add(to);
      const entries = await readdir(from, { withFileTypes: true });
      await mapTreeEntries(entries, (entry) =>
        visit(
          path.join(from, entry.name),
          path.join(to, entry.name),
          relative ? path.join(relative, entry.name) : entry.name,
          depth + 1,
          descendants,
        ),
      );
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
    if (!freshDestinations.has(path.dirname(to))) {
      await rm(to, { recursive: true, force: true });
    }
    // Clone-on-write when the filesystem supports it (APFS): provider state
    // trees are re-materialized on every admission, and reflinks turn that
    // from a full byte copy into metadata work. The fallback is a plain copy.
    await copyFile(from, to, fsConstants.COPYFILE_FICLONE);
    await chmod(to, safeFileMode(stat.mode));
    const known = options.known;
    if (known) {
      const proven = known.digests.get(
        relative ? path.join(known.prefix, relative) : known.prefix,
      );
      if (proven?.kind === "file") {
        // Nothing but this engine can write into the destination before the
        // boundary is handed to a child, so the bytes just copied are exactly
        // the bytes the source snapshot proved.
        known.record.set(
          contentIdentity(await lstat(to, { bigint: true })),
          proven.digest,
        );
      }
    }
  };
  await visit(source, destination);
}

async function snapshotManaged(
  root: string | null,
  managed: readonly ManagedPath[],
  includeSeedExclusions = false,
  options: {
    readonly materializeSymlinks?: boolean;
    readonly deniedRoots?: readonly string[];
    readonly digests?: ContentDigests;
  } = {},
): Promise<Map<string, EntrySnapshot>> {
  const result = new Map<string, EntrySnapshot>();
  let files = 0;
  let entriesSeen = 0;
  let totalBytes = 0;
  const visit = async (
    absolute: string,
    relative: string,
    relativeToManagedRoot: string,
    exclusions: ManagedExclusions,
    depth = 0,
    ancestors: WalkAncestors = new Set<string>(),
  ): Promise<EntrySnapshot | undefined> => {
    if (isExcludedManagedPath(relativeToManagedRoot, exclusions)) {
      return undefined;
    }
    if (depth > MAX_TREE_DEPTH) {
      throw new Error("provider overlay exceeds its bounded directory depth");
    }
    let stat;
    try {
      // `bigint` for the nanosecond timestamps `contentIdentity` needs. Every
      // other field is read back through `Number`, which is exact for a mode, a
      // provider-state file size and a millisecond epoch.
      stat = await lstat(absolute, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    entriesSeen += 1;
    if (entriesSeen > MAX_TREE_ENTRIES) {
      throw new Error("provider overlay has too many filesystem entries");
    }
    if (stat.isSymbolicLink()) {
      if (options.materializeSymlinks) {
        let target: string;
        try {
          target = await realpath(absolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
        if (
          path.dirname(target) === target ||
          (options.deniedRoots ?? []).some(
            (denied) =>
              pathIsInsideOrEqual(target, denied) ||
              pathIsInsideOrEqual(denied, target),
          )
        ) {
          throw new Error(
            "provider state symlink overlaps a denied or filesystem root",
          );
        }
        if (ancestors.has(comparisonPath(target))) {
          throw new Error("provider state contains a symbolic-link cycle");
        }
        return visit(
          target,
          relative,
          relativeToManagedRoot,
          exclusions,
          depth,
          ancestors,
        );
      }
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
      const directoryKey = options.materializeSymlinks
        ? comparisonPath(await realpath(absolute))
        : undefined;
      if (directoryKey && ancestors.has(directoryKey)) {
        throw new Error("provider state contains a directory cycle");
      }
      const descendants = directoryKey
        ? descendInto(ancestors, directoryKey)
        : ancestors;
      const entries = await readdir(absolute, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      // Siblings are walked concurrently but folded back in the sorted order
      // above, because the directory digest below is order-sensitive and is
      // what change detection compares across admissions.
      const visited = await mapTreeEntries(entries, (entry) =>
        visit(
          path.join(absolute, entry.name),
          path.join(relative, entry.name),
          relativeToManagedRoot
            ? path.join(relativeToManagedRoot, entry.name)
            : entry.name,
          exclusions,
          depth + 1,
          descendants,
        ),
      );
      const children: Array<readonly [string, EntrySnapshot]> = [];
      for (let index = 0; index < entries.length; index += 1) {
        const child = visited[index];
        if (child) children.push([entries[index]!.name, child]);
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
    totalBytes += Number(stat.size);
    if (
      files > MAX_FILES ||
      Number(stat.size) > MAX_FILE_BYTES ||
      totalBytes > MAX_TOTAL_BYTES
    ) {
      throw new Error("provider overlay exceeds its bounded snapshot quota");
    }
    const identity = contentIdentity(stat);
    const remembered = options.digests?.lookup(identity);
    const digest =
      remembered ??
      createHash("sha256")
        .update(await readFile(absolute))
        .digest("hex");
    if (!remembered && options.digests) {
      const now = Date.now();
      if (
        now - Number(stat.mtimeMs) > DIGEST_SETTLE_MS &&
        now - Number(stat.ctimeMs) > DIGEST_SETTLE_MS
      ) {
        options.digests.remember(identity, digest);
      }
    }
    const snapshot = {
      kind: "file",
      digest,
      mode: safeFileMode(Number(stat.mode)),
    } as const;
    result.set(relative, snapshot);
    return snapshot;
  };
  // Three of the four traversals an admission performs — the host snapshot, the
  // durable snapshot and the local baseline — are this function, and each walked
  // its managed roots one after another. They overlap at the same bound as the
  // copy pass, for the same reason: the roots are mutually disjoint.
  //
  // Two properties are deliberately unchanged. The quota counters above stay
  // SHARED, so `MAX_FILES`/`MAX_TREE_ENTRIES`/`MAX_TOTAL_BYTES` remain limits on
  // the whole projection rather than per-root allowances. And `result`'s
  // insertion order is not a property any caller can rely on either way: the
  // walk inside a single root already fans its siblings out
  // `TREE_WALK_CONCURRENCY`-wide, so cross-root interleaving introduces no new
  // non-determinism. Consumers look entries up by path, and the merge passes
  // that care about ordering sort explicitly.
  await mapBounded(managed, MANAGED_ROOT_CONCURRENCY, (item) =>
    visit(
      root === null ? item.source : path.join(root, item.relative),
      item.relative,
      "",
      managedExclusions(item, includeSeedExclusions),
    ),
  );
  return result;
}

async function snapshotManagedSources(
  managed: readonly ManagedPath[],
  deniedRoots: readonly string[],
  digests?: ContentDigests,
): Promise<Map<string, EntrySnapshot>> {
  return snapshotManaged(null, managed, true, {
    materializeSymlinks: true,
    deniedRoots,
    ...(digests ? { digests } : {}),
  });
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

/** Whether one side of the merge moved in a way this exact path is accountable
 * for. A directory's digest is recursive, so any descendant edit changes it;
 * answering "did this side move under us?" with that digest turns one
 * unrelated file appearing in a shared directory into a conflict over the
 * whole subtree, which then archives and resets every private descendant. The
 * descendants that really changed are merge candidates in their own right, and
 * the local side already compares directories this way.
 *
 * The relaxation holds only while this session's own result is still a
 * directory. Deleting or replacing a directory does affect every descendant —
 * including one a human just added on the host — so that stays a conflict. */
function mergeSideMoved(
  before: DurableEntrySnapshot | undefined,
  now: DurableEntrySnapshot | undefined,
  local: EntrySnapshot | undefined,
): boolean {
  if (local?.kind === "directory" && now?.kind === "directory") return false;
  return !equalDurableEntry(before, now);
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

function safeProviderResumeId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (
    !normalized ||
    Buffer.byteLength(normalized) > 256 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0")
  ) {
    return undefined;
  }
  return normalized;
}

interface ProviderSessionFile {
  readonly source: string;
  readonly relative: string;
  readonly name: string;
}

function codexSessionFilenameMatchesId(
  file: ProviderSessionFile,
  id: string,
): boolean {
  const extension = file.name.endsWith(".jsonl.zst") ? ".jsonl.zst" : ".jsonl";
  const stem = file.name.slice(0, -extension.length);
  // Official Codex rollout names end in `-<thread id>`. Requiring an exact
  // terminal component avoids importing another transcript merely because an
  // opaque (or maliciously short) resume id occurs somewhere in its name.
  return stem === id || stem.endsWith(`-${id}`);
}

/** Walk a provider history root for transcript files.
 *
 * `stopAtName` turns the collect-then-filter shape into a search that stops at
 * the first hit. That matters on the admission path: a workspace with 1,500
 * accumulated transcripts otherwise walks all of them — twice per resume, once
 * for the host seeds and once for the durable ones — to keep exactly one. The
 * caller must only pass it when a single exact filename is all it needs. */
async function scanProviderSessionFiles(
  sourceRoot: string,
  relativeRoot: string,
  options: { readonly stopAtName?: string } = {},
): Promise<ProviderSessionFile[]> {
  const files: ProviderSessionFile[] = [];
  let entriesSeen = 0;
  const visit = async (absolute: string, relative: string): Promise<void> => {
    if (options.stopAtName !== undefined && files.length > 0) return;
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // Provider history roots are untrusted inputs. Never follow an alias out of
    // the canonical provider root while locating an opaque resume artifact.
    if (stat.isSymbolicLink()) return;
    entriesSeen += 1;
    if (entriesSeen > MAX_RESUME_SCAN_ENTRIES) {
      throw new Error("provider resume history exceeds its bounded scan quota");
    }
    if (stat.isDirectory()) {
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (options.stopAtName !== undefined && files.length > 0) return;
        await visit(
          path.join(absolute, entry.name),
          path.join(relative, entry.name),
        );
      }
      return;
    }
    if (
      stat.isFile() &&
      (absolute.endsWith(".jsonl") || absolute.endsWith(".jsonl.zst"))
    ) {
      const name = path.basename(absolute);
      if (options.stopAtName !== undefined && name !== options.stopAtName) {
        return;
      }
      files.push({ source: absolute, relative, name });
    }
  };
  await visit(sourceRoot, relativeRoot);
  return files;
}

async function readCodexSessionMeta(
  file: ProviderSessionFile,
): Promise<{ readonly id?: string; readonly historyBaseId?: string }> {
  if (!file.source.endsWith(".jsonl")) return {};
  const handle = await open(file.source, "r");
  try {
    const bytes = Buffer.alloc(MAX_SESSION_META_BYTES);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) return {};
    const parsed = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as {
      type?: unknown;
      payload?: {
        id?: unknown;
        history_base?: { thread_id?: unknown };
      };
    };
    if (parsed.type !== "session_meta" || !parsed.payload) return {};
    return {
      ...(typeof parsed.payload.id === "string"
        ? { id: parsed.payload.id }
        : {}),
      ...(typeof parsed.payload.history_base?.thread_id === "string"
        ? { historyBaseId: parsed.payload.history_base.thread_id }
        : {}),
    };
  } catch {
    return {};
  } finally {
    await handle.close();
  }
}

async function providerResumeSeedPaths(
  providerId: string,
  managed: readonly ManagedPath[],
  rawResumeId: string | undefined,
  options: { readonly metadataFallbackLimit?: number } = {},
): Promise<ManagedPath[]> {
  const resumeId = safeProviderResumeId(rawResumeId);
  if (!resumeId) return [];
  const providerRoot = managed.find((item) =>
    providerId === "codex"
      ? item.relative === ".codex"
      : providerId === "claude"
        ? item.relative === ".claude"
        : false,
  );
  if (!providerRoot) return [];

  if (providerId === "claude") {
    // Claude transcripts are addressed by exact filename, so the walk can stop
    // at the first hit instead of collecting the whole accumulated history.
    const exact = await scanProviderSessionFiles(
      path.join(providerRoot.source, "projects"),
      path.join(providerRoot.relative, "projects"),
      { stopAtName: `${resumeId}.jsonl` },
    );
    if (exact.length > MAX_RESUME_SEED_FILES) {
      throw new Error("provider resume history exceeds its bounded file quota");
    }
    const seeds: ManagedPath[] = exact.map(({ source, relative }) => ({
      source,
      relative,
    }));
    for (const file of exact) {
      const sidecarSource = path.join(path.dirname(file.source), resumeId);
      try {
        const sidecar = await lstat(sidecarSource);
        if (sidecar.isDirectory() && !sidecar.isSymbolicLink()) {
          seeds.push({
            source: sidecarSource,
            relative: path.join(path.dirname(file.relative), resumeId),
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return seeds;
  }

  const codexFiles = (
    await Promise.all(
      ["sessions", "archived_sessions"].map((directory) =>
        scanProviderSessionFiles(
          path.join(providerRoot.source, directory),
          path.join(providerRoot.relative, directory),
        ),
      ),
    )
  ).flat();
  const metadata = new Map<
    ProviderSessionFile,
    Awaited<ReturnType<typeof readCodexSessionMeta>>
  >();
  const metadataFor = async (file: ProviderSessionFile) => {
    const cached = metadata.get(file);
    if (cached) return cached;
    const value = await readCodexSessionMeta(file);
    metadata.set(file, value);
    return value;
  };
  const selected = new Set<ProviderSessionFile>(
    codexFiles.filter((file) => codexSessionFilenameMatchesId(file, resumeId)),
  );
  if (selected.size > MAX_RESUME_SEED_FILES) {
    throw new Error("provider resume history exceeds its bounded file quota");
  }
  // Official rollout names contain the stable thread UUID. Retain a bounded
  // metadata fallback for imported/legacy layouts without opening thousands of
  // files concurrently (which could exhaust the engine's descriptor limit).
  if (selected.size === 0) {
    let read = 0;
    for (const file of codexFiles) {
      if (read >= (options.metadataFallbackLimit ?? codexFiles.length)) break;
      read += 1;
      if ((await metadataFor(file)).id === resumeId) {
        selected.add(file);
        break;
      }
    }
  }
  const pendingHistoryIds: string[] = [];
  for (const file of selected) {
    const parent = (await metadataFor(file)).historyBaseId;
    if (parent) pendingHistoryIds.push(parent);
  }
  const visitedHistoryIds = new Set<string>();
  while (pendingHistoryIds.length > 0) {
    const historyId = pendingHistoryIds.pop();
    if (!historyId || visitedHistoryIds.has(historyId)) continue;
    visitedHistoryIds.add(historyId);
    for (const file of codexFiles) {
      if (!codexSessionFilenameMatchesId(file, historyId)) continue;
      if (!selected.has(file)) {
        selected.add(file);
        const parent = (await metadataFor(file)).historyBaseId;
        if (parent) pendingHistoryIds.push(parent);
      }
    }
    if (selected.size > MAX_RESUME_SEED_FILES) {
      throw new Error("provider resume history exceeds its bounded file quota");
    }
  }
  return [...selected].map(({ source, relative }) => ({ source, relative }));
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
  digests?: ContentDigests,
): Promise<Map<string, DurableEntrySnapshot>> {
  const snapshot = new Map<string, DurableEntrySnapshot>(
    await snapshotManaged(
      contentRoot,
      managed,
      false,
      digests ? { digests } : {},
    ),
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
    try {
      await releaseFilesystemLock?.();
    } finally {
      // Never strand the in-process queue if SQLite reports a release/close
      // failure. The caller still receives that failure, while a later attempt
      // can acquire the authoritative filesystem lock or time out normally.
      release();
      if (promotionTails.get(root) === queued) promotionTails.delete(root);
    }
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

/** Everything a private provider HOME's *content* is a function of, with every
 * per-session input deliberately absent. Two admissions whose inputs hash the
 * same must produce byte-identical worlds, which is what makes one of them
 * reusable by the other. */
interface ProviderWorldInputs {
  readonly managed: readonly ManagedPath[];
  readonly compatibilitySeeds: readonly ManagedPath[];
  readonly resolvedCompatibilityLinks: readonly (ManagedPath & {
    readonly source: string;
  })[];
  readonly contentRoot: string;
  /** Enforced in full while the world is built. Without the destination: that is
   * added per materialization, and a host symlink can never point into a session
   * root that does not exist yet. */
  readonly deniedRoots: readonly string[];
  /** The subset the stamp may see — see `generationScopedDeniedRoots`. Kept
   * separate so relaxing the *stamp* can never relax the *check*. */
  readonly stampedDeniedRoots: readonly string[];
  readonly host: ReadonlyMap<string, EntrySnapshot>;
  readonly persistent: ReadonlyMap<string, DurableEntrySnapshot>;
  readonly compat: ReadonlyMap<string, EntrySnapshot>;
  readonly tombstones: ReadonlySet<string>;
  readonly scopedHistory: boolean;
  readonly credentialSuppressed: boolean;
}

/** Build the whole reusable world at `destination`. Every pass here is a pure
 * function of `world`; nothing that belongs to one session or one conversation
 * may be added, because the result is what gets parked. */
async function materializeProviderWorld(
  destination: string,
  world: ProviderWorldInputs,
  projectedDigests: Map<string, string>,
): Promise<void> {
  const deniedRoots = [
    ...world.deniedRoots,
    await canonicalExistingOrLexical(destination),
  ];
  for (const item of world.compatibilitySeeds) {
    try {
      await copyTree(
        await realpath(item.source),
        path.join(destination, item.relative),
        NO_MANAGED_EXCLUSIONS,
        { materializeSymlinks: true, deniedRoots },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mapBounded(world.managed, MANAGED_ROOT_CONCURRENCY, (item) =>
    copyTree(
      item.source,
      path.join(destination, item.relative),
      managedExclusions(item, true),
      {
        materializeSymlinks: true,
        deniedRoots,
        known: {
          digests: world.host,
          prefix: item.relative,
          record: projectedDigests,
        },
      },
    ),
  );
  await mapBounded(world.managed, MANAGED_ROOT_CONCURRENCY, (item) =>
    copyTree(
      path.join(world.contentRoot, item.relative),
      path.join(destination, item.relative),
      withExcludedPaths(
        managedExclusions(item, false),
        world.scopedHistory ? historyRoots(item) : [],
      ),
      {
        known: {
          digests: world.persistent,
          prefix: item.relative,
          record: projectedDigests,
        },
      },
    ),
  );
  await applyProviderWorldTombstones(destination, world.tombstones);
  for (const item of world.resolvedCompatibilityLinks) {
    await materializeReadOnlyLink(destination, item.relative, item.source);
  }
  await Promise.all(
    [
      ".config",
      ".cache",
      path.join(".local", "share"),
      path.join(".local", "state"),
    ].map((relative) =>
      mkdir(path.join(destination, relative), {
        recursive: true,
        mode: 0o700,
      }),
    ),
  );
}

async function applyProviderWorldTombstones(
  root: string,
  tombstones: ReadonlySet<string>,
): Promise<void> {
  for (const relative of [...tombstones].sort(
    (left, right) => relativeDepth(right) - relativeDepth(left),
  )) {
    await removeContainedEntry(root, relative);
  }
}

const PARKED_WORLD_DIRECTORY = "provider-home-parked";
const PARK_MANIFEST_FILE = "park.json";
const PARK_CURRENT_DIRECTORY = "current";
const PARK_WORLD_DIRECTORY = "world";
const PARK_WARM_INPUTS_FILE = "warm-inputs.json";
/** How many keys a boot refills. Recency-ordered, one at a time: enough that the
 * workspace someone was last working in is ready, few enough that launching the
 * app is not a copy storm. */
const PARK_REFILL_LIMIT = 4;
/** Bumped by hand whenever the *shape* of a projection changes in a way a world
 * built by older code would get wrong but whose inputs still hash the same. */
const PARK_RULES_VERSION = 1;
/** A `building-`/`claimed-`/`stale-` directory older than this is crash debris.
 * Generous: a build of a large provider tree is a second, not an hour. */
const PARK_DEBRIS_RETENTION_MS = 60 * 60 * 1000;
const MAX_PARK_MANIFEST_BYTES = MAX_DIGEST_MANIFEST_BYTES;
const parkBuildsInFlight = new Set<string>();

let engineBuildIdentity: string | null | undefined;

/** The on-disk identity of this module, which is what makes "the app was
 * rebuilt" observable to the engine without a version constant to forget to
 * bump: a dev worktree's source file and a packaged bundle both change identity
 * on every build. When it cannot be resolved, a rebuild would be
 * indistinguishable from a reuse — §20.4 #7 requires eviction there, so parking
 * turns itself off instead of guessing. */
function providerWorldBuildIdentity(): string | null {
  if (engineBuildIdentity !== undefined) return engineBuildIdentity;
  try {
    const stat = lstatSync(fileURLToPath(import.meta.url), { bigint: true });
    engineBuildIdentity = [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join(":");
  } catch {
    engineBuildIdentity = null;
  }
  return engineBuildIdentity;
}

function providerWorldStamp(input: {
  readonly providerId: string;
  readonly persistentKey: string;
  readonly world: ProviderWorldInputs;
}): string | null {
  const build = providerWorldBuildIdentity();
  if (!build) return null;
  const { world } = input;
  const sortedEntries = <Value>(map: ReadonlyMap<string, Value>) =>
    [...map].sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: PARK_RULES_VERSION,
        build,
        providerId: input.providerId,
        persistentKey: input.persistentKey,
        scopedHistory: world.scopedHistory,
        // §20.4 #3: the credential choice is per generation, so a mode switch
        // must be a miss even on a platform with no keychain projection to move
        // the host side of the stamp for it.
        credentialSuppressed: world.credentialSuppressed,
        // §20.4 #6: `providerStateEnv` reaches this through the resolved
        // sources, so CLAUDE_CONFIG_DIR / CODEX_HOME / XDG scope changes miss.
        rules: world.managed.map((item) => ({
          relative: item.relative,
          source: item.source,
          seeded: managedExclusions(item, true).paths,
          durable: withExcludedPaths(
            managedExclusions(item, false),
            world.scopedHistory ? historyRoots(item) : [],
          ).paths,
        })),
        names: CHURN_ARTIFACT_NAMES.map((pattern) => pattern.source),
        host: sortedEntries(world.host),
        durable: sortedEntries(world.persistent),
        compat: sortedEntries(world.compat),
        links: world.resolvedCompatibilityLinks
          .map((item) => [item.relative, item.source] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
        tombstones: [...world.tombstones].sort((left, right) =>
          left.localeCompare(right),
        ),
        denied: world.stampedDeniedRoots,
      }),
    )
    .digest("hex");
}

/** The same set of denied roots with every root that another root already covers
 * removed, sorted so it is a stable stamp term.
 *
 * Equivalence-preserving for the containment predicate this set feeds,
 * `inside(target, denied) || inside(denied, target)`: if `d2` is inside `d1`,
 * anything overlapping `d2` overlaps `d1`, because `d1` and `d2` are both
 * ancestors of the overlap point and ancestors of one path are totally ordered. */
function minimalCoveringRoots(roots: readonly string[]): string[] {
  const sorted = [...new Set(roots)].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  return sorted
    .filter(
      (candidate, index) =>
        !sorted
          .slice(0, index)
          .some((parent) => pathIsInsideOrEqual(candidate, parent)),
    )
    .sort((left, right) => left.localeCompare(right));
}

function parkedWorldRoot(providerId: string, persistentKey: string): string {
  // Deliberately NOT under `provider-home/`: `sweepProviderHomeStorage` walks
  // that namespace with crash-recovery authority and would reclaim a parked
  // world as an idle projection holding no state (§20.3). The sweep is taught
  // about this root explicitly instead.
  return path.join(
    zerosDataDir(),
    PARKED_WORLD_DIRECTORY,
    safeProviderId(providerId),
    persistentKey,
  );
}

interface ParkedWorldManifest {
  readonly version: 1;
  readonly providerId: string;
  readonly stamp: string;
  /** The identities `copyTree` proved while writing this world, so adopting it
   * costs a stat walk instead of re-hashing the tree. Sound across time only
   * because `contentIdentity` is nanosecond-keyed (§20.2), and safe because
   * nothing but this engine can write into a parked world. */
  readonly projected: Readonly<Record<string, string>>;
}

async function readParkedWorldManifest(
  file: string,
): Promise<ParkedWorldManifest | null> {
  try {
    const metadata = await lstat(file);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > MAX_PARK_MANIFEST_BYTES ||
      (metadata.mode & 0o077) !== 0
    ) {
      return null;
    }
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      version?: unknown;
      providerId?: unknown;
      stamp?: unknown;
      projected?: unknown;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.providerId !== "string" ||
      typeof parsed.stamp !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.stamp) ||
      !parsed.projected ||
      typeof parsed.projected !== "object" ||
      Array.isArray(parsed.projected)
    ) {
      return null;
    }
    const projected: Record<string, string> = {};
    for (const [identity, digest] of Object.entries(
      parsed.projected as Record<string, unknown>,
    )) {
      if (Object.keys(projected).length >= MAX_DIGEST_MANIFEST_ENTRIES) break;
      if (typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)) {
        projected[identity] = digest;
      }
    }
    return {
      version: 1,
      providerId: parsed.providerId,
      stamp: parsed.stamp,
      projected,
    };
  } catch {
    return null;
  }
}

function parkingDisabled(): boolean {
  return Boolean(process.env.ZEROS_ZSR_DISABLE_PARKED_PROVIDER_HOME?.trim());
}

/** Take a parked world for this exact stamp, if one is waiting.
 *
 * A parked world is **consumed exactly once**: the claim below is a single
 * `rename` that makes it unreachable to any other engine or admission before a
 * byte of it is read, and the entry is destroyed afterwards either way. That is
 * what answers §20.4 #2 — nothing is ever reused, so no session can inherit
 * what another one wrote — and §20.4 #1, because the loser of a race finds
 * nothing to claim rather than a half-written tree.
 *
 * Every failure path returns `false` with an empty destination, so the caller
 * simply builds the world itself. Adoption is an optimization and may never be
 * the reason an admission fails. */
async function adoptParkedProviderWorld(
  providerId: string,
  persistentKey: string,
  stamp: string,
  destination: string,
  projectedDigests: Map<string, string>,
): Promise<boolean> {
  if (parkingDisabled()) return false;
  const parkRoot = parkedWorldRoot(providerId, persistentKey);
  const claimed = path.join(parkRoot, `claimed-${randomUUID()}`);
  try {
    await rename(path.join(parkRoot, PARK_CURRENT_DIRECTORY), claimed);
  } catch {
    return false;
  }
  let adopted = false;
  try {
    const manifest = await readParkedWorldManifest(
      path.join(claimed, PARK_MANIFEST_FILE),
    );
    if (manifest?.stamp !== stamp || manifest.providerId !== providerId) {
      return false;
    }
    const world = path.join(claimed, PARK_WORLD_DIRECTORY);
    await assertPhysicalDirectory(world, "parked provider HOME");
    await rm(destination, { recursive: true, force: true });
    await rename(world, destination);
    adopted = true;
    await chmod(destination, 0o700);
    for (const [identity, digest] of Object.entries(manifest.projected)) {
      projectedDigests.set(identity, digest);
    }
    return true;
  } catch {
    if (adopted) {
      // The world reached the destination but something after it failed. Leave
      // no half-adopted tree behind: discard it and let the caller rebuild.
      await rm(destination, { recursive: true, force: true }).catch(
        () => undefined,
      );
      adopted = false;
    }
    return false;
  } finally {
    if (!adopted) {
      await mkdir(destination, { recursive: true, mode: 0o700 }).catch(
        () => undefined,
      );
    }
    await rm(claimed, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Publish a freshly built world as the parked one for its stamp.
 *
 * `built` must be the world directory itself, already inside `parkRoot`, so
 * publishing is renames only — a partially built world is never reachable under
 * `current`, which is §20.4 #8. */
async function publishParkedProviderWorld(input: {
  readonly providerId: string;
  readonly persistentKey: string;
  readonly stamp: string;
  readonly building: string;
  readonly projected: ReadonlyMap<string, string>;
}): Promise<void> {
  const parkRoot = parkedWorldRoot(input.providerId, input.persistentKey);
  const current = path.join(parkRoot, PARK_CURRENT_DIRECTORY);
  const manifest: ParkedWorldManifest = {
    version: 1,
    providerId: input.providerId,
    stamp: input.stamp,
    projected: Object.fromEntries(
      [...input.projected].slice(0, MAX_DIGEST_MANIFEST_ENTRIES),
    ),
  };
  const manifestPath = path.join(input.building, PARK_MANIFEST_FILE);
  const handle = await open(manifestPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(input.building);
  const stale = path.join(parkRoot, `stale-${randomUUID()}`);
  let displaced = false;
  try {
    await rename(current, stale);
    displaced = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(input.building, current);
  await syncDirectory(parkRoot);
  if (displaced) await rm(stale, { recursive: true, force: true });
}

/** Build the next session's provider world *now*, so the next admission renames
 * it into place instead of copying the host tree again.
 *
 * Deliberately the same code path as an admission — it calls
 * `prepareProviderHomeOverlay` into a scratch root inside the park store — so
 * there is no second projection implementation to drift. It carries no
 * `providerResumeId`, which is what keeps a conversation's resume seeds out of
 * a shared artifact (§20.4 #4).
 *
 * Being the same code path means it also performs the same merge, so a conflict
 * archive or a keychain refresh can now land here rather than on the admission
 * that would otherwise have done it a moment later. That is the point: it is the
 * same work, moved off the path, under the same lock, and idempotent.
 *
 * Returns whether a world was published. Never throws: a prewarm that fails
 * leaves the admission exactly as it was before this existed. */
export async function prewarmProviderHomeOverlay(options: {
  readonly providerId?: string;
  readonly workspaceRoot: string;
  readonly stateScope?: string;
  /** The request's path-scoping overrides. Passing these instead of a whole
   * `ambientEnv` is what lets the prewarm record its own inputs, so a later boot
   * can repeat it with no live admission to copy them from. They are a fixed
   * allowlist of seven directory variables — never a credential. */
  readonly providerStateEnv?: Readonly<Record<string, string>>;
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly deniedSourceRoots?: readonly string[];
  readonly generationScopedDeniedRoots?: readonly string[];
  readonly credentialSeedReader?: ProviderCredentialSeedReader;
}): Promise<boolean> {
  if (parkingDisabled() || !options.providerId) return false;
  if (!providerWorldBuildIdentity()) return false;
  const providerId = safeProviderId(options.providerId);
  const ambientEnv =
    options.ambientEnv ??
    (options.providerStateEnv
      ? { ...process.env, ...options.providerStateEnv }
      : undefined);
  let parkRoot: string;
  let persistentKey: string;
  try {
    const env = ambientEnv ?? process.env;
    const hostHome = await realpath(absoluteEnvPath(env, "HOME", homedir()));
    persistentKey = workspaceKey(
      providerId,
      options.stateScope ?? path.resolve(await realpath(options.workspaceRoot)),
      hostHome,
    );
    parkRoot = parkedWorldRoot(providerId, persistentKey);
  } catch {
    return false;
  }
  // One build per key at a time, and never behind an admission that is already
  // queued for the same promotion lock: a prewarm is worth ~450 ms off a later
  // admission, never a millisecond added to one already in flight.
  if (parkBuildsInFlight.has(parkRoot)) return false;
  if (
    promotionTails.has(
      path.join(zerosDataDir(), "provider-home", providerId, persistentKey),
    )
  ) {
    return false;
  }
  parkBuildsInFlight.add(parkRoot);
  const building = path.join(parkRoot, `building-${randomUUID()}`);
  const world = path.join(building, PARK_WORLD_DIRECTORY);
  try {
    await mkdir(world, { recursive: true, mode: 0o700 });
    const overlay = await prepareProviderHomeOverlay({
      providerId,
      workspaceRoot: options.workspaceRoot,
      localHome: await realpath(world),
      ...(options.stateScope ? { stateScope: options.stateScope } : {}),
      ...(ambientEnv ? { ambientEnv } : {}),
      ...(options.deniedSourceRoots
        ? { deniedSourceRoots: options.deniedSourceRoots }
        : {}),
      ...(options.generationScopedDeniedRoots
        ? { generationScopedDeniedRoots: options.generationScopedDeniedRoots }
        : {}),
      ...(options.credentialSeedReader
        ? { credentialSeedReader: options.credentialSeedReader }
        : {}),
      parkedWorlds: "build",
    });
    if (!overlay.stamp) return false;
    await publishParkedProviderWorld({
      providerId,
      persistentKey,
      stamp: overlay.stamp,
      building,
      projected: overlay.projectedDigests ?? new Map(),
    });
    if (!options.ambientEnv) {
      // Only the reproducible shape records itself. A caller that supplied a
      // whole `ambientEnv` cannot be replayed from disk, so nothing pretends it
      // can be.
      await writeParkWarmInputs(parkRoot, {
        version: 1,
        providerId,
        workspaceRoot: options.workspaceRoot,
        ...(options.stateScope ? { stateScope: options.stateScope } : {}),
        ...(options.providerStateEnv &&
        Object.keys(options.providerStateEnv).length > 0
          ? { providerStateEnv: options.providerStateEnv }
          : {}),
        ...(options.deniedSourceRoots
          ? { deniedSourceRoots: [...options.deniedSourceRoots] }
          : {}),
        ...(options.generationScopedDeniedRoots
          ? {
              generationScopedDeniedRoots: [
                ...options.generationScopedDeniedRoots,
              ],
            }
          : {}),
      }).catch(() => undefined);
    }
    return true;
  } catch (error) {
    if (process.env.SRT_DEBUG) {
      console.error("[zsr] provider world prewarm failed", error);
    }
    return false;
  } finally {
    await rm(building, { recursive: true, force: true }).catch(() => undefined);
    parkBuildsInFlight.delete(parkRoot);
  }
}

/** Exactly the seven path-scoping variables the gateway forwards. Fixed here so
 * a recorded input file can never replay anything else into a prewarm's env. */
const PROVIDER_STATE_ENV_NAMES = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
] as const;

interface ParkWarmInputs {
  readonly version: 1;
  readonly providerId: string;
  readonly workspaceRoot: string;
  readonly stateScope?: string;
  readonly providerStateEnv?: Readonly<Record<string, string>>;
  readonly deniedSourceRoots?: readonly string[];
  /** Recorded and replayed alongside the denied roots rather than filtered out
   * of them, so a refill reproduces the same *split* and therefore the same
   * stamp. Replaying a retired generation's paths is harmless: they are excluded
   * from the stamp and the enforcement check merely gains paths that no longer
   * exist. */
  readonly generationScopedDeniedRoots?: readonly string[];
}

async function writeParkWarmInputs(
  parkRoot: string,
  inputs: ParkWarmInputs,
): Promise<void> {
  const target = path.join(parkRoot, PARK_WARM_INPUTS_FILE);
  const temporary = path.join(parkRoot, `.warm-inputs.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(inputs)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporary, target);
}

async function readParkWarmInputs(
  file: string,
): Promise<ParkWarmInputs | null> {
  try {
    const metadata = await lstat(file);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > 256 * 1024 ||
      (metadata.mode & 0o077) !== 0
    ) {
      return null;
    }
    const parsed = JSON.parse(await readFile(file, "utf8")) as ParkWarmInputs;
    if (
      parsed.version !== 1 ||
      typeof parsed.providerId !== "string" ||
      safeProviderId(parsed.providerId) !== parsed.providerId ||
      typeof parsed.workspaceRoot !== "string" ||
      !path.isAbsolute(parsed.workspaceRoot) ||
      path.resolve(parsed.workspaceRoot) !== parsed.workspaceRoot
    ) {
      return null;
    }
    if (parsed.stateScope !== undefined) {
      if (
        typeof parsed.stateScope !== "string" ||
        Buffer.byteLength(parsed.stateScope) > 4096
      ) {
        return null;
      }
    }
    const providerStateEnv: Record<string, string> = {};
    for (const name of PROVIDER_STATE_ENV_NAMES) {
      const value = parsed.providerStateEnv?.[name];
      if (typeof value !== "string") continue;
      if (!path.isAbsolute(value) || path.resolve(value) !== value) return null;
      providerStateEnv[name] = value;
    }
    const recordedRoots = (
      list: readonly unknown[] | undefined,
    ): string[] | null => {
      const roots: string[] = [];
      for (const root of list ?? []) {
        if (typeof root !== "string" || !path.isAbsolute(root)) return null;
        if (roots.length >= MAX_RECOVERY_DENIED_ROOTS) break;
        roots.push(root);
      }
      return roots;
    };
    const deniedSourceRoots = recordedRoots(parsed.deniedSourceRoots);
    const generationScopedDeniedRoots = recordedRoots(
      parsed.generationScopedDeniedRoots,
    );
    if (!deniedSourceRoots || !generationScopedDeniedRoots) return null;
    return {
      version: 1,
      providerId: parsed.providerId,
      workspaceRoot: parsed.workspaceRoot,
      ...(parsed.stateScope !== undefined
        ? { stateScope: parsed.stateScope }
        : {}),
      ...(Object.keys(providerStateEnv).length > 0 ? { providerStateEnv } : {}),
      ...(deniedSourceRoots.length > 0 ? { deniedSourceRoots } : {}),
      ...(generationScopedDeniedRoots.length > 0
        ? { generationScopedDeniedRoots }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Rebuild the parked worlds most likely to be adopted next, at boot.
 *
 * This is the "prewarm at workspace open" half of R3, driven by recency rather
 * than by a UI event: each key's recorded inputs are the ones a real admission
 * used, so replaying the `limit` most recent ones is a prediction that cannot be
 * wrong about *what* to build — only about whether it will be wanted.
 *
 * Bounded and sequential on purpose. §5.1's lesson was that eagerly readying
 * every open chat rebuilt the boot burst; a parked world costs no gate slot, no
 * port and no supervisor, but it is still ~0.4 s of file copying, so N of them
 * at once would be a burst of a different kind. One at a time, a handful of keys,
 * and never awaited by boot itself. */
export async function refillParkedProviderWorlds(
  options: { readonly limit?: number } = {},
): Promise<number> {
  if (parkingDisabled()) return 0;
  const limit = options.limit ?? PARK_REFILL_LIMIT;
  if (limit <= 0) return 0;
  const parkedRoot = path.join(zerosDataDir(), PARKED_WORLD_DIRECTORY);
  const candidates: Array<{
    readonly inputs: ParkWarmInputs;
    readonly at: number;
  }> = [];
  let providers;
  try {
    providers = await readdir(parkedRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const provider of providers) {
    if (!provider.isDirectory() || provider.isSymbolicLink()) continue;
    const providerRoot = path.join(parkedRoot, provider.name);
    let keys;
    try {
      keys = await readdir(providerRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const key of keys) {
      if (!key.isDirectory() || key.isSymbolicLink()) continue;
      const file = path.join(providerRoot, key.name, PARK_WARM_INPUTS_FILE);
      const inputs = await readParkWarmInputs(file);
      if (!inputs || inputs.providerId !== provider.name) continue;
      try {
        candidates.push({ inputs, at: (await lstat(file)).mtimeMs });
      } catch {
        continue;
      }
    }
  }
  candidates.sort((left, right) => right.at - left.at);
  let refilled = 0;
  for (const candidate of candidates.slice(0, limit)) {
    const published = await prewarmProviderHomeOverlay({
      providerId: candidate.inputs.providerId,
      workspaceRoot: candidate.inputs.workspaceRoot,
      ...(candidate.inputs.stateScope !== undefined
        ? { stateScope: candidate.inputs.stateScope }
        : {}),
      ...(candidate.inputs.providerStateEnv
        ? { providerStateEnv: candidate.inputs.providerStateEnv }
        : {}),
      ...(candidate.inputs.deniedSourceRoots
        ? { deniedSourceRoots: candidate.inputs.deniedSourceRoots }
        : {}),
      ...(candidate.inputs.generationScopedDeniedRoots
        ? {
            generationScopedDeniedRoots:
              candidate.inputs.generationScopedDeniedRoots,
          }
        : {}),
    });
    if (published) refilled += 1;
  }
  return refilled;
}

export async function prepareProviderHomeOverlay(options: {
  readonly providerId?: string;
  /** Opaque native provider binding selected by the trusted gateway. Only the
   * matching legacy transcript is imported; the value never becomes a path. */
  readonly providerResumeId?: string;
  readonly localHome: string;
  readonly workspaceRoot: string;
  /** Overrides the durable-state key for requests whose working root is a
   * throwaway directory (provider probes). Opaque, never touched as a path;
   * without it every probe run would mint and orphan a fresh durable copy of
   * the provider's host state. */
  readonly stateScope?: string;
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly deniedSourceRoots?: readonly string[];
  /** Denied roots this generation created for itself — its `policy.json`, its
   * command directory, its network runtime dir. They are enforced exactly like
   * every other denied root, and excluded from the reusable-world stamp.
   *
   * They have to be excluded or nothing is ever reusable: two of the three live
   * under `sessions/<executionId>/boundary/<generation>/` and the third under
   * `/private/tmp/zeros-zn-<generation>/`, so a stamp containing them changes on
   * every admission — which is precisely why every admission in the 2026-08-18
   * 00:33 log reported `parked=miss` right after "prewarmed 4 provider world(s)".
   *
   * Excluding them is sound, not a concession: a denied root can only make the
   * projection *throw*, never change a byte of it, and these directories did not
   * exist when the world was built. A world built at T cannot contain bytes from
   * a directory created after T. And getting this list wrong is fail-safe in the
   * one direction that matters — naming a root that is actually stable only
   * causes misses, never a bad hit. */
  readonly generationScopedDeniedRoots?: readonly string[];
  /** Injectable for deterministic tests. Production derives the supported
   * macOS keychain lookup from providerId and the canonical host HOME. */
  readonly credentialSeedReader?: ProviderCredentialSeedReader;
  /** `"build"` refuses to adopt a parked world, so a prewarm produces one from
   * the real inputs instead of consuming the one it is meant to replace. */
  readonly parkedWorlds?: "adopt" | "build";
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
  const managed = await Promise.all(
    providerManagedPaths(providerId, hostHome, env).map(async (item) => ({
      ...item,
      // A provider config root may itself be a user-created symlink. Traverse
      // its canonical target as trusted input, then materialize a physical
      // private copy; never reproduce a writable link back into host state.
      source: await canonicalExistingOrLexical(item.source),
    })),
  );
  const credentialRelative = providerCredentialRelative(providerId);
  const explicitProviderCredential = hasExplicitProviderCredential(
    providerId,
    env,
  );
  if (options.credentialSeedReader && !credentialRelative) {
    throw new Error("provider does not have a supported keychain projection");
  }
  const configuredCredentialReader = explicitProviderCredential
    ? undefined
    : (options.credentialSeedReader ??
      (await defaultProviderCredentialSeedReader(providerId, hostHome, env)));
  const compatibilitySeeds = compatibilitySeedPaths(hostHome);
  const compatibilityLinks = readOnlyCompatibilityLinks(hostHome);
  const deniedRoots = await Promise.all(
    [
      zerosDataDir(),
      zerosChannelDataDir(),
      zerosStateRoot(),
      options.localHome,
      ...(options.deniedSourceRoots ?? []),
      ...(options.generationScopedDeniedRoots ?? []),
    ].map(canonicalExistingOrLexical),
  );
  // What the stamp may see: the denied roots minus this generation's own — the
  // destination it is being built beside, and the boundary files it created for
  // itself. Reduced to a minimal covering set, which leaves the predicate
  // `inside(target, denied) || inside(denied, target)` exactly as strict: if
  // `d2` is inside `d1`, then anything that overlaps `d2` overlaps `d1` too,
  // because two ancestors of one path are always ordered.
  const stampDestinationRoot = await canonicalExistingOrLexical(
    options.localHome,
  );
  const stampExcludedDeniedRoots = new Set([
    stampDestinationRoot,
    ...(await Promise.all(
      (options.generationScopedDeniedRoots ?? []).map(
        canonicalExistingOrLexical,
      ),
    )),
  ]);
  const stampedDeniedRoots = minimalCoveringRoots(
    deniedRoots.filter((root) => !stampExcludedDeniedRoots.has(root)),
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
  const resumeSeeds = await providerResumeSeedPaths(
    providerId,
    managed,
    options.providerResumeId,
  );
  for (const item of resumeSeeds) {
    const resolved = await canonicalExistingOrLexical(item.source);
    if (
      path.dirname(resolved) === resolved ||
      deniedRoots.some(
        (denied) =>
          pathIsInsideOrEqual(resolved, denied) ||
          pathIsInsideOrEqual(denied, resolved),
      )
    ) {
      throw new Error(
        "provider resume state overlaps Zeros engine-private or boundary state",
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
    workspaceKey(
      providerId,
      options.stateScope ?? path.resolve(workspaceRoot),
      hostHome,
    ),
  );
  const contentRoot = path.join(persistentRoot, "content");
  await mkdir(contentRoot, { recursive: true, mode: 0o700 });
  await assertPhysicalDirectory(contentRoot, "durable provider HOME overlay");
  return withPromotionLock(persistentRoot, async () => {
    const digests = await openDigestManifest(persistentRoot);
    const projectedDigests = new Map<string, string>();
    const state = await readDurableState(persistentRoot);
    const host = await snapshotManagedSources(managed, deniedRoots, digests);
    let persistent = await durableSnapshot(
      contentRoot,
      managed,
      state.tombstones,
      digests,
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
    if (credentialRelative && !explicitProviderCredential) {
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
        const bytes = normalizedCredentialBytes(source.value, providerId);
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
          persistent = await durableSnapshot(
            contentRoot,
            managed,
            [...tombstones],
            digests,
          );
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
        persistent = await durableSnapshot(
          contentRoot,
          managed,
          [...tombstones],
          digests,
        );
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
      if (
        explicitProviderCredential &&
        credentialRelative &&
        (relativeIsInsideOrEqual(relative, credentialRelative) ||
          relativeIsInsideOrEqual(credentialRelative, relative))
      ) {
        // Host CLI auth is deliberately out of scope for an explicit-token
        // generation. Its apparent absence is not a host-side deletion and
        // must not erase the durable CLI credential while modes are switched.
        continue;
      }
      const currentHost = host.get(relative);
      // A durable entry that is itself only directory structure has no content
      // to conflict over while the host also holds a directory there; the
      // descendants are accounted for individually. Without this, one file a
      // human drops into a shared provider directory reports a conflict and
      // resets every private descendant under it — on every admission.
      if (durable.kind === "directory" && currentHost?.kind === "directory") {
        continue;
      }
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
      persistent = await durableSnapshot(
        contentRoot,
        managed,
        [...tombstones],
        digests,
      );
    }
    if (stateChanged) {
      await writeDurableState(persistentRoot, tombstones, hostBases);
    }
    if (credentialMarkerAction === "write" && nextCredentialMarker) {
      await writeCredentialSourceMarker(persistentRoot, nextCredentialMarker);
    } else if (credentialMarkerAction === "remove") {
      await removeCredentialSourceMarker(persistentRoot);
    }
    // Only a provider whose history can be addressed by its opaque resume id
    // gets the scoped projection; anything else keeps the whole store so no
    // session silently loses the conversation it was asked to continue.
    const scopedHistory = providerId === "claude" || providerId === "codex";
    // The compatibility dotfiles are copied into the world too, so a change to
    // one of them has to move the stamp. Snapshotting them shares the same
    // digest manifest as everything else, so a steady state costs ~20 lstats.
    const compat = await snapshotManaged(null, compatibilitySeeds, false, {
      materializeSymlinks: true,
      deniedRoots,
      digests,
    });
    const world: ProviderWorldInputs = {
      managed,
      compatibilitySeeds,
      resolvedCompatibilityLinks,
      contentRoot,
      // The destination is added per materialization: a parked world's inputs
      // must not carry the session root it happens to be built beside.
      deniedRoots: deniedRoots.filter((root) => root !== stampDestinationRoot),
      stampedDeniedRoots,
      host,
      persistent,
      compat,
      tombstones,
      scopedHistory,
      credentialSuppressed: Boolean(
        credentialRelative && explicitProviderCredential,
      ),
    };
    const stamp =
      providerWorldStamp({
        providerId,
        persistentKey: path.basename(persistentRoot),
        world,
      }) ?? undefined;
    const adopted =
      stamp && options.parkedWorlds !== "build"
        ? await adoptParkedProviderWorld(
            providerId,
            path.basename(persistentRoot),
            stamp,
            options.localHome,
            projectedDigests,
          )
        : false;
    if (!adopted) {
      await materializeProviderWorld(
        options.localHome,
        world,
        projectedDigests,
      );
    }
    // The per-session layer. Never part of a parked world: a resume seed belongs
    // to one conversation (§20.4 #4) and the credential choice to one generation
    // (§20.4 #3), so both are applied to whichever world this session got.
    //
    // Precedence is unchanged by moving these after the durable pass rather than
    // between the two copy passes: `providerResumeSeedPaths` returns seeds only
    // for a provider with `scopedHistory`, and for exactly those providers the
    // durable pass excludes `historyRoots` — the roots the seeds live in — so the
    // two never wrote the same path. Durable resume seeds still land last.
    await mapBounded(resumeSeeds, MANAGED_ROOT_CONCURRENCY, (item) =>
      copyTree(
        item.source,
        path.join(options.localHome, item.relative),
        NO_MANAGED_EXCLUSIONS,
        {
          materializeSymlinks: true,
          deniedRoots,
        },
      ),
    );
    const durableResumeSeeds = scopedHistory
      ? await providerResumeSeedPaths(
          providerId,
          managed.map((item) => ({
            ...item,
            source: path.join(contentRoot, item.relative),
          })),
          options.providerResumeId,
          // Durable transcripts were written by the provider itself, so a
          // filename match is the normal path and the metadata fallback is
          // insurance for an imported layout. Bound it: resuming a
          // host-originated conversation matches nothing here, and reading
          // every stored transcript's head to prove that would put the whole
          // accumulated history back on the admission path.
          { metadataFallbackLimit: MAX_DURABLE_RESUME_METADATA_READS },
        )
      : [];
    for (const item of durableResumeSeeds) {
      await copyTree(
        item.source,
        path.join(options.localHome, item.relative),
        NO_MANAGED_EXCLUSIONS,
        {
          known: {
            digests: persistent,
            prefix: item.relative,
            record: projectedDigests,
          },
        },
      );
    }
    if (resumeSeeds.length > 0 || durableResumeSeeds.length > 0) {
      // Tombstones are applied inside the world build, i.e. before these seeds.
      // Re-apply them so a seed can never resurrect a path the durable state
      // records as deleted — the order this had when every pass was inline.
      await applyProviderWorldTombstones(options.localHome, tombstones);
    }
    if (credentialRelative && explicitProviderCredential) {
      // An API-key/API-token session must not receive a second account's CLI
      // OAuth artifact merely because the user previously used CLI auth. Keep
      // the durable copy untouched so switching back remains lossless; omit it
      // only from this generation and its baseline.
      await removeContainedEntry(options.localHome, credentialRelative);
    }
    const baselineLocal = await snapshotManaged(
      options.localHome,
      managed,
      false,
      {
        digests: knownContentDigests(projectedDigests),
      },
    );
    await digests.persist();
    return {
      providerId,
      workspaceRoot,
      localHome: options.localHome,
      persistentRoot,
      contentRoot,
      managed,
      deniedSourceRoots: deniedRoots,
      readOnlyHostRoots: [
        ...new Set(resolvedCompatibilityLinks.map((item) => item.source)),
      ].sort((left, right) => left.localeCompare(right)),
      baselineLocal,
      baselineHost: host,
      baselinePersistent: persistent,
      projectedDigests,
      preparationConflicts,
      ...(stamp ? { stamp } : {}),
      ...(stamp && options.parkedWorlds !== "build"
        ? { parked: adopted ? ("hit" as const) : ("miss" as const) }
        : {}),
      ...(activeCredentialSource
        ? { credentialSource: activeCredentialSource }
        : {}),
      ...(explicitProviderCredential && credentialRelative
        ? { suppressedCredentialRelative: credentialRelative }
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

/** Persist the three-way merge baseline before a provider child is admitted.
 * The marker lives beside (not inside) the projected HOME, so an admitted
 * process cannot rewrite the recovery contract. A later engine can therefore
 * finish the same conflict-aware promotion after process and container
 * retirement has been proven. */
export async function armProviderHomeRecovery(
  overlay: ProviderHomeOverlay,
): Promise<void> {
  const generationRoot = path.dirname(overlay.localHome);
  if (
    path.basename(overlay.localHome) !== "home" ||
    path.dirname(generationRoot) === generationRoot
  ) {
    throw new Error(
      "provider HOME recovery requires a generation-private root",
    );
  }
  await assertPhysicalDirectory(generationRoot, "provider recovery generation");
  await assertPhysicalDirectory(overlay.localHome, "provider recovery HOME");
  const providerBase = path.join(
    zerosDataDir(),
    "provider-home",
    overlay.providerId,
  );
  const persistentKey = path.relative(providerBase, overlay.persistentRoot);
  if (
    !/^[a-f0-9]{64}$/.test(persistentKey) ||
    path.basename(overlay.persistentRoot) !== persistentKey
  ) {
    throw new Error("provider HOME recovery has an invalid persistence key");
  }
  const hold: ProviderHomeRecoveryHold = {
    version: 1,
    providerId: overlay.providerId,
    workspaceRoot: overlay.workspaceRoot,
    persistentKey,
    managed: overlay.managed,
    deniedSourceRoots: overlay.deniedSourceRoots,
    baselineLocal: [...overlay.baselineLocal],
    baselineHost: [...overlay.baselineHost],
    baselinePersistent: [...overlay.baselinePersistent],
    ...(overlay.credentialSource
      ? {
          credentialSource: {
            relative: overlay.credentialSource.relative,
            ...(overlay.credentialSource.fallbackSnapshot
              ? {
                  fallbackSnapshot: overlay.credentialSource.fallbackSnapshot,
                }
              : {}),
          },
        }
      : {}),
    ...(overlay.suppressedCredentialRelative
      ? {
          suppressedCredentialRelative: overlay.suppressedCredentialRelative,
        }
      : {}),
  };
  const bytes = Buffer.from(`${JSON.stringify(hold)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECOVERY_HOLD_BYTES) {
    throw new Error(
      "provider HOME recovery baseline exceeds its bounded quota",
    );
  }
  const marker = path.join(generationRoot, PROVIDER_HOME_RECOVERY_HOLD_FILE);
  const temporary = path.join(
    generationRoot,
    `.${PROVIDER_HOME_RECOVERY_HOLD_FILE}.${randomUUID()}.tmp`,
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
  try {
    await rename(temporary, marker);
    await syncDirectory(generationRoot);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function promoteProviderHomeOverlay(
  overlay: ProviderHomeOverlay,
): Promise<ProviderHomePromotionResult> {
  return withPromotionLock(overlay.persistentRoot, async () => {
    const digests = await openDigestManifest(overlay.persistentRoot);
    // Anything the session did not touch still carries the identity proven
    // when it was projected, so promotion hashes the session's actual work
    // rather than the whole private HOME.
    const local = await snapshotManaged(
      overlay.localHome,
      overlay.managed,
      false,
      overlay.projectedDigests
        ? { digests: knownContentDigests(overlay.projectedDigests) }
        : {},
    );
    const host = await snapshotManagedSources(
      overlay.managed,
      overlay.deniedSourceRoots,
      digests,
    );
    if (overlay.credentialSource) {
      const source = await overlay.credentialSource.read();
      if (source.status === "available") {
        host.set(
          overlay.credentialSource.relative,
          credentialSnapshot(
            normalizedCredentialBytes(source.value, overlay.providerId),
          ),
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
      digests,
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
      if (
        overlay.suppressedCredentialRelative &&
        (relativeIsInsideOrEqual(
          relative,
          overlay.suppressedCredentialRelative,
        ) ||
          relativeIsInsideOrEqual(
            overlay.suppressedCredentialRelative,
            relative,
          ))
      ) {
        continue;
      }
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
      if (
        mergeSideMoved(hostBefore, hostNow, next) &&
        !equalEntry(hostNow, next)
      ) {
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
        mergeSideMoved(durableBefore, durableNow, next) &&
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
    await digests.persist();
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
        managedExclusions(item, false),
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

function recoveryRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider HOME recovery marker is malformed");
  }
  return value as Record<string, unknown>;
}

function recoveryString(
  value: unknown,
  label: string,
  maxBytes = 16 * 1024,
): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maxBytes
  ) {
    throw new Error(`provider HOME recovery ${label} is invalid`);
  }
  return value;
}

function recoveryRelative(value: unknown, label: string): string {
  return assertSafeRelative(recoveryString(value, label));
}

function recoveryAbsolute(value: unknown, label: string): string {
  const candidate = recoveryString(value, label);
  if (
    !path.isAbsolute(candidate) ||
    path.dirname(candidate) === candidate ||
    path.resolve(candidate) !== candidate
  ) {
    throw new Error(`provider HOME recovery ${label} is invalid`);
  }
  return candidate;
}

function recoverySnapshot(
  value: unknown,
  durable: boolean,
): DurableEntrySnapshot {
  const record = recoveryRecord(value);
  if (durable && record.kind === "tombstone") return { kind: "tombstone" };
  if (
    record.kind === "file" &&
    typeof record.digest === "string" &&
    /^[a-f0-9]{64}$/.test(record.digest) &&
    (record.mode === 0o600 || record.mode === 0o700)
  ) {
    return { kind: "file", digest: record.digest, mode: record.mode };
  }
  if (
    record.kind === "directory" &&
    typeof record.digest === "string" &&
    /^[a-f0-9]{64}$/.test(record.digest)
  ) {
    return { kind: "directory", digest: record.digest };
  }
  if (record.kind === "symlink") {
    return {
      kind: "symlink",
      target: recoveryString(record.target, "symlink target", 64 * 1024),
    };
  }
  throw new Error("provider HOME recovery snapshot is invalid");
}

function recoverySnapshotMap<T extends EntrySnapshot | DurableEntrySnapshot>(
  value: unknown,
  durable: boolean,
): Map<string, T> {
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_SNAPSHOT_ENTRIES) {
    throw new Error(
      "provider HOME recovery snapshot exceeds its bounded quota",
    );
  }
  const result = new Map<string, T>();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error("provider HOME recovery snapshot is malformed");
    }
    const relative = recoveryRelative(pair[0], "snapshot path");
    if (result.has(relative)) {
      throw new Error("provider HOME recovery snapshot has duplicate paths");
    }
    result.set(relative, recoverySnapshot(pair[1], durable) as T);
  }
  return result;
}

function recoveryStringList(
  value: unknown,
  label: string,
  maximum: number,
  kind: "absolute" | "relative",
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(
      `provider HOME recovery ${label} exceeds its bounded quota`,
    );
  }
  const result = value.map((entry) =>
    kind === "absolute"
      ? recoveryAbsolute(entry, label)
      : recoveryRelative(entry, label),
  );
  return [...new Set(result)];
}

function parseProviderHomeRecoveryHold(
  value: unknown,
): ProviderHomeRecoveryHold {
  const record = recoveryRecord(value);
  const providerId = recoveryString(record.providerId, "provider id", 64);
  if (safeProviderId(providerId) !== providerId) {
    throw new Error("provider HOME recovery provider id is invalid");
  }
  const workspaceRoot = recoveryAbsolute(record.workspaceRoot, "workspace");
  const persistentKey = recoveryString(
    record.persistentKey,
    "persistence key",
    64,
  );
  if (record.version !== 1 || !/^[a-f0-9]{64}$/.test(persistentKey)) {
    throw new Error(
      "provider HOME recovery marker has an unsupported contract",
    );
  }
  if (
    !Array.isArray(record.managed) ||
    record.managed.length === 0 ||
    record.managed.length > MAX_RECOVERY_MANAGED_PATHS
  ) {
    throw new Error("provider HOME recovery managed paths are invalid");
  }
  const allowedManaged = new Set(
    providerManagedPaths(
      providerId,
      path.join(path.parse(workspaceRoot).root, "__zsr_host__"),
      {},
    ).map(({ relative }) => path.normalize(relative)),
  );
  const managed = record.managed.map((entry): ManagedPath => {
    const item = recoveryRecord(entry);
    const relative = recoveryRelative(item.relative, "managed path");
    if (!allowedManaged.has(relative)) {
      throw new Error("provider HOME recovery managed path is unsupported");
    }
    return {
      source: recoveryAbsolute(item.source, "managed source"),
      relative,
      ...(item.excluded === undefined
        ? {}
        : {
            excluded: recoveryStringList(
              item.excluded,
              "managed exclusions",
              256,
              "relative",
            ),
          }),
      ...(item.seedExcluded === undefined
        ? {}
        : {
            seedExcluded: recoveryStringList(
              item.seedExcluded,
              "managed seed exclusions",
              256,
              "relative",
            ),
          }),
    };
  });
  if (
    new Set(managed.map(({ relative }) => relative)).size !== managed.length
  ) {
    throw new Error("provider HOME recovery managed paths contain duplicates");
  }
  const deniedSourceRoots = recoveryStringList(
    record.deniedSourceRoots,
    "denied roots",
    MAX_RECOVERY_DENIED_ROOTS,
    "absolute",
  );
  let credentialSource: ProviderHomeRecoveryHold["credentialSource"];
  if (record.credentialSource !== undefined) {
    const credential = recoveryRecord(record.credentialSource);
    const relative = recoveryRelative(credential.relative, "credential path");
    if (providerCredentialRelative(providerId) !== relative) {
      throw new Error("provider HOME recovery credential path is invalid");
    }
    credentialSource = {
      relative,
      ...(credential.fallbackSnapshot === undefined
        ? {}
        : {
            fallbackSnapshot: recoverySnapshot(
              credential.fallbackSnapshot,
              false,
            ) as EntrySnapshot,
          }),
    };
  }
  let suppressedCredentialRelative: string | undefined;
  if (record.suppressedCredentialRelative !== undefined) {
    suppressedCredentialRelative = recoveryRelative(
      record.suppressedCredentialRelative,
      "suppressed credential path",
    );
    if (
      providerCredentialRelative(providerId) !== suppressedCredentialRelative
    ) {
      throw new Error(
        "provider HOME recovery suppressed credential path is invalid",
      );
    }
  }
  return {
    version: 1,
    providerId,
    workspaceRoot,
    persistentKey,
    managed,
    deniedSourceRoots,
    baselineLocal: [
      ...recoverySnapshotMap<EntrySnapshot>(record.baselineLocal, false),
    ],
    baselineHost: [
      ...recoverySnapshotMap<EntrySnapshot>(record.baselineHost, false),
    ],
    baselinePersistent: [
      ...recoverySnapshotMap<DurableEntrySnapshot>(
        record.baselinePersistent,
        true,
      ),
    ],
    ...(credentialSource ? { credentialSource } : {}),
    ...(suppressedCredentialRelative ? { suppressedCredentialRelative } : {}),
  };
}

async function readProviderHomeRecoveryHold(
  marker: string,
): Promise<ProviderHomeRecoveryHold> {
  const handle = await open(
    marker,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size <= 0 ||
      metadata.size > MAX_RECOVERY_HOLD_BYTES
    ) {
      throw new Error("provider HOME recovery marker has unsafe metadata");
    }
    return parseProviderHomeRecoveryHold(
      JSON.parse((await handle.readFile()).toString("utf8")),
    );
  } finally {
    await handle.close();
  }
}

async function clearProviderHomeRecoveryHold(
  marker: string,
  generationRoot: string,
): Promise<void> {
  await rm(marker, { force: true });
  await syncDirectory(generationRoot);
}

/** Finish provider persistence left by a hard engine crash. Callers must first
 * prove that host process domains and any VM/container mounting the session
 * root are retired. Invalid state is retained for manual recovery; it is never
 * interpreted as deletion authority. */
export async function recoverProviderHomeOverlays(options: {
  readonly sessionsRoot: string;
}): Promise<ProviderHomeRecoveryResult> {
  let sessions;
  try {
    sessions = await readdir(options.sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { discovered: 0, recovered: 0, preserved: 0, conflicts: 0 };
    }
    throw error;
  }
  let discovered = 0;
  let recovered = 0;
  let preserved = 0;
  let conflicts = 0;
  for (const session of sessions) {
    if (!session.isDirectory() || session.isSymbolicLink()) continue;
    const boundaryRoot = path.join(
      options.sessionsRoot,
      session.name,
      "boundary",
    );
    let generations;
    try {
      generations = await readdir(boundaryRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      preserved += 1;
      continue;
    }
    for (const generation of generations) {
      if (!generation.isDirectory() || generation.isSymbolicLink()) continue;
      const generationRoot = path.join(boundaryRoot, generation.name);
      const marker = path.join(
        generationRoot,
        PROVIDER_HOME_RECOVERY_HOLD_FILE,
      );
      let markerMetadata;
      try {
        markerMetadata = await lstat(marker);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        discovered += 1;
        preserved += 1;
        continue;
      }
      if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
        discovered += 1;
        preserved += 1;
        continue;
      }
      discovered += 1;
      let overlay: ProviderHomeOverlay;
      try {
        const hold = await readProviderHomeRecoveryHold(marker);
        const localHome = path.join(generationRoot, "home");
        let localMetadata;
        try {
          localMetadata = await lstat(localHome);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!localMetadata) {
          await clearProviderHomeRecoveryHold(marker, generationRoot);
          recovered += 1;
          continue;
        }
        if (!localMetadata.isDirectory() || localMetadata.isSymbolicLink()) {
          throw new Error(
            "provider HOME recovery source is not a physical directory",
          );
        }
        const persistentRoot = path.join(
          zerosDataDir(),
          "provider-home",
          hold.providerId,
          hold.persistentKey,
        );
        overlay = {
          providerId: hold.providerId,
          workspaceRoot: hold.workspaceRoot,
          localHome,
          persistentRoot,
          contentRoot: path.join(persistentRoot, "content"),
          managed: hold.managed,
          deniedSourceRoots: hold.deniedSourceRoots,
          readOnlyHostRoots: [],
          baselineLocal: new Map(hold.baselineLocal),
          baselineHost: new Map(hold.baselineHost),
          baselinePersistent: new Map(hold.baselinePersistent),
          preparationConflicts: [],
          env: {},
          ...(hold.credentialSource
            ? {
                credentialSource: {
                  relative: hold.credentialSource.relative,
                  read: async () => ({ status: "unavailable" as const }),
                  ...(hold.credentialSource.fallbackSnapshot
                    ? {
                        fallbackSnapshot:
                          hold.credentialSource.fallbackSnapshot,
                      }
                    : {}),
                },
              }
            : {}),
          ...(hold.suppressedCredentialRelative
            ? {
                suppressedCredentialRelative: hold.suppressedCredentialRelative,
              }
            : {}),
        };
      } catch (error) {
        if (process.env.SRT_DEBUG) {
          console.error("[zsr] provider HOME recovery marker retained", error);
        }
        preserved += 1;
        continue;
      }
      try {
        const promotion = await promoteProviderHomeOverlay(overlay);
        conflicts += promotion.conflicts.length;
        await clearProviderHomeRecoveryHold(marker, generationRoot);
        recovered += 1;
      } catch (failure) {
        if (process.env.SRT_DEBUG) {
          console.error(
            "[zsr] provider HOME crash recovery retained for retry",
            failure,
          );
        }
        // Boot recovery owns the complete generation and GC treats the marker
        // as a conservative hold. Keep both marker and source in place so a
        // transient storage/format fault can be repaired and retried on the
        // next boot. Moving the HOME into a manual-only archive and clearing
        // the marker made automatic recovery silently one-shot. Graceful
        // session teardown still uses preserveProviderHomeOverlay because its
        // generation is otherwise expected to be retired immediately.
        preserved += 1;
      }
    }
  }
  return { discovered, recovered, preserved, conflicts };
}

async function pruneArchiveDirectory(
  directory: string,
  now: number,
  retentionMs: number,
  maxEntries: number,
): Promise<{ readonly removed: number; readonly remaining: number }> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { removed: 0, remaining: 0 };
    }
    throw error;
  }
  const archives: Array<{ readonly absolute: string; readonly at: number }> =
    [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    archives.push({ absolute, at: (await lstat(absolute)).mtimeMs });
  }
  archives.sort((left, right) => right.at - left.at);
  let removed = 0;
  for (const [index, archive] of archives.entries()) {
    if (index < maxEntries && now - archive.at <= retentionMs) continue;
    await rm(archive.absolute, { recursive: true, force: true });
    removed += 1;
  }
  return { removed, remaining: archives.length - removed };
}

/** Whether a durable projection holds anything a host copy could not rebuild.
 * A tree too large to walk within the bounded quota counts as holding state:
 * this question may only ever be answered conservatively. */
async function projectionHoldsState(contentRoot: string): Promise<boolean> {
  let entriesSeen = 0;
  const visit = async (absolute: string): Promise<boolean> => {
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    entriesSeen += 1;
    if (entriesSeen > MAX_TREE_ENTRIES) return true;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    for (const entry of await readdir(absolute)) {
      if (await visit(path.join(absolute, entry))) return true;
    }
    return false;
  };
  return visit(contentRoot);
}

async function newestActivityMs(root: string): Promise<number> {
  let newest = (await lstat(root)).mtimeMs;
  for (const entry of await readdir(root)) {
    try {
      newest = Math.max(newest, (await lstat(path.join(root, entry))).mtimeMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return newest;
}

/** Bound the durable provider-state area. Conflict and recovery archives are
 * retained for a human to inspect, not forever. A projection that holds
 * nothing but a rebuildable copy of host state — the exact shape every
 * provider probe left behind before probes were pinned to one stable scope —
 * is reclaimed once it has also gone unused, so the orphans already on disk
 * are collected without asking anyone to delete engine state by hand.
 *
 * Callers must first prove no process domain of a previous engine is live;
 * this runs with the same authority as crash recovery. */
export async function sweepProviderHomeStorage(
  options: {
    readonly now?: number;
    readonly archiveRetentionMs?: number;
    readonly maxArchivesPerRoot?: number;
    readonly unusedProjectionRetentionMs?: number;
  } = {},
): Promise<ProviderHomeStorageSweepResult> {
  const now = options.now ?? Date.now();
  const archiveRetentionMs = options.archiveRetentionMs ?? ARCHIVE_RETENTION_MS;
  const maxArchives = options.maxArchivesPerRoot ?? MAX_ARCHIVES_PER_ROOT;
  const unusedRetentionMs =
    options.unusedProjectionRetentionMs ?? UNUSED_PROJECTION_RETENTION_MS;
  const providerHomeRoot = path.join(zerosDataDir(), "provider-home");
  const parkedWorldsReclaimed = await sweepParkedProviderWorlds(
    now,
    unusedRetentionMs,
  );
  let providers;
  try {
    providers = await readdir(providerHomeRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        archivesRemoved: 0,
        projectionsReclaimed: 0,
        retained: 0,
        parkedWorldsReclaimed,
      };
    }
    throw error;
  }
  let archivesRemoved = 0;
  let projectionsReclaimed = 0;
  let retained = 0;
  for (const provider of providers) {
    if (!provider.isDirectory() || provider.isSymbolicLink()) continue;
    const providerRoot = path.join(providerHomeRoot, provider.name);
    for (const projection of await readdir(providerRoot, {
      withFileTypes: true,
    })) {
      if (!projection.isDirectory() || projection.isSymbolicLink()) continue;
      const persistentRoot = path.join(providerRoot, projection.name);
      let reclaimable = false;
      try {
        // Read activity before the promotion lock: acquiring it writes into
        // the projection and would make every root look freshly used.
        const idleFor = now - (await newestActivityMs(persistentRoot));
        await withPromotionLock(persistentRoot, async () => {
          let remainingArchives = 0;
          for (const archive of ARCHIVE_DIRECTORIES) {
            const pruned = await pruneArchiveDirectory(
              path.join(persistentRoot, archive),
              now,
              archiveRetentionMs,
              maxArchives,
            );
            archivesRemoved += pruned.removed;
            remainingArchives += pruned.remaining;
          }
          if (idleFor <= unusedRetentionMs || remainingArchives > 0) return;
          const state = await readDurableState(persistentRoot);
          if (
            state.tombstones.length > 0 ||
            Object.keys(state.hostBases).length > 0
          ) {
            return;
          }
          try {
            // A credential marker means this projection is the record of what
            // was last seeded from the keychain. Never reclaim it silently.
            await lstat(path.join(persistentRoot, CREDENTIAL_SOURCE_FILE));
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          reclaimable = !(await projectionHoldsState(
            path.join(persistentRoot, "content"),
          ));
        });
      } catch (error) {
        if (process.env.SRT_DEBUG) {
          console.error("[zsr] provider state projection retained", error);
        }
        retained += 1;
        continue;
      }
      if (!reclaimable) continue;
      await rm(persistentRoot, { recursive: true, force: true });
      projectionsReclaimed += 1;
    }
  }
  return {
    archivesRemoved,
    projectionsReclaimed,
    retained,
    parkedWorldsReclaimed,
  };
}

/** Bound the parked-world area, which the projection sweep above deliberately
 * cannot see (§20.3).
 *
 * Two rules, both provable rather than incidental. Any `building-`/`claimed-`/
 * `stale-` directory older than an hour is debris from an interrupted build or
 * adoption — a build takes a second, and a live one is protected by being newer,
 * not by being listed. And a `current` nothing has adopted for longer than the
 * projection retention is dead weight: its stamp almost certainly no longer
 * matches, and a miss costs an admission the full build anyway.
 *
 * Deleting a parked world can never lose state. It holds only a rebuildable
 * projection of the host tree and the durable store, both of which outlive it. */
async function sweepParkedProviderWorlds(
  now: number,
  unusedRetentionMs: number,
): Promise<number> {
  const parkedRoot = path.join(zerosDataDir(), PARKED_WORLD_DIRECTORY);
  let providers;
  try {
    providers = await readdir(parkedRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let reclaimed = 0;
  for (const provider of providers) {
    if (!provider.isDirectory() || provider.isSymbolicLink()) continue;
    const providerRoot = path.join(parkedRoot, provider.name);
    for (const key of await readdir(providerRoot, { withFileTypes: true })) {
      if (!key.isDirectory() || key.isSymbolicLink()) continue;
      const keyRoot = path.join(providerRoot, key.name);
      for (const entry of await readdir(keyRoot, { withFileTypes: true })) {
        const absolute = path.join(keyRoot, entry.name);
        if (
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          entry.name === PARK_WARM_INPUTS_FILE
        ) {
          // The recorded prewarm inputs outlive the world they describe: they
          // are what lets a boot refill this key at all.
          continue;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          await rm(absolute, { recursive: true, force: true });
          continue;
        }
        const debris =
          entry.name.startsWith("building-") ||
          entry.name.startsWith("claimed-") ||
          entry.name.startsWith("stale-");
        if (!debris && entry.name !== PARK_CURRENT_DIRECTORY) {
          await rm(absolute, { recursive: true, force: true });
          reclaimed += 1;
          continue;
        }
        let age: number;
        try {
          age = now - (await lstat(absolute)).mtimeMs;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (age <= (debris ? PARK_DEBRIS_RETENTION_MS : unusedRetentionMs)) {
          continue;
        }
        await rm(absolute, { recursive: true, force: true });
        reclaimed += 1;
      }
    }
  }
  return reclaimed;
}

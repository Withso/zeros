// Zeros-owned git credential broker.
//
// Git receives credentials through its native credential-helper protocol. The
// helper is host-scoped on each invocation and reads the current credential
// from this same-user unix socket, so for GIT no token is written into a remote
// URL, process argument, git config file, or child-process environment.
//
// `gh` is the documented exception: the GitHub CLI has no credential-helper or
// askpass equivalent, so the only way to hand it a token is `GH_TOKEN` in its
// environment — which any child of that process can read. The `gh` shim below
// therefore fetches the token per invocation and exports it only for gh's own
// API subcommands, excluding the ones that execute arbitrary scripts
// (extensions, aliases, completions) and gh's own auth management.

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { accessSync, constants as fsConstants } from "node:fs";
import { chmod, chown, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface GitCredentialRequest {
  contextId: string;
  protocol: "http" | "https";
  /** Lowercase hostname without a port. */
  host: string;
  /** Hostname plus an optional port, exactly as Git supplied it. */
  authority: string;
  /** Optional URL username and path used by host helpers with useHttpPath. */
  username?: string;
  path?: string;
}

export interface GitCredential {
  username: string;
  password: string;
  /** Unix epoch seconds, understood by Git 2.40+. */
  passwordExpiryUtc?: number;
}

export interface GitCredentialSource {
  /** A synchronous, secret-free routing decision. */
  supports(request: GitCredentialRequest): boolean;
  /** Optional async ownership check. Returning true keeps the request
   * fail-closed even when the selected method has no usable credential yet;
   * returning false preserves the user's ambient helper chain. */
  shouldHandle?(request: GitCredentialRequest): Promise<boolean>;
  getCredential(request: GitCredentialRequest): Promise<GitCredential | null>;
  /** Non-secret identity of the credential used when an invocation starts. */
  credentialFingerprint?(request: GitCredentialRequest): Promise<string | null>;
  /** Rotate a credential after the remote explicitly rejects that exact
   * fingerprint. Returns true only when retrying can read a different value. */
  refreshAfterAuthenticationFailure?(
    request: GitCredentialRequest,
    rejectedFingerprint: string,
  ): Promise<boolean>;
}

export interface GitCredentialInvocation {
  gitConfigArgs: string[];
  env: Record<string, string>;
  request: GitCredentialRequest;
  credentialFingerprint: string | null;
  /** Releases an invocation-scoped ambient credential grant. Provider-backed
   * invocations read their rotating source lazily and do not need one. */
  release?(): void;
}

export interface AmbientGitCredentialOptions {
  /** Trusted, absolute Git executable selected before agent admission. */
  gitBinary: string;
  /** Canonical host HOME whose human-owned credential helpers are consulted. */
  home: string;
  xdgConfigHome?: string;
}

export interface GitCredentialShellEnvironment {
  env: Record<string, string>;
}

export interface GitCredentialShellConsumerIdentity {
  uid: number;
  gid: number;
}

let credentialSource: GitCredentialSource | null = null;
let broker: GitCredentialBroker | null = null;
let brokerStart: Promise<GitCredentialBroker> | null = null;

/** Install the process-local source used by the engine's broker. No credential
 *  is read until Git invokes the helper. */
export function setGitCredentialSource(
  source: GitCredentialSource | null,
): void {
  credentialSource = source;
}

export function setGitCredentialSourceForTesting(
  source: GitCredentialSource | null,
): void {
  setGitCredentialSource(source);
}

function safeProtocol(value: string | null): "http" | "https" | null {
  return value === "http" || value === "https" ? value : null;
}

function parseAuthority(
  protocol: "http" | "https",
  authority: string,
): { host: string; authority: string } | null {
  if (
    !authority ||
    authority.length > 300 ||
    /[\s/\\@?#\0\r\n]/.test(authority)
  ) {
    return null;
  }
  try {
    const parsed = new URL(`${protocol}://${authority}`);
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return {
      host: parsed.hostname.toLowerCase(),
      authority: parsed.host.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function safeCredentialValue(value: string): boolean {
  return value.length > 0 && !/[\0\r\n]/.test(value);
}

function optionalCredentialField(
  value: string | null,
  maximum: number,
): string | undefined {
  if (!value) return undefined;
  if (value.length > maximum || /[\0\r\n]/.test(value)) return undefined;
  return value;
}

function sameCredentialRequest(
  left: GitCredentialRequest,
  right: GitCredentialRequest,
): boolean {
  return (
    left.contextId === right.contextId &&
    left.protocol === right.protocol &&
    left.host === right.host &&
    left.authority === right.authority &&
    (left.username ?? "") === (right.username ?? "") &&
    (left.path ?? "") === (right.path ?? "")
  );
}

/** Git runs a `credential.*.helper` value through `sh -c` as soon as it contains
 *  whitespace, so an unquoted path under a TMPDIR with a space silently became
 *  two words — and the URL-scoped reset beside it then left the host with NO
 *  helper at all, turning a working credential into a hard auth failure. The `!`
 *  prefix makes the shell form explicit and the quoting unambiguous. */
function shellQuotedHelper(helperPath: string): string {
  return `!'${helperPath.replaceAll("'", `'\\''`)}'`;
}

async function ensureBroker(): Promise<GitCredentialBroker> {
  if (broker) return broker;
  if (!brokerStart) {
    brokerStart = GitCredentialBroker.start().then(
      (started) => {
        broker = started;
        return started;
      },
      (error) => {
        brokerStart = null;
        throw error;
      },
    );
  }
  return brokerStart;
}

/** Prepare one network git invocation. The source decides whether Zeros owns
 *  this host/method; unsupported hosts retain the user's normal helper chain. */
export async function prepareGitCredentialInvocation(
  request: GitCredentialRequest,
  options: {
    ambient?: AmbientGitCredentialOptions;
    consumerIdentity?: GitCredentialShellConsumerIdentity;
  } = {},
): Promise<GitCredentialInvocation | null> {
  const source = credentialSource;
  const sourceOwns =
    source?.supports(request) &&
    (!source.shouldHandle || (await source.shouldHandle(request)));
  if (!sourceOwns && !options.ambient) return null;
  const activeBroker = await ensureBroker();
  if (options.consumerIdentity) {
    await activeBroker.grantConsumer(options.consumerIdentity);
  }
  if (sourceOwns && source) {
    const credentialFingerprint = source.credentialFingerprint
      ? await source.credentialFingerprint(request)
      : null;
    return activeBroker.invocation(request, credentialFingerprint);
  }
  if (!options.ambient) return null;
  const credential = await readAmbientGitCredential(
    request,
    options.ambient,
    activeBroker.helpersDir,
  );
  if (!credential) return null;
  return activeBroker.grantInvocation(request, credential);
}

/** Give the same source that owns the broker a chance to replace a rejected
 * credential. The fingerprint is safe to retain in an invocation; raw secrets
 * never enter command arguments, errors, or the child environment. */
export async function refreshGitCredentialAfterAuthenticationFailure(
  invocation: GitCredentialInvocation,
): Promise<boolean> {
  const source = credentialSource;
  if (
    !source?.refreshAfterAuthenticationFailure ||
    !invocation.credentialFingerprint ||
    !source.supports(invocation.request)
  ) {
    return false;
  }
  try {
    return await source.refreshAfterAuthenticationFailure(
      invocation.request,
      invocation.credentialFingerprint,
    );
  } catch {
    return false;
  }
}

function findExecutable(name: string, pathValue: string): string | null {
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* next PATH entry */
    }
  }
  return null;
}

const AMBIENT_CREDENTIAL_OUTPUT_LIMIT = 1024 * 1024;

function ambientCredentialEnvironment(
  options: AmbientGitCredentialOptions,
): Record<string, string> {
  if (
    !path.isAbsolute(options.gitBinary) ||
    options.gitBinary.includes("\0") ||
    !path.isAbsolute(options.home) ||
    options.home.includes("\0") ||
    (options.xdgConfigHome !== undefined &&
      (!path.isAbsolute(options.xdgConfigHome) ||
        options.xdgConfigHome.includes("\0")))
  ) {
    throw new Error("ambient Git credential configuration is invalid");
  }
  const allowed = [
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "TMPDIR",
    "USER",
    "WAYLAND_DISPLAY",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
  ] as const;
  const env: Record<string, string> = {
    HOME: options.home,
    PATH:
      process.env.PATH ??
      "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "/usr/bin/false",
  };
  if (options.xdgConfigHome) env.XDG_CONFIG_HOME = options.xdgConfigHome;
  for (const name of allowed) {
    const value = process.env[name];
    if (value && !value.includes("\0")) env[name] = value;
  }
  return env;
}

function parseAmbientCredential(
  stdout: string,
  request: GitCredentialRequest,
): GitCredential | null {
  if (Buffer.byteLength(stdout) > AMBIENT_CREDENTIAL_OUTPUT_LIMIT) return null;
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) return null;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^[a-z_][a-z0-9_]{0,63}$/i.test(key) || /[\0\r\n]/.test(value)) {
      return null;
    }
    fields.set(key, value);
  }
  const username = fields.get("username") ?? request.username ?? "";
  const password = fields.get("password") ?? "";
  if (!safeCredentialValue(username) || !safeCredentialValue(password)) {
    return null;
  }
  const rawExpiry = fields.get("password_expiry_utc");
  const passwordExpiryUtc =
    rawExpiry === undefined ? undefined : Number(rawExpiry);
  if (
    passwordExpiryUtc !== undefined &&
    (!Number.isSafeInteger(passwordExpiryUtc) || passwordExpiryUtc <= 0)
  ) {
    return null;
  }
  return {
    username,
    password,
    ...(passwordExpiryUtc !== undefined ? { passwordExpiryUtc } : {}),
  };
}

/** Resolve the user's ordinary global/system helper chain outside any
 * repository. The remote must already have been admitted by the caller. This
 * keeps repository-local helpers and includes from becoming an engine
 * confused deputy while retaining Keychain/libsecret/GCM parity. */
async function readAmbientGitCredential(
  request: GitCredentialRequest,
  options: AmbientGitCredentialOptions,
  cwd: string,
): Promise<GitCredential | null> {
  const input = [
    `protocol=${request.protocol}`,
    `host=${request.authority}`,
    ...(request.username ? [`username=${request.username}`] : []),
    ...(request.path ? [`path=${request.path}`] : []),
    "",
  ].join("\n");
  return new Promise((resolve) => {
    const child = execFile(
      options.gitBinary,
      ["credential", "fill"],
      {
        cwd,
        encoding: "utf8",
        env: ambientCredentialEnvironment(options),
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: AMBIENT_CREDENTIAL_OUTPUT_LIMIT,
      },
      (error, stdout) => {
        // Credential helper diagnostics can contain secrets. Treat every
        // failure as an unavailable ambient credential and never propagate or
        // log its stderr across the broker boundary.
        resolve(error ? null : parseAmbientCredential(stdout, request));
      },
    );
    child.stdin?.end(input);
  });
}

/** Prepare a workspace shell/agent PATH shim.
 *
 * The parent shell receives socket coordinates and real binary paths, never a
 * credential. The shims fetch the current selected credential only for one
 * `git`/`gh` invocation, allowing later method changes without respawning the
 * terminal.
 */
export async function prepareGitCredentialShellEnvironment(
  contextId: string,
  pathValue: string,
  consumerIdentity?: GitCredentialShellConsumerIdentity,
): Promise<GitCredentialShellEnvironment | null> {
  const request: GitCredentialRequest = {
    contextId,
    protocol: "https",
    host: "github.com",
    authority: "github.com",
  };
  // Install the shims even while the selected method is temporarily missing a
  // credential. A terminal can outlive a browser/CLI login or a method switch;
  // fetching from the broker on each invocation lets that existing terminal
  // observe the new selection without being respawned.
  if (!credentialSource?.supports(request)) return null;
  const activeBroker = await ensureBroker();
  if (consumerIdentity) await activeBroker.grantConsumer(consumerIdentity);
  const realGit = findExecutable("git", pathValue);
  if (!realGit) return null;
  const realGh = findExecutable("gh", pathValue);
  return {
    env: {
      ZEROS_GIT_AUTH_CONTEXT: contextId,
      ZEROS_GIT_AUTH_SOCKET: activeBroker.socketPath,
      // A plain path: consumers may spawn it directly. The git shim adds the
      // shell quoting itself, because only git re-parses the value.
      ZEROS_GIT_AUTH_HELPER: activeBroker.helperPath,
      ZEROS_GIT_AUTH_ASKPASS: activeBroker.askpassPath,
      ZEROS_REAL_GIT_PATH: realGit,
      // Same-host native shells can prove a hard-killed engine cheaply with
      // kill(0). A qualified cloud consumer may have another PID namespace,
      // so it uses the socket health check in the shim instead.
      ...(!consumerIdentity
        ? { ZEROS_GIT_AUTH_BROKER_PID: String(process.pid) }
        : {}),
      ...(realGh ? { ZEROS_REAL_GH_PATH: realGh } : {}),
      PATH: `${activeBroker.helpersDir}${path.delimiter}${pathValue}`,
    },
  };
}

export async function closeGitCredentialBroker(): Promise<void> {
  const active =
    broker ?? (brokerStart ? await brokerStart.catch(() => null) : null);
  broker = null;
  brokerStart = null;
  if (active) await active.close();
}

export async function closeGitCredentialBrokerForTesting(): Promise<void> {
  await closeGitCredentialBroker();
}

class GitCredentialBroker {
  private grantedConsumer: GitCredentialShellConsumerIdentity | null = null;
  private readonly ambientGrants = new Map<
    string,
    {
      request: GitCredentialRequest;
      credential: GitCredential;
      expiresAt: number;
    }
  >();

  private constructor(
    private readonly server: Server,
    readonly socketPath: string,
    readonly helpersDir: string,
    readonly helperPath: string,
    readonly askpassPath: string,
    private readonly executablePaths: readonly string[],
  ) {}

  invocation(
    request: GitCredentialRequest,
    credentialFingerprint: string | null,
    grant?: string,
  ): GitCredentialInvocation {
    return {
      // The empty URL-scoped value resets every inherited helper for this host
      // before the Zeros helper is installed. Keeping the reset URL-scoped is
      // important for commands such as `git fetch --all`: one credential must
      // not disable the user's helper for a second authority.
      gitConfigArgs: [
        "-c",
        `credential.${request.protocol}://${request.authority}.helper=`,
        "-c",
        `credential.${request.protocol}://${request.authority}.helper=${shellQuotedHelper(
          this.helperPath,
        )}`,
      ],
      env: {
        ZEROS_GIT_AUTH_CONTEXT: request.contextId,
        ZEROS_GIT_AUTH_SOCKET: this.socketPath,
        ZEROS_GIT_AUTH_PROTOCOL: request.protocol,
        ZEROS_GIT_AUTH_HOST: request.authority,
        ...(request.username
          ? { ZEROS_GIT_AUTH_USERNAME: request.username }
          : {}),
        ...(request.path ? { ZEROS_GIT_AUTH_PATH: request.path } : {}),
        ...(grant ? { ZEROS_GIT_AUTH_GRANT: grant } : {}),
        GIT_ASKPASS: this.askpassPath,
        GIT_TERMINAL_PROMPT: "0",
      },
      request,
      credentialFingerprint,
      ...(grant
        ? {
            release: () => {
              this.ambientGrants.delete(grant);
            },
          }
        : {}),
    };
  }

  grantInvocation(
    request: GitCredentialRequest,
    credential: GitCredential,
  ): GitCredentialInvocation {
    if (
      !safeCredentialValue(credential.username) ||
      !safeCredentialValue(credential.password) ||
      (credential.passwordExpiryUtc !== undefined &&
        (!Number.isSafeInteger(credential.passwordExpiryUtc) ||
          credential.passwordExpiryUtc <= 0))
    ) {
      throw new Error("ambient Git credential is invalid");
    }
    const now = Date.now();
    for (const [grant, value] of this.ambientGrants) {
      if (value.expiresAt <= now) this.ambientGrants.delete(grant);
    }
    if (this.ambientGrants.size >= 256) {
      throw new Error("too many ambient Git credential grants are active");
    }
    const grant = randomBytes(32).toString("hex");
    this.ambientGrants.set(grant, {
      request: { ...request },
      credential: { ...credential },
      expiresAt: now + 5 * 60_000,
    });
    return this.invocation(request, null, grant);
  }

  /** Make the broker consumable by the attested cloud worker without making
   * it worker-owned. The root coordinator remains the owner; the one dedicated
   * worker group gets traverse/execute access to immutable shims and connect
   * access to the socket. Contained agents receive a private scratch `/tmp`
   * and no socket coordinates, so this projection reaches only the explicit
   * human terminal outside agent containment. */
  async grantConsumer(
    identity: GitCredentialShellConsumerIdentity,
  ): Promise<void> {
    if (
      process.platform !== "linux" ||
      !Number.isSafeInteger(identity.uid) ||
      identity.uid <= 0 ||
      !Number.isSafeInteger(identity.gid) ||
      identity.gid <= 0
    ) {
      throw new Error("git credential consumer identity is invalid");
    }
    if (this.grantedConsumer) {
      if (
        this.grantedConsumer.uid !== identity.uid ||
        this.grantedConsumer.gid !== identity.gid
      ) {
        throw new Error("git credential broker already has another consumer");
      }
      return;
    }
    const ownerUid = process.geteuid?.();
    const ownerGid = process.getegid?.();
    const supplementaryGroups = process.getgroups?.() ?? [];
    if (
      ownerUid === undefined ||
      ownerGid === undefined ||
      (ownerUid !== 0 &&
        (identity.uid !== ownerUid ||
          (identity.gid !== ownerGid &&
            !supplementaryGroups.includes(identity.gid))))
    ) {
      throw new Error("git credential consumer grant requires owner authority");
    }

    const socketDir = path.dirname(this.socketPath);
    // Change ownership while both parent directories are still 0700. Only
    // after every leaf is root/owner-controlled and group-readable do we open
    // the final traverse bits, avoiding a partially-published projection.
    for (const candidate of [
      socketDir,
      this.socketPath,
      this.helpersDir,
      ...this.executablePaths,
    ]) {
      await chown(candidate, ownerUid, identity.gid);
    }
    await chmod(this.socketPath, 0o660);
    for (const candidate of this.executablePaths) {
      await chmod(candidate, 0o750);
    }
    await chmod(this.helpersDir, 0o750);
    await chmod(socketDir, 0o710);
    this.grantedConsumer = { ...identity };
  }

  static async start(): Promise<GitCredentialBroker> {
    const helpersDir = await mkdtemp(path.join(tmpdir(), "zeros-git-auth-"));
    const helperPath = path.join(helpersDir, "git-credential-zeros");
    const askpassPath = path.join(helpersDir, "git-askpass-zeros");
    const gitShimPath = path.join(helpersDir, "git");
    const ghShimPath = path.join(helpersDir, "gh");
    // Keep the socket pathname short: macOS sockaddr_un.sun_path is only 104
    // bytes, while its per-user TMPDIR can already approach that limit.
    //
    // The socket lives inside its own 0700 directory rather than directly in the
    // world-writable /tmp, because `listen()` creates it with `0777 & ~umask` and
    // the chmod to 0600 lands only afterwards. Under a permissive umask that
    // window is connectable by another local account; an unreachable parent
    // closes it without depending on the process umask.
    const socketDir = await mkdtemp(path.join("/tmp", "zeros-ga-"));
    await chmod(socketDir, 0o700);
    const socketPath = path.join(socketDir, "s");

    await writeFile(helperPath, CREDENTIAL_HELPER_SCRIPT, {
      encoding: "utf8",
      mode: 0o700,
    });
    await writeFile(askpassPath, ASKPASS_SCRIPT, {
      encoding: "utf8",
      mode: 0o700,
    });
    await writeFile(gitShimPath, GIT_SHIM_SCRIPT, {
      encoding: "utf8",
      mode: 0o700,
    });
    await writeFile(ghShimPath, GH_SHIM_SCRIPT, {
      encoding: "utf8",
      mode: 0o700,
    });

    let owner: GitCredentialBroker | null = null;
    const server = createServer(async (req, res) => {
      if (req.method !== "GET" || !req.url) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/health") {
        res.statusCode = 204;
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return;
      }
      if (url.pathname !== "/credential") {
        res.statusCode = 404;
        res.end();
        return;
      }

      const protocol = safeProtocol(url.searchParams.get("protocol"));
      const parsedAuthority = protocol
        ? parseAuthority(protocol, url.searchParams.get("host") ?? "")
        : null;
      const contextId = url.searchParams.get("context") ?? "";
      const rawUsername = url.searchParams.get("username");
      const rawCredentialPath = url.searchParams.get("path");
      const username = optionalCredentialField(rawUsername, 1_024);
      const credentialPath = optionalCredentialField(rawCredentialPath, 16_384);
      const grant = url.searchParams.get("grant") ?? "";
      if (
        !protocol ||
        !parsedAuthority ||
        contextId.length === 0 ||
        contextId.length > 500 ||
        /[\0\r\n]/.test(contextId) ||
        (Boolean(rawUsername) && !username) ||
        (Boolean(rawCredentialPath) && !credentialPath) ||
        (grant !== "" && !/^[0-9a-f]{64}$/.test(grant))
      ) {
        res.statusCode = 400;
        res.end();
        return;
      }

      const request: GitCredentialRequest = {
        contextId,
        protocol,
        ...parsedAuthority,
        ...(username ? { username } : {}),
        ...(credentialPath ? { path: credentialPath } : {}),
      };
      if (grant) {
        const scoped = owner?.ambientGrants.get(grant);
        if (
          !scoped ||
          scoped.expiresAt <= Date.now() ||
          !sameCredentialRequest(scoped.request, request)
        ) {
          owner?.ambientGrants.delete(grant);
          res.statusCode = 403;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(
          [
            `username=${scoped.credential.username}`,
            `password=${scoped.credential.password}`,
            ...(scoped.credential.passwordExpiryUtc !== undefined
              ? [`password_expiry_utc=${scoped.credential.passwordExpiryUtc}`]
              : []),
            "",
          ].join("\n"),
        );
        return;
      }
      const source = credentialSource;
      if (!source?.supports(request)) {
        res.statusCode = 204;
        res.end();
        return;
      }

      try {
        const owned = source.shouldHandle
          ? await source.shouldHandle(request)
          : false;
        if (source.shouldHandle && !owned) {
          res.statusCode = 204;
          res.end();
          return;
        }
        const credential = await source.getCredential(request);
        if (!credential) {
          if (owned) {
            // Git's credential protocol recognizes `quit=1` as an instruction
            // to stop the helper chain. This is the terminal-shim equivalent
            // of the URL-scoped empty-helper reset used by direct engine Git:
            // a selected-but-refreshing App/PAT must never borrow a different
            // account from the user's ambient macOS credential helper.
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end("quit=1\n");
          } else {
            res.statusCode = 204;
            res.end();
          }
          return;
        }
        if (
          !safeCredentialValue(credential.username) ||
          !safeCredentialValue(credential.password)
        ) {
          res.statusCode = 500;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(
          [
            `username=${credential.username}`,
            `password=${credential.password}`,
            ...(credential.passwordExpiryUtc !== undefined
              ? [`password_expiry_utc=${credential.passwordExpiryUtc}`]
              : []),
            "",
          ].join("\n"),
        );
      } catch {
        // A source error is intentionally opaque. The exception may contain an
        // upstream response or credential metadata and must not cross the
        // same-user helper boundary.
        res.statusCode = 503;
        res.end();
      }
    });
    owner = new GitCredentialBroker(
      server,
      socketPath,
      helpersDir,
      helperPath,
      askpassPath,
      [helperPath, askpassPath, gitShimPath, ghShimPath],
    );

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o600);
      server.unref();
      return owner;
    } catch (error) {
      server.close();
      await rm(socketDir, { recursive: true, force: true }).catch(() => {});
      await rm(helpersDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    this.ambientGrants.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    await rm(path.dirname(this.socketPath), {
      recursive: true,
      force: true,
    }).catch(() => {});
    await rm(this.helpersDir, { recursive: true, force: true }).catch(() => {});
  }
}

const CREDENTIAL_HELPER_SCRIPT = `#!/bin/sh
set -eu

[ "\${1:-}" = "get" ] || exit 0

protocol=""
host=""
username="\${ZEROS_GIT_AUTH_USERNAME:-}"
path="\${ZEROS_GIT_AUTH_PATH:-}"
while IFS='=' read -r key value; do
  [ -n "$key" ] || break
  case "$key" in
    protocol) protocol="$value" ;;
    host) host="$value" ;;
    username) username="$value" ;;
    path) path="$value" ;;
  esac
done

case "$protocol" in
  http|https) ;;
  *) exit 0 ;;
esac
[ -n "$host" ] || exit 0

exec curl --silent --show-error --fail \\
  --connect-timeout 1 \\
  --max-time 5 \\
  --unix-socket "$ZEROS_GIT_AUTH_SOCKET" \\
  --get \\
  --data-urlencode "context=$ZEROS_GIT_AUTH_CONTEXT" \\
  --data-urlencode "protocol=$protocol" \\
  --data-urlencode "host=$host" \\
  --data-urlencode "username=$username" \\
  --data-urlencode "path=$path" \\
  --data-urlencode "grant=\${ZEROS_GIT_AUTH_GRANT:-}" \\
  "http://localhost/credential"
`;

const ASKPASS_SCRIPT = `#!/bin/sh
set -eu

# Git conveys the host it wants ONLY inside the prompt text, e.g.
# "Password for 'https://x-access-token@github.com'". Unlike the URL-scoped
# credential helper, GIT_ASKPASS is process-global and is inherited by every
# child git — so a redirect target, a submodule, or an LFS remote on ANOTHER
# host would otherwise be handed this invocation's GitHub credential. Answer
# only for the authority this invocation was scoped to.
case "\${1:-}" in
  *"://$ZEROS_GIT_AUTH_HOST'"*|*"://$ZEROS_GIT_AUTH_HOST/"*) ;;
  *"@$ZEROS_GIT_AUTH_HOST'"*|*"@$ZEROS_GIT_AUTH_HOST/"*) ;;
  *) exit 1 ;;
esac

credential="$(
  curl --silent --show-error --fail \\
    --connect-timeout 1 \\
    --max-time 5 \\
    --unix-socket "$ZEROS_GIT_AUTH_SOCKET" \\
    --get \\
    --data-urlencode "context=$ZEROS_GIT_AUTH_CONTEXT" \\
    --data-urlencode "protocol=$ZEROS_GIT_AUTH_PROTOCOL" \\
    --data-urlencode "host=$ZEROS_GIT_AUTH_HOST" \\
    --data-urlencode "username=\${ZEROS_GIT_AUTH_USERNAME:-}" \\
    --data-urlencode "path=\${ZEROS_GIT_AUTH_PATH:-}" \\
    --data-urlencode "grant=\${ZEROS_GIT_AUTH_GRANT:-}" \\
    "http://localhost/credential"
)"

case "\${1:-}" in
  *Username*|*username*) printf '%s\\n' "$credential" | sed -n 's/^username=//p' ;;
  *Password*|*password*) printf '%s\\n' "$credential" | sed -n 's/^password=//p' ;;
  *) exit 1 ;;
esac
`;

const GIT_SHIM_SCRIPT = `#!/bin/sh
set -eu

real="\${ZEROS_REAL_GIT_PATH:?}"
helper="\${ZEROS_GIT_AUTH_HELPER:?}"

# A hard-killed engine can leave this shim and its unix-socket inode on PATH.
# Native same-host shells use a cheap PID liveness check. Consumers in another
# PID namespace probe the projected socket. Only a dead process or
# connection-refused falls back; a timeout/HTTP error retains fail-closed
# broker behavior so a busy engine cannot select another ambient account.
broker_pid="\${ZEROS_GIT_AUTH_BROKER_PID:-}"
if [ -n "$broker_pid" ]; then
  if ! kill -0 "$broker_pid" 2>/dev/null; then
    exec "$real" "$@"
  fi
fi
set +e
curl --silent --fail \\
  --connect-timeout 1 \\
  --max-time 2 \\
  --unix-socket "$ZEROS_GIT_AUTH_SOCKET" \\
  "http://localhost/health" >/dev/null 2>&1
broker_status="$?"
set -e
if [ "$broker_status" -eq 7 ]; then
  exec "$real" "$@"
fi

# Apply the reset and broker only to github.com. Git's URL matching means a
# GitLab/Bitbucket/self-hosted request in the same command retains its normal
# helper chain. Injecting this for every invocation also covers network access
# hidden behind git-lfs, submodules, aliases, and future Git subcommands.
exec "$real" \\
  -c credential.https://github.com.helper= \\
  -c "credential.https://github.com.helper=!'$helper'" \\
  "$@"
`;

const GH_SHIM_SCRIPT = `#!/bin/sh
set -eu

real="\${ZEROS_REAL_GH_PATH:-}"
[ -n "$real" ] || {
  printf '%s\\n' "GitHub CLI is not installed." >&2
  exit 127
}

# Authentication management belongs to the real gh config store. In
# particular, a selected PAT must not become GH_TOKEN for gh-auth-login,
# which would make gh refuse to start its interactive login flow.
#
# The other exempt subcommands run code rather than call the API: an extension,
# an alias, or a completion script is arbitrary user- or repo-supplied shell,
# and gh has no askpass equivalent — a token can only reach it through the
# environment, where any child can read it from /proc/<pid>/environ. Excluding
# them keeps the exported token to gh's own API calls.
case "\${1:-}" in
  auth | extension | extensions | alias | completion | config | help | version)
    unset GH_TOKEN GITHUB_TOKEN
    exec "$real" "$@"
    ;;
esac

# Never fail the user's command because the broker is gone: an engine that was
# SIGKILLed leaves these shims on PATH with no socket behind them, and a hard
# curl error there would brick gh in every already-open terminal. Fall through
# to the real binary and let gh use its own configured auth.
credential="$(
  curl --silent --fail \\
    --unix-socket "\${ZEROS_GIT_AUTH_SOCKET:-/nonexistent}" \\
    --get \\
    --data-urlencode "context=\${ZEROS_GIT_AUTH_CONTEXT:-}" \\
    --data-urlencode "protocol=https" \\
    --data-urlencode "host=github.com" \\
    "http://localhost/credential" 2>/dev/null
)" || credential=""
token="$(printf '%s\\n' "$credential" | sed -n 's/^password=//p')"
if [ -z "$token" ]; then
  if printf '%s\\n' "$credential" | grep -q '^quit=1$'; then
    printf '%s\\n' "No usable credential is available for the selected GitHub authentication method." >&2
    exit 1
  fi
  exec "$real" "$@"
fi

GH_TOKEN="$token" exec "$real" "$@"
`;

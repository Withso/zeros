import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import { redactSensitive } from "@zeros/protocol/scrub";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 16 * 60_000;
const MAX_ACTIVE_CONNECTIONS = 64;

export interface ShadowGitRemoteResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Optional network-free Git operation to execute inside the boundary after
   * a trusted fetch (for example merge/rebase for `git pull`). */
  readonly followUpArgs?: readonly string[];
  /** Ordered network-free Git commands to run inside the boundary. */
  readonly followUpCommands?: readonly (readonly string[])[];
  /** Opaque staging identifier released after all follow-ups exit. */
  readonly cleanupId?: string;
  /** The trusted broker deliberately declined this transport; execute the
   * original command natively inside ZSR (local/file/custom transports). */
  readonly delegateNative?: boolean;
}

export type ShadowGitRemoteOperation = "push" | "fetch" | "pull";
export type ShadowGitLocalOperation =
  | "checkout"
  | "switch"
  | "reset"
  | "restore"
  | "clean"
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert"
  | "stash"
  | "rm"
  | "mv";
export type ShadowGitBrokerOperation =
  | ShadowGitRemoteOperation
  | ShadowGitLocalOperation;

const BROKER_OPERATIONS = new Set<ShadowGitBrokerOperation>([
  "push",
  "fetch",
  "pull",
  "checkout",
  "switch",
  "reset",
  "restore",
  "clean",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "stash",
  "rm",
  "mv",
]);

export interface ShadowGitRemoteBrokerOptions {
  readonly toolsRoot: string;
  /** The repository's private Git root, passed rather than derived.
   *
   * It used to be computed as `dirname(toolsRoot)/git`, which is only the layout
   * a standalone session happens to have. Under a `ShadowGitCollection` the two
   * roots are siblings of different parents — `<shadow>/<id>/git` against
   * `<tools>/git-repositories/<id>` — so the derived path named a directory that
   * does not exist, `realpathSync` threw, and the client's linked-worktree
   * branch could never match. Every production boundary is a collection, and the
   * overrides that branch exists to drop are set only on darwin, so the whole
   * failure was invisible to a suite that runs on Linux. */
  readonly shadowRoot: string;
  readonly runtime: string;
  readonly gitBinary: string;
  readonly generation: string;
  readonly handleRemote: (
    operation: ShadowGitBrokerOperation,
    args: readonly string[],
    cwd: string,
    signal: AbortSignal,
  ) => Promise<ShadowGitRemoteResult>;
  readonly handleCleanup?: (cleanupId: string) => Promise<void>;
  /** Opens a byte-stream remote-helper transport for an exact admitted
   * promisor URL. The handler must expose only upload-pack/read semantics and
   * must acknowledge the socket before switching it to raw protocol bytes. */
  readonly handleTransport?: (
    remoteName: string,
    remoteUrl: string,
    socket: Socket,
    signal: AbortSignal,
  ) => Promise<void>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function boundedDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitive(message)
    .replaceAll(/[\r\n]+/g, " ")
    .slice(0, 2_000);
}

function exactToken(candidate: unknown, expected: Buffer): boolean {
  if (typeof candidate !== "string" || !/^[0-9a-f]{64}$/.test(candidate)) {
    return false;
  }
  const decoded = Buffer.from(candidate, "hex");
  return (
    decoded.length === expected.length && timingSafeEqual(decoded, expected)
  );
}

/** A generation-scoped, non-secret command capability. The child can ask for
 * one narrowly validated remote operation, but it never receives the host Git
 * credential or a general engine-control socket. */
export class ShadowGitRemoteBroker {
  private readonly sockets = new Set<Socket>();
  private closed = false;
  private options: ShadowGitRemoteBrokerOptions | null = null;
  private assignedPort = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly abortController = new AbortController();

  private constructor(
    private readonly server: Server,
    private readonly token: Buffer,
  ) {}

  readonly host = "127.0.0.1" as const;

  get port(): number {
    if (this.assignedPort === 0)
      throw new Error("shadow Git broker is not listening");
    return this.assignedPort;
  }

  static async reserve(): Promise<ShadowGitRemoteBroker> {
    const token = randomBytes(32);
    const broker = new ShadowGitRemoteBroker(createServer(), token);
    const server = broker.server;
    server.on("connection", (socket) => broker.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("shadow Git broker did not receive a TCP address");
    }
    broker.assignedPort = address.port;
    server.unref();
    return broker;
  }

  static async start(
    options: ShadowGitRemoteBrokerOptions,
  ): Promise<ShadowGitRemoteBroker> {
    const broker = await ShadowGitRemoteBroker.reserve();
    try {
      await broker.activate(options);
      return broker;
    } catch (error) {
      await broker.close().catch(() => undefined);
      throw error;
    }
  }

  async activate(options: ShadowGitRemoteBrokerOptions): Promise<void> {
    if (this.closed) throw new Error("shadow Git broker is closed");
    if (this.options) throw new Error("shadow Git broker is already active");
    if (
      !path.isAbsolute(options.runtime) ||
      !path.isAbsolute(options.gitBinary)
    ) {
      throw new Error("shadow Git broker executables must be absolute");
    }
    if (!path.isAbsolute(options.shadowRoot)) {
      throw new Error("shadow Git broker private root must be absolute");
    }
    this.options = options;
    try {
      await this.installClient();
    } catch (error) {
      this.options = null;
      throw error;
    }
  }

  private async installClient(): Promise<void> {
    const options = this.options;
    if (!options) throw new Error("shadow Git broker is not active");
    const clientPath = path.join(options.toolsRoot, "git-client.mjs");
    const transportClientPath = path.join(
      options.toolsRoot,
      "git-transport-client.mjs",
    );
    const shimPath = path.join(options.toolsRoot, "git");
    const transportShimPath = path.join(
      options.toolsRoot,
      "git-remote-zeros-zsr",
    );
    const clientConfig = JSON.stringify({
      host: this.host,
      port: this.port,
      token: this.token.toString("hex"),
      generation: options.generation,
      gitBinary: options.gitBinary,
      shadowRoot: options.shadowRoot,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    const clientSource = REMOTE_CLIENT_SOURCE.replace(
      "__ZEROS_REMOTE_CLIENT_CONFIG__",
      clientConfig,
    );
    const transportClientSource = REMOTE_TRANSPORT_CLIENT_SOURCE.replace(
      "__ZEROS_REMOTE_CLIENT_CONFIG__",
      clientConfig,
    );
    await writeFile(clientPath, clientSource, {
      encoding: "utf8",
      mode: 0o500,
      flag: "wx",
    });
    await writeFile(transportClientPath, transportClientSource, {
      encoding: "utf8",
      mode: 0o500,
      flag: "wx",
    });
    await writeFile(
      shimPath,
      `#!/bin/sh\nexec ${shellQuote(options.runtime)} ${shellQuote(clientPath)} "$@"\n`,
      { encoding: "utf8", mode: 0o500, flag: "wx" },
    );
    await writeFile(
      transportShimPath,
      `#!/bin/sh\nexec ${shellQuote(options.runtime)} ${shellQuote(transportClientPath)} "$@"\n`,
      { encoding: "utf8", mode: 0o500, flag: "wx" },
    );
  }

  private accept(socket: Socket): void {
    if (
      this.closed ||
      !this.options ||
      this.sockets.size >= MAX_ACTIVE_CONNECTIONS
    ) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    let request = Buffer.alloc(0);
    let handled = false;
    const finish = () => this.sockets.delete(socket);
    socket.once("close", finish);
    socket.once("error", finish);
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      if (request.length + chunk.length > MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(
          `${JSON.stringify({ ok: false, error: "request too large" })}\n`,
        );
        return;
      }
      request = Buffer.concat([request, chunk]);
      const newline = request.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      const trailing = request.subarray(newline + 1);
      if (trailing.some((byte) => byte !== 0x0a && byte !== 0x0d)) {
        socket.end(
          `${JSON.stringify({ ok: false, error: "invalid request framing" })}\n`,
        );
        return;
      }
      void this.respond(socket, request.subarray(0, newline).toString("utf8"));
    });
  }

  private async respond(socket: Socket, raw: string): Promise<void> {
    try {
      const options = this.options;
      if (!options) throw new Error("shadow Git broker is not active");
      const parsed = JSON.parse(raw) as {
        token?: unknown;
        generation?: unknown;
        operation?: unknown;
        args?: unknown;
        cwd?: unknown;
        remoteName?: unknown;
        remoteUrl?: unknown;
      };
      if (parsed.operation === "transport") {
        if (
          !exactToken(parsed.token, this.token) ||
          parsed.generation !== options.generation ||
          !options.handleTransport ||
          typeof parsed.remoteName !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(parsed.remoteName) ||
          typeof parsed.remoteUrl !== "string" ||
          parsed.remoteUrl.length === 0 ||
          parsed.remoteUrl.length > 16_384 ||
          parsed.remoteUrl.includes("\0") ||
          parsed.args !== undefined ||
          parsed.cwd !== undefined
        ) {
          socket.end(
            `${JSON.stringify({ ok: false, error: "invalid transport capability request" })}\n`,
          );
          return;
        }
        await options.handleTransport(
          parsed.remoteName,
          parsed.remoteUrl,
          socket,
          this.abortController.signal,
        );
        return;
      }
      const cleanupRequest = parsed.operation === "release";
      if (
        !exactToken(parsed.token, this.token) ||
        parsed.generation !== options.generation ||
        (!cleanupRequest &&
          !BROKER_OPERATIONS.has(
            parsed.operation as ShadowGitBrokerOperation,
          )) ||
        !Array.isArray(parsed.args) ||
        parsed.args.length > 1_024 ||
        parsed.args.some(
          (entry) =>
            typeof entry !== "string" ||
            entry.length > 16_384 ||
            entry.includes("\0"),
        ) ||
        (!cleanupRequest &&
          (typeof parsed.cwd !== "string" ||
            !path.isAbsolute(parsed.cwd) ||
            parsed.cwd.length > 16_384 ||
            parsed.cwd.includes("\0")))
      ) {
        socket.end(
          `${JSON.stringify({ ok: false, error: "invalid capability request" })}\n`,
        );
        return;
      }
      if (cleanupRequest) {
        const [cleanupId] = parsed.args as string[];
        if (
          parsed.args.length !== 1 ||
          !cleanupId ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            cleanupId,
          )
        ) {
          throw new Error("invalid cleanup request");
        }
        await options.handleCleanup?.(cleanupId);
        socket.end(`${JSON.stringify({ ok: true, stdout: "", stderr: "" })}\n`);
        return;
      }
      const operation = parsed.operation as ShadowGitBrokerOperation;
      const previous = this.operationTail;
      const execution = previous.then(async () => {
        if (
          this.closed ||
          this.options !== options ||
          this.abortController.signal.aborted
        ) {
          throw new Error("shadow Git capability was revoked");
        }
        return options.handleRemote(
          operation,
          parsed.args as string[],
          parsed.cwd as string,
          this.abortController.signal,
        );
      });
      this.operationTail = execution.then(
        () => undefined,
        () => undefined,
      );
      const result = await execution;
      if (this.closed || this.abortController.signal.aborted) {
        throw new Error("shadow Git capability was revoked");
      }
      if (
        (result.followUpCommands &&
          (result.followUpCommands.length > 8 ||
            result.followUpCommands.some(
              (command) =>
                command.length === 0 ||
                command.length > 256 ||
                command.some(
                  (value) =>
                    typeof value !== "string" ||
                    value.length > 16_384 ||
                    value.includes("\0"),
                ),
            ))) ||
        (result.cleanupId !== undefined &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            result.cleanupId,
          ))
      ) {
        throw new Error("shadow Git handler produced an invalid follow-up");
      }
      const stdout = result.stdout.slice(-MAX_RESPONSE_BYTES / 2);
      const stderr = result.stderr.slice(-MAX_RESPONSE_BYTES / 2);
      socket.end(
        `${JSON.stringify({
          ok: true,
          stdout,
          stderr,
          ...(result.followUpArgs
            ? { followUpArgs: [...result.followUpArgs] }
            : {}),
          ...(result.followUpCommands
            ? {
                followUpCommands: result.followUpCommands.map((args) => [
                  ...args,
                ]),
              }
            : {}),
          ...(result.cleanupId ? { cleanupId: result.cleanupId } : {}),
          ...(result.delegateNative ? { delegateNative: true } : {}),
        })}\n`,
      );
    } catch (error) {
      socket.end(
        `${JSON.stringify({ ok: false, error: boundedDiagnostic(error) })}\n`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort(new Error("shadow Git capability was revoked"));
    this.token.fill(0);
    this.options = null;
    for (const socket of this.sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => this.server.close(() => resolve())),
      this.operationTail,
    ]);
  }
}

const REMOTE_TRANSPORT_CLIENT_SOURCE = String.raw`
import { createConnection } from "node:net";

const config = __ZEROS_REMOTE_CLIENT_CONFIG__;
const [remoteName, remoteUrl, ...extra] = process.argv.slice(2);
if (extra.length > 0 || !remoteName || !remoteUrl ||
    remoteName.length > 255 || remoteUrl.length > 16384 ||
    remoteName.includes("\0") || remoteUrl.includes("\0")) {
  process.stderr.write("git remote: invalid Zeros transport arguments\n");
  process.exit(1);
}

const socket = createConnection({ host: config.host, port: config.port });
let handshake = Buffer.alloc(0);
let ready = false;
let settled = false;

function fail(message) {
  if (settled) return;
  settled = true;
  process.stderr.write("git remote: Zeros transport unavailable: " + message + "\n");
  socket.destroy();
  process.exitCode = 1;
}

function onHandshake(chunk) {
  if (ready) return;
  if (handshake.length + chunk.length > 64 * 1024) {
    fail("oversized handshake");
    return;
  }
  handshake = Buffer.concat([handshake, chunk]);
  const newline = handshake.indexOf(0x0a);
  if (newline < 0) return;
  let response;
  try {
    response = JSON.parse(handshake.subarray(0, newline).toString("utf8"));
  } catch {
    fail("invalid handshake");
    return;
  }
  if (!response || response.ok !== true) {
    fail(typeof response?.error === "string" ? response.error.slice(0, 1000) : "request refused");
    return;
  }
  ready = true;
  socket.off("data", onHandshake);
  const trailing = handshake.subarray(newline + 1);
  if (trailing.length > 0) process.stdout.write(trailing);
  socket.pipe(process.stdout, { end: false });
  process.stdin.pipe(socket);
  process.stdin.resume();
}

process.stdin.pause();
socket.setTimeout(config.requestTimeoutMs, () => fail("timed out"));
socket.once("connect", () => {
  socket.write(JSON.stringify({
    token: config.token,
    generation: config.generation,
    operation: "transport",
    remoteName,
    remoteUrl,
  }) + "\n");
});
socket.on("data", onHandshake);
socket.once("error", (error) => fail(error.message));
socket.once("end", () => {
  if (!ready) fail("closed before acknowledgement");
  else settled = true;
});
socket.once("close", () => {
  process.stdin.unpipe(socket);
  process.stdin.pause();
  if (!settled) {
    settled = true;
    if (!ready) {
      process.stderr.write("git remote: Zeros transport closed before acknowledgement\n");
      process.exitCode = 1;
    }
  }
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => socket.destroy());
}
`;

const REMOTE_CLIENT_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";

const config = __ZEROS_REMOTE_CLIENT_CONFIG__;
const args = process.argv.slice(2);

function subcommand(argv) {
  const takesValue = new Set([
    "-c", "-C", "--git-dir", "--work-tree", "--namespace",
    "--super-prefix", "--config-env",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h" || value === "--version") return null;
    if (value === "--") return argv[index + 1] ?? null;
    if (takesValue.has(value)) { index += 1; continue; }
    if (value.startsWith("--git-dir=") || value.startsWith("--work-tree=") ||
        value.startsWith("--namespace=") || value.startsWith("--super-prefix=") ||
        value.startsWith("--config-env=")) continue;
    if (value.startsWith("-c") && value !== "-c") continue;
    if (value.startsWith("-C") && value !== "-C") continue;
    if (value.startsWith("-")) continue;
    return value;
  }
  return null;
}

function linkedWorktreeEnvironment() {
  const entry = path.join(process.cwd(), ".git");
  try {
    const metadata = lstatSync(entry);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16384) {
      return null;
    }
    const match = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(entry, "utf8"));
    if (!match) return null;
    const candidate = realpathSync(path.resolve(process.cwd(), match[1]));
    const shadow = realpathSync(config.shadowRoot);
    const relative = path.relative(shadow, candidate);
    if (relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      return null;
    }
    const env = { ...process.env };
    for (const name of [
      "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ]) delete env[name];
    return env;
  } catch {
    return null;
  }
}

function nativeEnvironment() {
  const linked = linkedWorktreeEnvironment();
  if (linked) {
    return {
      ...linked,
      ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS: "1",
    };
  }
  // A process-wide GIT_INDEX_FILE is correct for the primary private checkout,
  // but git-worktree-add must create and populate the linked worktree's own
  // index. Leaving the primary override set produces a branch whose first
  // commit can silently omit paths that were never materialized in that index.
  if (operation === "worktree") {
    const env = { ...process.env };
    delete env.GIT_INDEX_FILE;
    env.ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS = "1";
    return env;
  }
  return {
    ...process.env,
    ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS: "1",
  };
}

function runNative() {
  const child = spawn(config.gitBinary, args, {
    cwd: process.cwd(),
    env: nativeEnvironment(),
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.once("error", (error) => {
    process.stderr.write("git: " + error.message + "\n");
    process.exitCode = 127;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = typeof code === "number" ? code : signal ? 128 : 1;
  });
}

function runFollowUp(commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(config.gitBinary, commandArgs, {
      cwd: process.cwd(),
      env: nativeEnvironment(),
      stdio: "inherit",
    });
    const forwards = new Map();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const forward = () => child.kill(signal);
      forwards.set(signal, forward);
      process.on(signal, forward);
    }
    const cleanup = () => {
      for (const [signal, forward] of forwards) {
        process.off(signal, forward);
      }
    };
    child.once("error", (error) => {
      cleanup();
      process.stderr.write("git " + operation + ": " + error.message + "\n");
      resolve(127);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(typeof code === "number" ? code : signal ? 128 : 1);
    });
  });
}

function release(cleanupId) {
  if (!cleanupId) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = createConnection({ host: config.host, port: config.port });
    cleanup.setTimeout(2_000, () => cleanup.destroy());
    cleanup.once("connect", () => {
      cleanup.end(JSON.stringify({
        token: config.token,
        generation: config.generation,
        operation: "release",
        args: [cleanupId],
      }) + "\n");
    });
    cleanup.once("error", () => resolve());
    cleanup.once("close", () => resolve());
  });
}

function validCommands(value) {
  return Array.isArray(value) && value.length <= 8 && value.every((command) =>
    Array.isArray(command) && command.length > 0 && command.length <= 256 &&
    new Set(["fetch", "merge", "rebase"]).has(command[0]) &&
    command.every((entry) => typeof entry === "string" &&
      entry.length <= 16384 && !entry.includes("\0"))
  );
}

const operation = subcommand(args);
const linkedWorktree = linkedWorktreeEnvironment();
if ((linkedWorktree && operation !== "push") || !new Set([
  "push", "fetch", "pull", "checkout", "switch", "reset", "restore",
  "clean", "merge", "rebase", "cherry-pick", "revert", "stash", "rm", "mv",
]).has(operation) || args.includes("--help") || args.includes("-h")) {
  runNative();
} else {
  const socket = createConnection({ host: config.host, port: config.port });
  let response = Buffer.alloc(0);
  socket.setTimeout(config.requestTimeoutMs, () => socket.destroy(new Error("broker timed out")));
  socket.once("connect", () => {
    socket.write(JSON.stringify({
      token: config.token,
      generation: config.generation,
        operation,
        args,
        cwd: process.cwd(),
      }) + "\n");
  });
  socket.on("data", (chunk) => {
    if (response.length + chunk.length > config.maxResponseBytes) {
      socket.destroy(new Error("broker response too large"));
      return;
    }
    response = Buffer.concat([response, chunk]);
  });
  socket.once("error", (error) => {
    process.stderr.write("git " + operation + ": Zeros broker unavailable: " + error.message + "\n");
    process.exitCode = 1;
  });
  socket.once("end", () => {
    void (async () => {
    try {
      const parsed = JSON.parse(response.toString("utf8").trim());
      if (!parsed || typeof parsed !== "object" ||
          typeof parsed.ok !== "boolean" ||
          (parsed.stdout !== undefined && typeof parsed.stdout !== "string") ||
          (parsed.stderr !== undefined && typeof parsed.stderr !== "string") ||
          (parsed.delegateNative !== undefined && parsed.delegateNative !== true) ||
          (parsed.followUpArgs !== undefined &&
            (!Array.isArray(parsed.followUpArgs) || parsed.followUpArgs.length > 128 ||
             parsed.followUpArgs.some((value) => typeof value !== "string" ||
               value.length > 16384 || value.includes("\0")))) ||
          (parsed.followUpCommands !== undefined && !validCommands(parsed.followUpCommands)) ||
          (parsed.cleanupId !== undefined &&
            (typeof parsed.cleanupId !== "string" ||
             !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed.cleanupId)))) {
        throw new Error("invalid response shape");
      }
      if (parsed.stdout) process.stdout.write(parsed.stdout);
      if (parsed.stderr) process.stderr.write(parsed.stderr);
      if (!parsed.ok) {
        process.stderr.write("git " + operation + ": " + (parsed.error ?? "request refused") + "\n");
        process.exitCode = 1;
      } else if (parsed.delegateNative) {
        runNative();
      } else {
        const commands = parsed.followUpCommands ??
          (Array.isArray(parsed.followUpArgs) ? [parsed.followUpArgs] : []);
        if (!validCommands(commands)) {
          throw new Error("invalid follow-up command");
        }
        let code = 0;
        try {
          for (const command of commands) {
            code = await runFollowUp(command);
            if (code !== 0) break;
          }
        } finally {
          await release(parsed.cleanupId);
        }
        process.exitCode = code;
      }
    } catch {
      process.stderr.write("git " + operation + ": invalid Zeros broker response\n");
      process.exitCode = 1;
    }
    })();
  });
}
`;

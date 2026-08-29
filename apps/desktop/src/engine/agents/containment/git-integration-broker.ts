import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  chmod,
  chown,
  copyFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { GitError } from "../../git/errors";
import {
  engineGitBinary,
  parseEngineGitCommand,
  runGit,
} from "../../git/git-exec";
import {
  discoverCanonicalGitRepository,
  resolveCanonicalGitRepository,
  type CanonicalGitRepository,
} from "./canonical-git-repository";
import type {
  CloudWorkerIdentity,
  TerritoryGeneration,
} from "./types";

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ARGUMENTS = 4_096;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const INTEGRATION_TIMEOUT_MS = 15 * 60_000;

interface NormalizedIntegrationInvocation {
  cwd: string;
  args: string[];
}

interface BrokerResponse {
  native?: true;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function pathInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function hasHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function checkoutIsTreeLevel(args: readonly string[]): boolean {
  let createsBranch = false;
  let positionals = 0;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (
      value === "--" ||
      value === "--patch" ||
      value === "-p" ||
      value === "--ours" ||
      value === "--theirs" ||
      value === "--pathspec-file-nul" ||
      value === "--pathspec-from-file" ||
      value.startsWith("--pathspec-from-file=")
    ) {
      return false;
    }
    if (
      value === "-b" ||
      value === "-B" ||
      value === "--orphan"
    ) {
      if (!args[index + 1]) return false;
      createsBranch = true;
      index += 1;
      continue;
    }
    if (
      (value.startsWith("-b") && value.length > 2) ||
      (value.startsWith("-B") && value.length > 2) ||
      value.startsWith("--orphan=")
    ) {
      createsBranch = true;
      continue;
    }
    if (value === "--conflict") {
      if (!args[index + 1]) return false;
      index += 1;
      continue;
    }
    if (value.startsWith("--conflict=")) continue;
    if (value === "-" || !value.startsWith("-")) {
      positionals += 1;
    }
  }
  return createsBranch ? positionals <= 1 : positionals === 1;
}

/** A one-positional checkout is syntactically ambiguous: Git accepts either a
 * ref or a path without `--`. Return the candidate that must resolve to a
 * commit before the broker may grant tree-integration authority. Branch-create
 * forms are unambiguously tree-level and need no extra proof. */
interface AmbiguousCheckoutTarget {
  readonly index: number;
  readonly value: string;
}

function ambiguousCheckoutTarget(
  args: readonly string[],
): AmbiguousCheckoutTarget | null {
  let createsBranch = false;
  let forcesRevision = false;
  const positionals: AmbiguousCheckoutTarget[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "-b" || value === "-B" || value === "--orphan") {
      createsBranch = true;
      index += 1;
      continue;
    }
    if (
      (value.startsWith("-b") && value.length > 2) ||
      (value.startsWith("-B") && value.length > 2) ||
      value.startsWith("--orphan=")
    ) {
      createsBranch = true;
      continue;
    }
    if (
      value === "--detach" ||
      value === "-d" ||
      value === "--track" ||
      value === "-t" ||
      value.startsWith("--track=")
    ) {
      // These modes force checkout's revision/branch grammar. If their target
      // disappears, Git errors instead of reinterpreting it as a path.
      forcesRevision = true;
      continue;
    }
    if (value === "--conflict") {
      index += 1;
      continue;
    }
    if (value.startsWith("--conflict=")) continue;
    if (value === "-" || !value.startsWith("-")) {
      positionals.push({ index, value });
    }
  }
  return !createsBranch && !forcesRevision && positionals.length === 1
    ? positionals[0]!
    : null;
}

function gitIdentityOptions(identity: CloudWorkerIdentity | undefined): {
  identity?: CloudWorkerIdentity;
} {
  return identity ? { identity } : {};
}

async function exactLocalCheckoutBranch(
  cwd: string,
  target: string,
  identity?: CloudWorkerIdentity,
): Promise<string | null> {
  if (target === "-" || /^@\{-\d+\}$/.test(target)) {
    const revision = target === "-" ? "@{-1}" : target;
    try {
      const { stdout } = await runGit(
        cwd,
        [
          "rev-parse",
          "--verify",
          "--symbolic-full-name",
          "--end-of-options",
          revision,
        ],
        {
          timeoutMs: 10_000,
          maxBufferBytes: 256 * 1024,
          ...gitIdentityOptions(identity),
        },
      );
      const ref = stdout.trim();
      return ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : null;
    } catch {
      return null;
    }
  }

  // Revision expressions such as `main~1`, `HEAD`, and full ref names detach
  // under ordinary checkout semantics. Only an exact short local-branch name
  // is recreated and attached by the pinned invocation.
  try {
    await runGit(cwd, ["check-ref-format", "--branch", target], {
      timeoutMs: 10_000,
      maxBufferBytes: 256 * 1024,
      ...gitIdentityOptions(identity),
    });
    await runGit(cwd, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${target}`,
    ], {
      timeoutMs: 10_000,
      maxBufferBytes: 256 * 1024,
      ...gitIdentityOptions(identity),
    });
    return target;
  } catch {
    return null;
  }
}

/** Convert checkout's one syntactically ambiguous argument into a revision-only
 * invocation before it crosses the actor fence. A local branch stays attached
 * through its full ref (and fails if that ref disappears); every other revision
 * is pinned to the immutable commit that was authorized and stays detached.
 * Returning null means the candidate was a path or disappeared before it could
 * be pinned and must run natively in-fence. */
export async function pinAmbiguousCheckoutIntegration(
  cwd: string,
  args: readonly string[],
  identity?: CloudWorkerIdentity,
): Promise<string[] | null> {
  const parsed = parseEngineGitCommand([...args]);
  if (parsed.command !== "checkout") return [...args];
  const target = ambiguousCheckoutTarget(parsed.commandArgs);
  if (!target) return [...args];
  // `git checkout HEAD` (and its `@` shorthand) is a no-op with respect to a
  // symbolic HEAD. Pinning either spelling to its commit would detach it, so
  // preserve native Git semantics inside the actor fence instead.
  if (target.value === "HEAD" || target.value === "@") return null;
  const revision =
    target.value === "-" ? "@{-1}^{commit}" : `${target.value}^{commit}`;
  let oid: string;
  try {
    const { stdout } = await runGit(
      cwd,
      [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        revision,
      ],
      {
        timeoutMs: 10_000,
        maxBufferBytes: 256 * 1024,
        ...gitIdentityOptions(identity),
      },
    );
    oid = stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(oid)) return null;
  } catch {
    return null;
  }

  const branch = await exactLocalCheckoutBranch(
    cwd,
    target.value,
    identity,
  );
  const options = parsed.commandArgs.filter(
    (_value, index) => index !== target.index,
  );
  return [
    ...parsed.globalArgs,
    "checkout",
    ...options,
    ...(branch
      ? ["-B", branch, `refs/heads/${branch}`]
      : ["--detach", oid]),
  ];
}

function resetIsTreeLevel(args: readonly string[]): boolean {
  if (
    args.includes("--") ||
    args.includes("--pathspec-file-nul") ||
    args.includes("--pathspec-from-file") ||
    args.some((value) => value.startsWith("--pathspec-from-file="))
  ) {
    return false;
  }
  const writesTree = args.some(
    (value) =>
      value === "--hard" || value === "--merge" || value === "--keep",
  );
  if (!writesTree) return false;
  const positionals = args.filter(
    (value) => value === "-" || !value.startsWith("-"),
  );
  return positionals.length <= 1;
}

/** Decide solely from argv whether Git derives worktree writes from repository
 * state. Anything that can name a path remains native, where the actor's
 * kernel Design deny is authoritative. Stashes remain native even when they
 * name no path: they are locally authored state, so apply/pop/branch must not
 * gain the engine's Design-write authority. */
export function isTreeLevelGitIntegration(args: readonly string[]): boolean {
  let parsed: ReturnType<typeof parseEngineGitCommand>;
  try {
    parsed = parseEngineGitCommand([...args]);
  } catch {
    return false;
  }
  if (hasHelp(parsed.commandArgs)) return false;
  switch (parsed.command) {
    case "pull":
    case "merge":
    case "rebase":
    case "cherry-pick":
    case "revert":
      return true;
    case "switch":
      return !parsed.commandArgs.includes("--");
    case "checkout":
      return checkoutIsTreeLevel(parsed.commandArgs);
    case "reset":
      return resetIsTreeLevel(parsed.commandArgs);
    default:
      return false;
  }
}

function normalizeInvocation(
  initialCwd: string,
  originalArgs: readonly string[],
): NormalizedIntegrationInvocation | null {
  if (
    !path.isAbsolute(initialCwd) ||
    initialCwd.includes("\0") ||
    originalArgs.length === 0 ||
    originalArgs.length > MAX_ARGUMENTS ||
    originalArgs.some(
      (value) =>
        typeof value !== "string" ||
        value.includes("\0") ||
        value.length > 32 * 1024,
    ) ||
    originalArgs.reduce((total, value) => total + value.length, 0) >
      MAX_ARGUMENT_BYTES
  ) {
    return null;
  }
  let cwd = path.resolve(initialCwd);
  const args: string[] = [];
  let commandSeen = false;
  for (let index = 0; index < originalArgs.length; index += 1) {
    const value = originalArgs[index]!;
    if (commandSeen) {
      args.push(value);
      continue;
    }
    if (value === "-C") {
      const target = originalArgs[index + 1];
      if (!target) return null;
      cwd = path.resolve(cwd, target);
      index += 1;
      continue;
    }
    if (value.startsWith("-C") && value.length > 2) {
      cwd = path.resolve(cwd, value.slice(2));
      continue;
    }
    if (value === "-c") {
      const setting = originalArgs[index + 1];
      if (!setting) return null;
      args.push(value, setting);
      index += 1;
      continue;
    }
    if (value === "--no-pager" || value === "-P") {
      args.push(value);
      continue;
    }
    if (value.startsWith("-")) return null;
    commandSeen = true;
    args.push(value);
  }
  return commandSeen && isTreeLevelGitIntegration(args)
    ? { cwd, args }
    : null;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error("Git integration request is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function failureResponse(error: unknown): BrokerResponse {
  const cause = error instanceof GitError ? error.cause : error;
  const raw = cause as {
    code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  const code =
    typeof raw?.code === "number" && raw.code > 0 && raw.code < 256
      ? raw.code
      : 1;
  return {
    exitCode: code,
    stdout: typeof raw?.stdout === "string" ? raw.stdout : "",
    stderr:
      typeof raw?.stderr === "string" && raw.stderr
        ? raw.stderr
        : "git: trusted integration failed\n",
  };
}

const CLIENT_SOURCE = String.raw`
import { spawnSync } from "node:child_process";
import { request } from "node:http";

const config = __ZEROS_GIT_INTEGRATION_CONFIG__;
const args = process.argv.slice(2);

function runNative() {
  const result = spawnSync(config.git, args, {
    cwd: process.cwd(),
    env: { ...process.env, ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS: "1" },
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write("git: native executable is unavailable\n");
    process.exit(127);
  }
  process.exit(result.status ?? (result.signal ? 128 : 1));
}

const body = JSON.stringify({
  version: 1,
  generation: config.generation,
  token: config.token,
  cwd: process.cwd(),
  args,
});
const outbound = request({
  socketPath: config.socket,
  path: "/git",
  method: "POST",
  headers: {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  },
});
outbound.setTimeout(${INTEGRATION_TIMEOUT_MS}, () => {
  outbound.destroy(new Error("Git integration timed out"));
});
outbound.on("response", (response) => {
  const chunks = [];
  let bytes = 0;
  response.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > ${MAX_RESPONSE_BYTES}) {
      response.destroy(new Error("Git integration reply is too large"));
      return;
    }
    chunks.push(chunk);
  });
  response.on("end", () => {
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (result.native === true) return runNative();
      if (typeof result.stdout === "string") process.stdout.write(result.stdout);
      if (typeof result.stderr === "string") process.stderr.write(result.stderr);
      process.exit(Number.isInteger(result.exitCode) ? result.exitCode : 1);
    } catch {
      process.stderr.write("git: integration broker returned an invalid reply\n");
      process.exit(1);
    }
  });
});
outbound.on("error", () => {
  process.stderr.write("git: integration broker is unavailable\n");
  process.exit(1);
});
outbound.end(body);
`;

export interface ZsrGitIntegrationBrokerOptions {
  readonly generation: TerritoryGeneration;
  readonly socketPath: string;
  readonly toolsRoot: string;
  readonly runtime: string;
  readonly workspaceRoot: string;
  readonly integrationRoots: readonly string[];
  readonly gitDispatchBinary?: string;
  readonly workerIdentity?: CloudWorkerIdentity;
}

function sameRepository(
  left: CanonicalGitRepository,
  right: CanonicalGitRepository,
): boolean {
  return (
    left.workspaceRoot === right.workspaceRoot &&
    left.gitDir === right.gitDir &&
    left.commonDir === right.commonDir &&
    left.objectDir === right.objectDir
  );
}

/** Resolve `cwd` through Git and require the resulting worktree and metadata to
 * equal one owner captured at broker start. Merely being a descendant of a
 * registered root is insufficient because it may be a nested repository. */
export async function resolveRegisteredIntegrationRepository(
  cwd: string,
  registered: readonly CanonicalGitRepository[],
): Promise<CanonicalGitRepository | null> {
  const current = await resolveCanonicalGitRepository(cwd);
  if (!current) return null;
  return registered.find((candidate) => sameRepository(candidate, current)) ?? null;
}

/** Narrow confused-deputy boundary for the only Git operations intentionally
 * allowed to materialize Design bytes. The wrapper is convenience; this
 * server re-parses every request, bounds cwd to registered code owners, and
 * executes through engine Git's hook/filter/credential hardening. */
export class ZsrGitIntegrationBroker {
  private readonly token: Buffer;
  private readonly active = new Set<Promise<void>>();
  private readonly abortControllers = new Set<AbortController>();
  private closed = false;

  private constructor(
    private readonly server: Server,
    private readonly options: ZsrGitIntegrationBrokerOptions,
    private readonly roots: readonly string[],
    private readonly repositories: readonly CanonicalGitRepository[],
    token: Buffer,
    private readonly configPath: string,
  ) {
    this.token = token;
  }

  static async start(
    options: ZsrGitIntegrationBrokerOptions,
  ): Promise<ZsrGitIntegrationBroker> {
    const roots = [
      ...new Set(
        await Promise.all(
          options.integrationRoots.map((candidate) => realpath(candidate)),
        ),
      ),
    ].sort((left, right) => left.localeCompare(right));
    if (roots.length === 0 || roots.length > 256) {
      throw new Error("Git integration roots are invalid");
    }
    const canonicalWorkspace = await realpath(options.workspaceRoot);
    if (!roots.includes(canonicalWorkspace)) {
      throw new Error("Git integration roots omit the current workspace");
    }
    const repositories = (
      await Promise.all(
        roots.map((candidate) => discoverCanonicalGitRepository(candidate)),
      )
    ).filter(
      (candidate): candidate is CanonicalGitRepository => candidate !== null,
    );
    const token = randomBytes(32);
    let owner: ZsrGitIntegrationBroker | null = null;
    const server = createServer((request, response) => {
      const work = owner?.handle(request, response) ?? Promise.resolve();
      owner?.active.add(work);
      const release = () => owner?.active.delete(work);
      // `finally()` creates a second rejected promise when `work` rejects;
      // explicit twin handlers keep request cleanup from becoming an
      // unhandled rejection while preserving the original request promise.
      void work.then(release, release);
    });
    const clientPath = path.join(options.toolsRoot, "git-integration.mjs");
    const configPath = path.join(options.toolsRoot, "git-dispatch.conf");
    const gitPath = path.join(options.toolsRoot, "git");
    const git = engineGitBinary();
    const embedded = JSON.stringify({
      generation: options.generation,
      token: token.toString("base64url"),
      socket: options.socketPath,
      git,
    });
    const client = `#!${options.runtime}\n${CLIENT_SOURCE.replace(
      "__ZEROS_GIT_INTEGRATION_CONFIG__",
      embedded,
    )}`;
    const lines = [
      "v1",
      "hostParity",
      `runtime ${options.runtime}`,
      `dispatcher ${clientPath}`,
      "entry",
      `workspaceRoot ${canonicalWorkspace}`,
      `toolsRoot ${options.toolsRoot}`,
      `client ${clientPath}`,
      `git ${git}`,
    ];
    if (lines.some((line) => line.includes("\n"))) {
      token.fill(0);
      throw new Error("Git integration configuration is unrenderable");
    }
    try {
      await writeFile(clientPath, client, {
        encoding: "utf8",
        mode: 0o500,
        flag: "wx",
      });
      await writeFile(configPath, `${lines.join("\n")}\n`, {
        encoding: "utf8",
        mode: 0o400,
        flag: "wx",
      });
      if (options.gitDispatchBinary) {
        await copyFile(options.gitDispatchBinary, gitPath);
        await chmod(gitPath, 0o500);
      } else {
        await writeFile(
          gitPath,
          `#!/bin/sh\nexec '${options.runtime.replaceAll("'", `'\\''`)}' '${clientPath.replaceAll("'", `'\\''`)}' "$@"\n`,
          { encoding: "utf8", mode: 0o500, flag: "wx" },
        );
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.socketPath);
      });
      server.unref();
      if (options.workerIdentity) {
        const identity = options.workerIdentity;
        for (const directory of [
          path.dirname(options.toolsRoot),
          options.toolsRoot,
          path.dirname(path.dirname(options.socketPath)),
          path.dirname(options.socketPath),
        ]) {
          await chown(directory, 0, identity.gid);
          await chmod(directory, directory === options.toolsRoot ? 0o750 : 0o710);
        }
        for (const file of [clientPath, gitPath]) {
          await chown(file, 0, identity.gid);
          await chmod(file, 0o550);
        }
        await chown(configPath, 0, identity.gid);
        await chmod(configPath, 0o440);
        await chown(options.socketPath, 0, identity.gid);
        await chmod(options.socketPath, 0o660);
      } else {
        await chmod(options.socketPath, 0o600);
      }
      owner = new ZsrGitIntegrationBroker(
        server,
        options,
        roots,
        repositories,
        token,
        configPath,
      );
      return owner;
    } catch (error) {
      token.fill(0);
      server.close();
      throw error;
    }
  }

  childEnvironment(pathValue: string | undefined): Record<string, string> {
    return {
      ZEROS_ZSR_GIT_DISPATCH_CONFIG: this.configPath,
      PATH: `${this.options.toolsRoot}${path.delimiter}${
        pathValue ?? "/usr/local/bin:/usr/bin:/bin"
      }`,
    };
  }

  private async handle(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (this.closed || request.method !== "POST" || request.url !== "/git") {
      response.statusCode = 404;
      response.end(JSON.stringify({ exitCode: 1 } satisfies BrokerResponse));
      return;
    }
    try {
      const payload = JSON.parse(await readRequestBody(request)) as {
        version?: unknown;
        generation?: unknown;
        token?: unknown;
        cwd?: unknown;
        args?: unknown;
      };
      if (
        payload.version !== 1 ||
        payload.generation !== this.options.generation ||
        typeof payload.token !== "string" ||
        payload.token !== this.token.toString("base64url") ||
        typeof payload.cwd !== "string" ||
        !Array.isArray(payload.args) ||
        !payload.args.every((value): value is string => typeof value === "string")
      ) {
        response.statusCode = 403;
        response.end(JSON.stringify({ exitCode: 1 } satisfies BrokerResponse));
        return;
      }
      const invocation = normalizeInvocation(payload.cwd, payload.args);
      if (!invocation) {
        response.end(JSON.stringify({ native: true } satisfies BrokerResponse));
        return;
      }
      const cwd = await realpath(invocation.cwd);
      if (!this.roots.some((root) => pathInsideOrEqual(cwd, root))) {
        response.statusCode = 403;
        response.end(JSON.stringify({ exitCode: 1 } satisfies BrokerResponse));
        return;
      }
      const repository = await resolveRegisteredIntegrationRepository(
        cwd,
        this.repositories,
      );
      if (!repository) {
        response.end(JSON.stringify({ native: true } satisfies BrokerResponse));
        return;
      }
      const integrationArgs = await pinAmbiguousCheckoutIntegration(
        cwd,
        invocation.args,
        this.options.workerIdentity,
      );
      if (!integrationArgs) {
        response.end(JSON.stringify({ native: true } satisfies BrokerResponse));
        return;
      }
      const controller = new AbortController();
      this.abortControllers.add(controller);
      try {
        const result = await runGit(cwd, integrationArgs, {
          timeoutMs: INTEGRATION_TIMEOUT_MS,
          maxBufferBytes: MAX_GIT_OUTPUT_BYTES,
          signal: controller.signal,
          ...(this.options.workerIdentity
            ? { identity: this.options.workerIdentity }
            : {}),
        });
        response.end(
          JSON.stringify({
            exitCode: 0,
            stdout: result.stdout,
            stderr: result.stderr,
          } satisfies BrokerResponse),
        );
      } catch (error) {
        response.end(JSON.stringify(failureResponse(error)));
      } finally {
        this.abortControllers.delete(controller);
      }
    } catch {
      response.statusCode = 400;
      response.end(JSON.stringify({ exitCode: 1 } satisfies BrokerResponse));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.token.fill(0);
    for (const controller of this.abortControllers) {
      controller.abort(new Error("Git integration boundary was revoked"));
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.allSettled([...this.active]);
  }
}

import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentFilesystemTerritory } from "../types";
import {
  type CanonicalGitRepository,
  type ShadowGitFilesystemProjection,
  type ShadowGitPromotionResult,
  ShadowGitSession,
} from "./shadow-git";
import type { ShadowGitRemoteBroker } from "./shadow-git-remote-broker";
import type { TerritoryGeneration } from "./types";

const MAX_SHADOW_REPOSITORIES = 33;

/** How many repositories' shadow-Git sessions are built at once. Each session is
 * dozens of short `git` subprocesses, so the useful bound is process-level, not
 * promise-level: enough concurrency to hide each repository's spawn latency
 * behind the others, low enough that a 33-repository workspace does not thrash a
 * laptop's scheduler during an admission the user is waiting on. */
const SHADOW_GIT_BUILD_CONCURRENCY = 4;

export interface ShadowGitCollectionOptions {
  readonly repositories: readonly CanonicalGitRepository[];
  readonly additionalWriteRoots?: readonly string[];
  readonly shadowRoot: string;
  readonly privateHome: string;
  readonly commandsRoot: string;
  readonly toolsRoot: string;
  readonly toolRuntime: string;
  readonly generation: TerritoryGeneration;
  readonly territory?: AgentFilesystemTerritory;
  /** Brokers reserved before immutable network policy serialization. Their
   * order must exactly match `repositories`. */
  readonly remoteBrokers?: readonly ShadowGitRemoteBroker[];
  /** Optional per-phase recorder, summed across every repository built. */
  readonly onPhase?: (name: string, ms: number) => void;
  /** The compiled shadow-Git dispatcher. When present it is installed as
   * `<toolsRoot>/git` in place of a shell script that starts a runtime, which is
   * what every in-fence Git command used to pay: measured inside a live
   * boundary, `git --version` is 5-31 ms with the redirect bypassed and
   * 835-947 ms cold through the runtime chain. The Node dispatcher stays on
   * disk and stays authoritative — the binary hands it anything it cannot
   * answer unambiguously. */
  readonly gitDispatchBinary?: string;
}

interface CollectionEntry {
  readonly repository: CanonicalGitRepository;
  readonly shadowRoot: string;
  readonly toolsRoot: string;
  readonly session: ShadowGitSession;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function repositoryId(
  repository: CanonicalGitRepository,
  index: number,
): string {
  return `${index.toString(36)}-${createHash("sha256")
    .update(repository.workspaceRoot)
    .digest("hex")
    .slice(0, 20)}`;
}

const DISPATCHER_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const config = __ZEROS_SHADOW_GIT_COLLECTION_CONFIG__;
const originalArgs = process.argv.slice(2);

function lexicalOrPhysical(candidate) {
  const absolute = path.resolve(candidate);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative));
}

function globalArguments(argv) {
  let cwd = lexicalOrPhysical(process.cwd());
  let explicitGitDir = null;
  let explicitWorkTree = null;
  const normalized = [];
  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (commandSeen) {
      normalized.push(value);
      continue;
    }
    if (value === "--") {
      normalized.push(value);
      commandSeen = true;
      continue;
    }
    if (value === "-C") {
      const target = argv[index + 1];
      if (typeof target !== "string") return { invalid: true };
      cwd = lexicalOrPhysical(path.resolve(cwd, target));
      index += 1;
      continue;
    }
    if (value.startsWith("-C") && value.length > 2) {
      cwd = lexicalOrPhysical(path.resolve(cwd, value.slice(2)));
      continue;
    }
    if (value === "--git-dir" || value === "--work-tree") {
      const target = argv[index + 1];
      if (typeof target !== "string") return { invalid: true };
      const absolute = lexicalOrPhysical(path.resolve(cwd, target));
      if (value === "--git-dir") explicitGitDir = absolute;
      else explicitWorkTree = absolute;
      normalized.push(value, target);
      index += 1;
      continue;
    }
    if (value.startsWith("--git-dir=")) {
      explicitGitDir = lexicalOrPhysical(
        path.resolve(cwd, value.slice("--git-dir=".length)),
      );
      normalized.push(value);
      continue;
    }
    if (value.startsWith("--work-tree=")) {
      explicitWorkTree = lexicalOrPhysical(
        path.resolve(cwd, value.slice("--work-tree=".length)),
      );
      normalized.push(value);
      continue;
    }
    if (new Set(["-c", "--config-env", "--namespace", "--super-prefix", "--exec-path"]).has(value)) {
      const argument = argv[index + 1];
      if (typeof argument !== "string") return { invalid: true };
      normalized.push(value, argument);
      index += 1;
      continue;
    }
    normalized.push(value);
    if (!value.startsWith("-")) commandSeen = true;
  }
  return { invalid: false, cwd, explicitGitDir, explicitWorkTree, normalized };
}

function entryForShadowPointer(entryPath) {
  try {
    const metadata = lstatSync(entryPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) {
      return null;
    }
    const match = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(entryPath, "utf8"));
    if (!match) return null;
    const target = lexicalOrPhysical(path.resolve(path.dirname(entryPath), match[1]));
    return config.entries.find((entry) => inside(target, entry.shadowRoot)) ?? null;
  } catch {
    return null;
  }
}

function discoverEntry(start) {
  let cursor = lexicalOrPhysical(start);
  for (;;) {
    const exact = config.entries.find((entry) => entry.workspaceRoot === cursor);
    const gitEntry = path.join(cursor, ".git");
    try {
      const metadata = lstatSync(gitEntry);
      if (metadata.isFile()) {
        const linked = entryForShadowPointer(gitEntry);
        if (linked) return linked;
      }
      const mapped = config.entries.find((entry) => entry.gitEntry === gitEntry);
      if (mapped) return mapped;
      // A nearer, ordinary nested repository owns this cwd. Do not force it
      // into an enclosing shadow repository.
      if (metadata.isFile() || metadata.isDirectory()) return null;
    } catch {
      // Seatbelt can hide a mapped canonical .git entry. The trusted root map
      // remains sufficient to select its private projection.
      if (exact) return exact;
    }
    if (exact) return exact;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function explicitEntry(parsed) {
  if (parsed.explicitGitDir) {
    const matched = config.entries.find((entry) =>
      parsed.explicitGitDir === entry.gitEntry ||
      parsed.explicitGitDir === entry.shadowRoot ||
      inside(parsed.explicitGitDir, entry.shadowRoot),
    );
    return matched ?? false;
  }
  if (parsed.explicitWorkTree) return discoverEntry(parsed.explicitWorkTree);
  const ambientGitDir =
    process.env.GIT_DIR === config.defaultEnv.GIT_DIR
      ? undefined
      : process.env.GIT_DIR;
  if (ambientGitDir) {
    const candidate = lexicalOrPhysical(path.resolve(parsed.cwd, ambientGitDir));
    const matched = config.entries.find((entry) =>
      candidate === entry.gitEntry || candidate === entry.shadowRoot ||
      inside(candidate, entry.shadowRoot),
    );
    return matched ?? false;
  }
  return undefined;
}

function mappedArguments(entry, argv, explicitGitDir) {
  return argv.map((value, index) => {
    if (value.startsWith("--git-dir=")) {
      return explicitGitDir === entry.gitEntry
        ? "--git-dir=" + entry.shadowRoot
        : value;
    }
    if (index > 0 && argv[index - 1] === "--git-dir") {
      return explicitGitDir === entry.gitEntry ? entry.shadowRoot : value;
    }
    return value;
  });
}

function mappedEnvironment(entry) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === "GIT_DIR" || name === "GIT_COMMON_DIR" ||
        name === "GIT_WORK_TREE" || name === "GIT_INDEX_FILE" ||
        name === "GIT_OBJECT_DIRECTORY" ||
        name === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ||
        name === "GIT_NAMESPACE" || name === "GIT_CEILING_DIRECTORIES" ||
        name === "GIT_ASKPASS" || name === "GIT_SSH" ||
        name === "GIT_SSH_COMMAND" || name === "GIT_EXEC_PATH" ||
        name === "GIT_PROXY_COMMAND" || name === "SSH_ASKPASS" ||
        name.startsWith("GIT_CONFIG") || name.startsWith("ZEROS_GIT_AUTH_") ||
        name.startsWith("ZEROS_REAL_GIT") || name.startsWith("ZEROS_REAL_GH")) {
      delete env[name];
    }
    if (name === "ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS") delete env[name];
  }
  Object.assign(env, entry.env);
  env.PATH = entry.toolsRoot + path.delimiter +
    (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin");
  return env;
}

function fallbackEnvironment() {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(config.defaultEnv)) {
    if (env[name] === value) delete env[name];
  }
  return env;
}

function run(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  const forwards = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const forward = () => child.kill(signal);
    forwards.set(signal, forward);
    process.on(signal, forward);
  }
  const cleanup = () => {
    for (const [signal, forward] of forwards) process.off(signal, forward);
  };
  child.once("error", (error) => {
    cleanup();
    process.stderr.write("git: " + error.message + "\n");
    process.exitCode = 127;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    process.exitCode = typeof code === "number" ? code : signal ? 128 : 1;
  });
}

const parsed = globalArguments(originalArgs);
if (parsed.invalid) {
  run(config.fallbackGit, originalArgs, process.cwd(), fallbackEnvironment());
} else {
  const explicit = explicitEntry(parsed);
  const entry = explicit === false ? null : (explicit ?? discoverEntry(parsed.cwd));
  if (!entry) {
    run(config.fallbackGit, originalArgs, process.cwd(), fallbackEnvironment());
  } else {
    run(
      entry.client,
      mappedArguments(entry, parsed.normalized, parsed.explicitGitDir),
      parsed.cwd,
      mappedEnvironment(entry),
    );
  }
}
`;

/** Owns one validated shadow repository per writable Git owner and installs a
 * single PATH-level dispatcher. Repository selection is based on the command's
 * effective cwd (including leading `git -C`), so ordinary Git syntax works in
 * every attached repository without exposing any canonical control directory. */
export class ShadowGitCollection {
  private stopped = false;

  private constructor(
    private readonly options: ShadowGitCollectionOptions,
    private readonly entries: readonly CollectionEntry[],
    /** Null whenever the compiled dispatcher was not installed, which is what
     * keeps the child from being told to use a fast path that is not there. */
    private readonly dispatchConfigPath: string | null = null,
  ) {}

  static async create(
    options: ShadowGitCollectionOptions,
  ): Promise<ShadowGitCollection> {
    if (
      options.repositories.length === 0 ||
      options.repositories.length > MAX_SHADOW_REPOSITORIES ||
      !path.isAbsolute(options.shadowRoot) ||
      !path.isAbsolute(options.privateHome) ||
      !path.isAbsolute(options.commandsRoot) ||
      !path.isAbsolute(options.toolsRoot) ||
      !path.isAbsolute(options.toolRuntime)
    ) {
      throw new Error("invalid shadow Git collection options");
    }
    if (
      new Set(options.repositories.map((entry) => entry.workspaceRoot)).size !==
      options.repositories.length
    ) {
      throw new Error("shadow Git collection repositories must be unique");
    }
    if (
      new Set(options.repositories.map((entry) => entry.gitBinary)).size !== 1
    ) {
      throw new Error(
        "shadow Git collection repositories must share one trusted Git runtime",
      );
    }
    if (
      options.remoteBrokers &&
      options.remoteBrokers.length !== options.repositories.length
    ) {
      throw new Error("shadow Git collection broker count does not match");
    }
    await Promise.all(
      [
        options.shadowRoot,
        options.privateHome,
        options.commandsRoot,
        options.toolsRoot,
      ].map(async (directory) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
      }),
    );

    const entries: CollectionEntry[] = [];
    const builtIndices = new Set<number>();
    try {
      // Repositories are built CONCURRENTLY, bounded (§5.4). Each session is
      // ~45 `git` subprocesses under its own private root — disjoint shadow
      // root, private home, commands root and tools root — so nothing here is
      // shared but the parent directories created above. Built serially, a
      // workspace with several repositories paid the sum; a Zeros workspace can
      // legitimately carry up to 33. The bound exists because these are
      // subprocesses, not promises: an unbounded fan-out on a 33-repository
      // workspace would put ~1,500 `git` spawns in flight at once and lose more
      // to contention than serialization ever cost. Order is preserved, because
      // `entries[0]` is the dispatcher's fallback identity and the whole
      // projection list is index-matched to the caller's repositories.
      const built = new Array<CollectionEntry | undefined>(
        options.repositories.length,
      );
      const buildAt = async (index: number): Promise<void> => {
        const repository = options.repositories[index]!;
        const id = repositoryId(repository, index);
        const repositoryShadowRoot = path.join(options.shadowRoot, id, "git");
        const repositoryToolsRoot = path.join(
          options.toolsRoot,
          "git-repositories",
          id,
        );
        const session = await ShadowGitSession.create({
          workspaceRoot: repository.workspaceRoot,
          additionalWriteRoots: options.additionalWriteRoots,
          shadowRoot: repositoryShadowRoot,
          privateHome: path.join(options.privateHome, "git-repositories", id),
          commandsRoot: path.join(options.commandsRoot, "git-repositories", id),
          toolsRoot: repositoryToolsRoot,
          toolRuntime: options.toolRuntime,
          generation: options.generation,
          ...(options.territory ? { territory: options.territory } : {}),
          repository,
          ...(options.remoteBrokers?.[index]
            ? { remoteBroker: options.remoteBrokers[index] }
            : {}),
          // Phases sum across a workspace's repositories: a 33-repository
          // workspace's `private-git` is the sum of 33 builds, and the useful
          // question is which phase dominates, not which repository.
          ...(options.onPhase ? { onPhase: options.onPhase } : {}),
        });
        built[index] = {
          repository,
          shadowRoot: repositoryShadowRoot,
          toolsRoot: repositoryToolsRoot,
          session,
        };
        builtIndices.add(index);
      };
      let nextIndex = 0;
      const workerCount = Math.min(
        SHADOW_GIT_BUILD_CONCURRENCY,
        options.repositories.length,
      );
      // Settle every worker before inspecting failures: a rejection must not
      // leave a sibling session half-built and unreferenced, because the
      // cleanup below can only stop the sessions it can see.
      const workers = await Promise.allSettled(
        Array.from({ length: workerCount }, async () => {
          for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= options.repositories.length) return;
            await buildAt(index);
          }
        }),
      );
      for (const entry of built) {
        if (entry) entries.push(entry);
      }
      for (const worker of workers) {
        if (worker.status === "rejected") throw worker.reason;
      }
      const dispatcherPath = path.join(options.toolsRoot, "git-dispatcher.mjs");
      const config = JSON.stringify({
        fallbackGit: entries[0]!.repository.gitBinary,
        defaultEnv: entries[0]!.session.env,
        entries: entries.map((entry) => ({
          workspaceRoot: entry.repository.workspaceRoot,
          gitEntry: entry.repository.gitEntry,
          shadowRoot: entry.shadowRoot,
          toolsRoot: entry.toolsRoot,
          client: path.join(entry.toolsRoot, "git"),
          env: entry.session.env,
        })),
      });
      await writeFile(
        dispatcherPath,
        DISPATCHER_SOURCE.replace(
          "__ZEROS_SHADOW_GIT_COLLECTION_CONFIG__",
          config,
        ),
        { encoding: "utf8", mode: 0o500, flag: "wx" },
      );
      // One `key value` per line, no escaping, because the C dispatcher must be
      // able to read it without a parser. Every value is a path this engine
      // produced or an environment pair it chose, and a newline in any of them
      // would silently truncate the file, so one is refused outright rather than
      // quoted: a configuration this engine cannot render exactly is one the
      // fast path must not run on.
      // Gated on the binary being supplied rather than on the platform: the
      // build only produces it where it is compiled, so its absence is already
      // the signal, and a caller can hand one in to exercise this path.
      const installedDispatcher = options.gitDispatchBinary ?? null;
      let dispatchConfigPath: string | null = null;
      if (installedDispatcher) {
        const lines = [
          "v1",
          `runtime ${options.toolRuntime}`,
          `dispatcher ${dispatcherPath}`,
        ];
        for (const entry of entries) {
          lines.push(
            "entry",
            `workspaceRoot ${entry.repository.workspaceRoot}`,
            `gitEntry ${entry.repository.gitEntry}`,
            `shadowRoot ${entry.shadowRoot}`,
            `toolsRoot ${entry.toolsRoot}`,
            `client ${path.join(entry.toolsRoot, "git")}`,
            `git ${entry.repository.gitBinary}`,
            ...Object.entries(entry.session.env).map(
              ([name, value]) => `env ${name}=${value}`,
            ),
          );
        }
        if (lines.some((line) => line.includes("\n"))) {
          throw new Error("shadow Git dispatch configuration is unrenderable");
        }
        dispatchConfigPath = path.join(options.toolsRoot, "git-dispatch.conf");
        await writeFile(dispatchConfigPath, `${lines.join("\n")}\n`, {
          encoding: "utf8",
          mode: 0o400,
          flag: "wx",
        });
      }
      if (installedDispatcher) {
        await copyFile(
          installedDispatcher,
          path.join(options.toolsRoot, "git"),
        );
        await chmod(path.join(options.toolsRoot, "git"), 0o500);
      } else {
        await writeFile(
          path.join(options.toolsRoot, "git"),
          `#!/bin/sh\nexec ${shellQuote(options.toolRuntime)} ${shellQuote(dispatcherPath)} "$@"\n`,
          { encoding: "utf8", mode: 0o500, flag: "wx" },
        );
      }
      return new ShadowGitCollection(options, entries, dispatchConfigPath);
    } catch (error) {
      await Promise.allSettled(entries.map((entry) => entry.session.stop()));
      // Close only the brokers whose session was never built. This is INDEX-
      // based rather than count-based: sessions are built concurrently, so a
      // failure can leave holes (index 0 failing while index 1 succeeded), and
      // `slice(entries.length)` would then close a broker a live session already
      // owns — a double close on the way out of a failed admission.
      await Promise.allSettled(
        (options.remoteBrokers ?? []).flatMap((broker, index) =>
          builtIndices.has(index) ? [] : [broker.close()],
        ),
      );
      throw error;
    }
  }

  childEnvironment(pathValue: string | undefined): Record<string, string> {
    const macosInterposition = this.macosGitInterposition();
    return {
      ...(process.platform === "darwin"
        ? {
            ...this.entries[0]!.session.env,
            ZEROS_ZSR_MACOS_GIT_DISPATCHER: macosInterposition.dispatcher,
            ZEROS_ZSR_MACOS_GIT_BINARY: macosInterposition.gitBinary,
            ...(this.dispatchConfigPath
              ? { ZEROS_ZSR_GIT_DISPATCH_CONFIG: this.dispatchConfigPath }
              : {}),
          }
        : {}),
      PATH: `${this.options.toolsRoot}${path.delimiter}${
        pathValue ?? "/usr/local/bin:/usr/bin:/bin"
      }`,
    };
  }

  /** The macOS DYLD helper redirects absolute invocations of the trusted Git
   * binary through the same cwd-aware dispatcher as PATH-based invocations.
   * Seatbelt remains the authority if an executable bypasses interposition. */
  macosGitInterposition(): Readonly<{
    dispatcher: string;
    gitBinary: string;
  }> {
    return Object.freeze({
      dispatcher: path.join(this.options.toolsRoot, "git"),
      gitBinary: this.entries[0]!.repository.gitBinary,
    });
  }

  filesystemProjections(): readonly ShadowGitFilesystemProjection[] {
    return this.entries.map((entry) => entry.session.filesystemProjection());
  }

  async synchronize(): Promise<ShadowGitPromotionResult> {
    let updatedRefs = 0;
    let indexUpdated = false;
    let promoted = false;
    for (const entry of this.entries) {
      const result = await entry.session.synchronize();
      updatedRefs += result.updatedRefs;
      indexUpdated ||= result.indexUpdated;
      promoted ||= result.state === "promoted";
    }
    return {
      state: promoted ? "promoted" : "clean",
      updatedRefs,
      indexUpdated,
    };
  }

  async revokeRemoteCapability(): Promise<void> {
    const results = await Promise.allSettled(
      this.entries.map((entry) => entry.session.revokeRemoteCapability()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "one or more shadow Git capabilities could not be revoked",
      );
    }
  }

  async finalizeLinkedWorktrees(): Promise<number> {
    let finalized = 0;
    for (const entry of this.entries) {
      finalized += await entry.session.finalizeLinkedWorktrees();
    }
    return finalized;
  }

  async preserveForRecovery(reason: unknown): Promise<readonly string[]> {
    const preserved: string[] = [];
    for (const entry of this.entries) {
      preserved.push(await entry.session.preserveForRecovery(reason));
    }
    return preserved;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const results = await Promise.allSettled(
      this.entries.map((entry) => entry.session.stop()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "one or more shadow Git repositories could not be stopped",
      );
    }
  }
}

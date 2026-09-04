// ──────────────────────────────────────────────────────────
// Engine sidecar — spawn, track, shutdown, crash watchdog
// ──────────────────────────────────────────────────────────
//
// Electron sidecar manager. The Node.js Zeros engine runs as a child
// process of the Electron shell. It binds a local
// WebSocket + HTTP server on a release-channel-owned loopback range
// (Stable 24193–24200, Beta 24203–24210, Dev 24293–24300) and writes
// the actual port to its app-data runtime manifest once bound.
//
// Crash recovery: a lightweight watchdog requests `/health` from the bound
// port every 3 s; five consecutive failed responses (~15 s) →
// respawn with the last-known root and emit `engine-restarted` so the
// renderer can reconnect.
//
// `shutdown()` MUST be called from app.on("before-quit") — otherwise
// the Node child outlives the Electron window and eats a channel-owned
// engine port on the next launch.
// ──────────────────────────────────────────────────────────

import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { emitEvent } from "./ipc/events";
import { IS_DEV, IS_PACKAGED } from "./runtime-mode";
import { engineBasePort, ENGINE_PORT_SPAN } from "../src/engine/runtime";
import {
  appIdentity,
  engineRuntimeDir,
  zerosStateRoot,
} from "../src/engine/db/paths";
import { secretsFilePath, getSecret, setSecret } from "./secret-store";
import { githubCredentialStore } from "./github-auth-runtime";
import { getProductAccountIdForMain } from "./ipc/commands/auth-session";
import { githubCredentialForEngine } from "./github-engine-credential";
import {
  MCP_VAULT_ACCOUNT,
  parseVaultBlob,
  parseVaultControl,
  parseEngineLocalAuthorityControl,
  vaultSeedLine,
} from "../src/engine/agents/gateway/vault-persist";
import {
  isSameDevInstanceOrphan,
  parseProcessTable,
  shouldReapRangeListener,
} from "./orphan-engines";
import {
  ENGINE_STARTUP_TIMEOUT_MS,
  engineStartupWaitDecision,
  isExpectedEngineHealth,
  parseOwnedEngineManifest,
  zeroContactRespawnBackoffMs,
} from "./engine-health";
import { createSharedBackpressureGate } from "./stream-backpressure";
import { createBoundedLineForwarder } from "./bounded-line-forwarder";
import { classifyEngineStderrLine } from "./engine-stderr-level";
import {
  resolveDesktopEngineAuthEnv,
  stripWorkOSApiKeys,
} from "./desktop-engine-auth-config";
import { desktopAuthConfig } from "./workos-desktop-config";
import {
  cloudReplicaSessionControlLine,
  handleCloudReplicaEngineControl,
} from "./cloud-replica-host-runtime";
import { cloudWorkspaceDesktopCapabilityEnabled } from "../src/engine/cloud-workspace-capability";
import { seedCloudReplicaSessionToEngineIfEnabled } from "./cloud-replica-session-lifecycle";

// Resolve lazily: main.ts imports this module before its body seeds the release
// channel baked into a packaged build. Every actual sidecar operation runs after
// that seed, so deferring the lookup preserves one source of truth in
// apps/desktop/src/engine/runtime.ts and gives Stable, Beta, Dev, and per-worktree overrides
// the exact same block in both host and engine.
let resolvedEngineBasePort: number | null = null;
function currentEngineBasePort(): number {
  resolvedEngineBasePort ??= engineBasePort();
  return resolvedEngineBasePort;
}

function currentEnginePortRange(): string {
  const base = currentEngineBasePort();
  return `${base}-${base + ENGINE_PORT_SPAN - 1}`;
}

interface SidecarStateShape {
  child: ChildProcess | null;
  port: number | null;
  /** Per-boot nonce from the owned manifest; /health must echo it. */
  instance: string | null;
  /** Per-child loopback bearer received on private fd 3. Never in env/logs. */
  localToken: string | null;
  root: string | null;
  /** Flipped true by `shutdown()` so the watchdog stops respawning. */
  shuttingDown: boolean;
  /** Bumped every successful spawn; invalidates stale watchdog races
   *  so a post-respawn reachable probe doesn't respawn again. */
  spawnGeneration: number;
  watchdogTimer: NodeJS.Timeout | null;
}

const state: SidecarStateShape = {
  child: null,
  port: null,
  instance: null,
  localToken: null,
  root: null,
  shuttingDown: false,
  spawnGeneration: 0,
  watchdogTimer: null,
};

/** Current engine child identity for read-only diagnostics. Null while the
 * sidecar is stopped or between crash-recovery generations. */
export function getEnginePid(): number | null {
  const pid = state.child?.pid;
  return typeof pid === "number" && pid > 0 ? pid : null;
}

class EngineHealthUnreachableError extends Error {
  constructor(readonly port: number) {
    super(`engine on port ${port} did not answer its exact /health identity`);
    this.name = "EngineHealthUnreachableError";
  }
}

function archTriple(): string {
  if (process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.arch === "x64") return "x86_64-apple-darwin";
  throw new Error(`unsupported arch: ${process.arch}`);
}

/** Resolve the engine to spawn. Two very different paths:
 *
 *  PROD (app.isPackaged): spawn the bun-compiled standalone binary
 *    at Contents/Resources/zeros-engine. One-process, pre-bundled,
 *    no Node runtime needed.
 *
 *  DEV (pnpm electron:dev): spawn `bun apps/desktop/src/cli.ts serve …` directly.
 *    bun handles TS + ESM/CJS interop natively. No build step; edits
 *    in apps/desktop/src/engine/** take effect on the next engine respawn triggered
 *    by startEngineCodeWatcher() below.
 *
 *    Falls back to the pre-built bun binary at
 *    binaries/zeros-engine-<triple> if bun isn't on PATH. */
function resolveEngineSpawn(): { cmd: string; args: string[] } {
  const triple = archTriple();

  if (IS_PACKAGED) {
    const candidates = [
      path.join(process.resourcesPath, "zeros-engine"),
      path.join(process.resourcesPath, `zeros-engine-${triple}`),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return { cmd: p, args: [] };
    }
    throw new Error(
      `engine binary not found. Tried:\n${candidates
        .map((p) => `  ${p}`)
        .join("\n")}\nRun \`pnpm build:sidecar\` first.`,
    );
  }

  const repoRoot = path.resolve(__dirname, "..");
  const cliSrc = path.join(repoRoot, "apps", "desktop", "src", "cli.ts");

  // Dev default: run TS source directly with bun. Zero build step.
  if (existsSync(cliSrc)) {
    // Look for bun on PATH. `which` is synchronous here but cheap —
    // only runs once per spawnEngine call.
    const bunPath = resolveBunPath();
    if (bunPath) return { cmd: bunPath, args: [cliSrc] };
  }

  // Fallback: pre-compiled bun binary (dev without bun on PATH, or
  // `pnpm build:sidecar` was run and the binary is fresher).
  const devBin = path.join(repoRoot, "binaries", `zeros-engine-${triple}`);
  if (existsSync(devBin)) {
    return { cmd: devBin, args: [] };
  }
  throw new Error(
    `engine not found in dev mode. Install bun (https://bun.sh) or run \`pnpm build:sidecar\`.`,
  );
}

// Memoized: `which bun` is stable for the app's lifetime, and this runs on
// EVERY spawnEngine — under watchdog/HMR respawn churn the un-cached version
// re-shelled `which` on the main thread once per respawn for the same answer.
let bunPathCache: { path: string | null } | null = null;

function resolveBunPath(): string | null {
  if (bunPathCache) return bunPathCache.path;
  // spawnSync is imported lazily to avoid adding boot-time cost when
  // we're in prod and don't need to probe for bun. Sync is acceptable here
  // (unlike the reaper's lsof/ps) because it runs once per process now and
  // `which` only walks PATH.
  try {
    const { spawnSync } =
      require("node:child_process") as typeof import("node:child_process");
    const result = spawnSync("which", ["bun"], { encoding: "utf-8" });
    const p = result.status === 0 ? (result.stdout ?? "").trim() : "";
    bunPathCache = { path: p && existsSync(p) ? p : null };
  } catch {
    bunPathCache = { path: null };
  }
  return bunPathCache.path;
}

/** Resolve the two paths the engine needs to run the Node PTY host
 *  (apps/desktop/src/engine/pty/pty-host.cjs): the ABI-matching node-pty module and the
 *  host script. The engine runs under bun where node-pty I/O is broken, so it
 *  drives node-pty from a Node subprocess instead (see pty-host-client.ts). */
function resolvePtyHostPaths(): {
  script: string | null;
  nodePty: string | null;
} {
  // Packaged primary: use the dedicated Contents/Resources/node-pty copy.
  // Although app.asar.unpacked permits dlopen(), current macOS rejects
  // node-pty's separate spawn-helper executable from beneath that directory
  // (`posix_spawnp failed`). The same signed bytes work from ordinary Resources.
  // electron-builder.yml copies only lib + the target Darwin prebuild here.
  let nodePty: string | null = null;
  if (IS_PACKAGED) {
    const runtimeCopy = path.join(
      process.resourcesPath,
      "node-pty",
      "lib",
      "index.js",
    );
    if (existsSync(runtimeCopy)) nodePty = runtimeCopy;
  }
  // Dev and backwards-compatible packaged fallback: resolve the dependency,
  // rewriting app.asar to its unpacked native-module mirror when necessary.
  if (!nodePty) {
    try {
      const resolved = require.resolve("node-pty");
      const asarSeg = `${path.sep}app.asar${path.sep}`;
      const unpackedSeg = `${path.sep}app.asar.unpacked${path.sep}`;
      nodePty = resolved.includes(asarSeg)
        ? resolved.replace(asarSeg, unpackedSeg)
        : resolved;
    } catch {
      nodePty = null; // engine falls back to ordinary `node-pty` resolution
    }
  }

  // host script: packaged → Contents/Resources/pty-host.cjs (extraResources);
  // dev → the source .cjs in the repo.
  let script: string | null = null;
  if (IS_PACKAGED) {
    const packaged = path.join(process.resourcesPath, "pty-host.cjs");
    if (existsSync(packaged)) script = packaged;
  } else {
    const repoRoot = path.resolve(__dirname, "..");
    const dev = path.join(
      repoRoot,
      "apps",
      "desktop",
      "src",
      "engine",
      "pty",
      "pty-host.cjs",
    );
    if (existsSync(dev)) script = dev;
  }
  return { script, nodePty };
}

/** Resolve the Cursor SDK host script + the @cursor/sdk entry. The engine runs
 *  under bun, where @cursor/sdk's agent-run http2 transport can't reach Cursor
 *  (cert SAN mis-parse + flaky ALPN — see cursor-host.cjs), so it runs the SDK
 *  in a Node subprocess. Same shape as resolvePtyHostPaths: the host script
 *  ships via extraResources; @cursor/sdk resolves to its (asar-unpacked) entry
 *  because it pulls a native sqlite3 binding that can't be dlopen'd from inside
 *  asar. In dev both resolve to the repo unchanged. The Node runtime is shared
 *  with the PTY host (ZEROS_PTY_HOST_RUNTIME). */
function resolveCursorHostPaths(): {
  script: string | null;
  sdkEntry: string | null;
} {
  let sdkEntry: string | null = null;
  try {
    const resolved = require.resolve("@cursor/sdk");
    const asarSeg = `${path.sep}app.asar${path.sep}`;
    const unpackedSeg = `${path.sep}app.asar.unpacked${path.sep}`;
    sdkEntry = resolved.includes(asarSeg)
      ? resolved.replace(asarSeg, unpackedSeg)
      : resolved;
  } catch {
    sdkEntry = null; // host falls back to ordinary `@cursor/sdk` resolution
  }

  let script: string | null = null;
  if (IS_PACKAGED) {
    const packaged = path.join(process.resourcesPath, "cursor-host.cjs");
    if (existsSync(packaged)) script = packaged;
  } else {
    const repoRoot = path.resolve(__dirname, "..");
    const dev = path.join(
      repoRoot,
      "apps",
      "desktop",
      "src",
      "engine",
      "agents",
      "adapters",
      "cursor-sdk",
      "host",
      "cursor-host.cjs",
    );
    if (existsSync(dev)) script = dev;
  }
  return { script, sdkEntry };
}

/** Resolve the product-owned ZSR supervisor. It always runs under Electron's
 * Node mode, never under the Bun-compiled engine, because the exact-pinned SRT
 * component and its per-session module globals require an isolated Node
 * process. */
function resolveZsrSupervisorPath(): string | null {
  if (IS_PACKAGED) {
    const packaged = path.join(process.resourcesPath, "zsr-supervisor.mjs");
    return existsSync(packaged) ? packaged : null;
  }
  const dev = path.resolve(
    __dirname,
    "..",
    "apps",
    "desktop",
    "src",
    "engine",
    "agents",
    "containment",
    "zsr-supervisor.mjs",
  );
  return existsSync(dev) ? dev : null;
}

/** Resolve the unrestricted native lifecycle supervisor. It applies no ZSR
 * policy; it only keeps provider descendants in a crash-recoverable process
 * group. Like the ZSR supervisor, it needs Electron's Node mode because the
 * packaged engine is a Bun-compiled executable rather than a script runtime. */
function resolveHostProcessSupervisorPath(): string | null {
  if (IS_PACKAGED) {
    const packaged = path.join(
      process.resourcesPath,
      "host-process-supervisor.mjs",
    );
    return existsSync(packaged) ? packaged : null;
  }
  const development = path.resolve(
    __dirname,
    "..",
    "apps",
    "desktop",
    "src",
    "engine",
    "agents",
    "containment",
    "host-process-supervisor.mjs",
  );
  return existsSync(development) ? development : null;
}

/** Resolve SRT's required ripgrep helper without relying on the launcher's
 * PATH. Packaged builds execute the staged Resources copy; development first
 * accepts that same build output, then resolves the pinned optional package. */
function resolveZsrRipgrepPath(): string | null {
  const explicit = process.env.ZEROS_ZSR_RIPGREP_PATH?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;

  const staged = IS_PACKAGED
    ? path.join(process.resourcesPath, "zsr-rg")
    : path.resolve(__dirname, "..", "binaries", "zsr-rg");
  if (existsSync(staged)) return staged;
  if (IS_PACKAGED) return null;

  try {
    const packageName = "@vscode/ripgrep";
    const packageEntry = require.resolve(packageName);
    const fromPackage = createRequire(packageEntry);
    const binary = process.platform === "win32" ? "rg.exe" : "rg";
    const platformPackage = `@vscode/ripgrep-${process.platform}-${process.arch}`;
    const resolved = fromPackage.resolve(`${platformPackage}/bin/${binary}`);
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function resolveZsrMacosProcessDomainHelperPath(): string | null {
  if (process.platform !== "darwin") return null;
  const candidate = IS_PACKAGED
    ? path.join(process.resourcesPath, "zsr-macos-process-domain")
    : path.resolve(__dirname, "..", "binaries", "zsr-macos-process-domain");
  return existsSync(candidate) ? candidate : null;
}

function resolveZsrGitDispatchBinaryPath(): string | null {
  if (process.platform !== "darwin") return null;
  const candidate = IS_PACKAGED
    ? path.join(process.resourcesPath, "zsr-git-dispatch")
    : path.resolve(__dirname, "..", "binaries", "zsr-git-dispatch");
  return existsSync(candidate) ? candidate : null;
}

/** Resolve the Claude Code CLI the engine should hand the Agent SDK as
 *  `pathToClaudeCodeExecutable`, plus the claude-code version it implements.
 *
 *  WHY Electron main has to do this. `@anthropic-ai/claude-agent-sdk` ships no
 *  cli.js — the executable lives in a platform-specific OPTIONAL dep that the
 *  SDK finds with `createRequire(sdk.mjs).resolve('<pkg>/claude')`. The engine
 *  CANNOT run that lookup in a packaged app: it is a `bun build --compile`
 *  single-file binary, so sdk.mjs is bundled in, `import.meta.url` points into
 *  bun's `$bunfs`, and there is no node_modules on disk to walk. The SDK then
 *  throws "Native CLI binary for <plat>-<arch> not found" from `query()` and the
 *  user sees "AGENT RESPONSE FAILURE" on every send — while dev, where the engine
 *  is `bun <repo>/apps/desktop/src/cli.ts`, works perfectly. The resolver must
 *  therefore exercise the packaged dependency layout.
 *
 *  Same shape as resolvePtyHostPaths / resolveCursorHostPaths: packaged reads the
 *  extraResources copy (scripts/stage-claude-cli.mjs stages it at pack time), dev
 *  resolves the dependency. The version rides along because the engine's own
 *  version read (registry.ts readClaudeBundledCliVersion) is `require.resolve`d
 *  and therefore fails in the compiled binary too.
 *
 *  Returns nulls rather than throwing — the engine's binary-resolver has its own
 *  fallback tiers (a user's global `claude`), and a hard failure here would take
 *  down engine spawn entirely over one agent's runtime. */
function resolveClaudeCliPaths(): {
  binary: string | null;
  version: string | null;
} {
  let binary: string | null = null;
  let version: string | null = null;

  if (IS_PACKAGED) {
    const staged = path.join(process.resourcesPath, "claude");
    if (existsSync(staged)) binary = staged;
    const versionFile = path.join(
      process.resourcesPath,
      "claude-cli-version.txt",
    );
    try {
      const raw = readFileSync(versionFile, "utf8").trim();
      if (raw) version = raw;
    } catch {
      /* absent/unreadable — the engine just reports no bundled version */
    }
  }

  // Dev (and a packaged fallback if staging regressed): resolve the platform
  // package through the SDK's OWN location. It has to be anchored there because
  // pnpm links the platform package as a SIBLING of sdk.mjs inside the virtual
  // store and never hoists it to the root node_modules/@anthropic-ai/.
  if (!binary) {
    try {
      const sdkMain = require.resolve("@anthropic-ai/claude-agent-sdk");
      const fromSdk = createRequire(sdkMain);
      const bin = process.platform === "win32" ? "claude.exe" : "claude";
      const candidates =
        process.platform === "linux"
          ? [
              `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`,
              `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
            ]
          : [
              `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
            ];
      for (const pkg of candidates) {
        try {
          const resolved = fromSdk.resolve(`${pkg}/${bin}`);
          // An asar-packed copy is not executable; rewrite to the unpacked
          // mirror the way the node-pty / @cursor/sdk resolvers do.
          const asarSeg = `${path.sep}app.asar${path.sep}`;
          const unpackedSeg = `${path.sep}app.asar.unpacked${path.sep}`;
          const onDisk = resolved.includes(asarSeg)
            ? resolved.replace(asarSeg, unpackedSeg)
            : resolved;
          if (existsSync(onDisk)) {
            binary = onDisk;
            break;
          }
        } catch {
          /* not installed for this platform — try the next candidate */
        }
      }
      if (!version) {
        // Walk up from sdk.mjs to the SDK's manifest.json / package.json, the
        // same way scripts/stage-claude-cli.mjs does at pack time.
        let dir = path.dirname(sdkMain);
        for (let i = 0; i < 6; i++) {
          const manifest = path.join(dir, "manifest.json");
          if (existsSync(manifest)) {
            const v = JSON.parse(readFileSync(manifest, "utf8")).version;
            if (typeof v === "string") {
              version = v;
              break;
            }
          }
          const pkgJson = path.join(dir, "package.json");
          if (existsSync(pkgJson)) {
            const j = JSON.parse(readFileSync(pkgJson, "utf8")) as {
              name?: string;
              claudeCodeVersion?: string;
            };
            if (j.name === "@anthropic-ai/claude-agent-sdk") {
              if (typeof j.claudeCodeVersion === "string") {
                version = j.claudeCodeVersion;
              }
              break;
            }
          }
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
    } catch {
      /* SDK not resolvable — engine falls back to a global `claude` */
    }
  }

  if (!binary) {
    // Loud, because in a packaged build this means the staged runtime is gone and
    // every Claude send will fall back to the user's own install (or fail).
    console.error(
      "[Zeros] Claude Code CLI not found (no staged Contents/Resources/claude, " +
        "no resolvable platform package) — Claude will fall back to a global " +
        "`claude` install if one exists. Run `pnpm stage:claude-cli`.",
    );
  }
  return { binary, version };
}

function codexTargetTriple(
  platform = process.platform,
  arch = process.arch,
): string | null {
  const triples: Record<string, string> = {
    "darwin:x64": "x86_64-apple-darwin",
    "darwin:arm64": "aarch64-apple-darwin",
    "linux:x64": "x86_64-unknown-linux-musl",
    "linux:arm64": "aarch64-unknown-linux-musl",
    "win32:x64": "x86_64-pc-windows-msvc",
    "win32:arm64": "aarch64-pc-windows-msvc",
  };
  return triples[`${platform}:${arch}`] ?? null;
}

/** Resolve the complete pinned Codex runtime staged in Resources. Development
 *  uses the same optional platform package directly; production must never
 *  depend on a user's PATH because that can select a different CLI/version than
 *  the app-server protocol bindings and live capability discovery were built
 *  against. */
function resolveCodexCliPaths(): {
  binary: string | null;
  version: string | null;
  managedPackageRoot: string | null;
} {
  let binary: string | null = null;
  let version: string | null = null;
  let managedPackageRoot: string | null = null;

  if (IS_PACKAGED) {
    const triple = codexTargetTriple();
    managedPackageRoot = path.join(process.resourcesPath, "codex-runtime");
    const staged = path.join(
      managedPackageRoot,
      "vendor",
      triple ?? "unsupported-target",
      "bin",
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    // The handoff is authoritative even when staging is corrupt. Returning the
    // expected path makes the engine surface ENOENT instead of silently running
    // a different global Codex whose protocol may not match this build.
    binary = staged;
    try {
      const raw = readFileSync(
        path.join(process.resourcesPath, "codex-cli-version.txt"),
        "utf8",
      ).trim();
      if (raw) version = raw;
    } catch {
      /* absent/unreadable — provider diagnostics report no bundled version */
    }
    if (!existsSync(staged)) {
      version = null;
      console.error(
        "[Zeros] staged Codex runtime not found under Contents/Resources/" +
          "codex-runtime — Codex will be unavailable until the app is reinstalled",
      );
    }
  } else {
    // Source checkouts ONLY, and deliberately not a fallback for a packaged
    // build with missing staging. electron-builder excludes the @openai/codex-*
    // platform packages from app.asar (and nothing can be exec'd from inside an
    // asar anyway), so this tier can never yield a packaged binary — while the
    // wrapper's package.json IS still in the asar and would happily yield a
    // version. Reading it there would make registry.ts report the pinned
    // version while binary-resolver.ts runs an unpinned `codex` from PATH,
    // hiding exactly the staging regression this pin exists to prevent.
    try {
      const wrapperPackageJson = require.resolve("@openai/codex/package.json");
      managedPackageRoot = path.dirname(wrapperPackageJson);
      const wrapper = JSON.parse(readFileSync(wrapperPackageJson, "utf8")) as {
        version?: string;
      };
      if (!version && typeof wrapper.version === "string") {
        version = wrapper.version;
      }
      if (!binary) {
        const targets: Record<string, { package: string; triple: string }> = {
          "darwin-arm64": {
            package: "@openai/codex-darwin-arm64",
            triple: "aarch64-apple-darwin",
          },
          "darwin-x64": {
            package: "@openai/codex-darwin-x64",
            triple: "x86_64-apple-darwin",
          },
          "linux-arm64": {
            package: "@openai/codex-linux-arm64",
            triple: "aarch64-unknown-linux-musl",
          },
          "linux-x64": {
            package: "@openai/codex-linux-x64",
            triple: "x86_64-unknown-linux-musl",
          },
          "win32-arm64": {
            package: "@openai/codex-win32-arm64",
            triple: "aarch64-pc-windows-msvc",
          },
          "win32-x64": {
            package: "@openai/codex-win32-x64",
            triple: "x86_64-pc-windows-msvc",
          },
        };
        const target = targets[`${process.platform}-${process.arch}`];
        if (target) {
          const fromWrapper = createRequire(wrapperPackageJson);
          const platformPackageJson = fromWrapper.resolve(
            `${target.package}/package.json`,
          );
          const resolved = path.join(
            path.dirname(platformPackageJson),
            "vendor",
            target.triple,
            "bin",
            process.platform === "win32" ? "codex.exe" : "codex",
          );
          if (existsSync(resolved)) binary = resolved;
        }
      }
    } catch {
      /* optional package not installed — engine retains its PATH fallback */
    }
  }

  // Source checkouts only: the packaged branch always returns the staged path
  // (and reports its own absence above), so reaching here means the optional
  // @openai/codex-<platform> package is missing from this dev install.
  if (!binary) {
    console.error(
      "[Zeros] pinned Codex runtime not found (no resolvable " +
        "@openai/codex platform package) — Codex will fall back to an " +
        "unpinned `codex` on PATH. Run `pnpm stage:codex-cli`.",
    );
  }
  return { binary, version, managedPackageRoot };
}

/** Prove the engine event loop can answer, not merely that its kernel listener
 * still owns the port. A wedged Bun process can keep completing TCP handshakes
 * from the accept backlog for minutes while every HTTP/WS request is frozen;
 * the old connect-only watchdog therefore missed the archive hang it was meant
 * to recover. `/health` is synchronous and loopback-only, so a valid response
 * is the smallest application-level liveness check. The manifest's per-boot
 * nonce makes this an ownership check too: a sibling/stale engine returning a
 * generic healthy response on the same port is not OUR engine. */
function engineResponsive(
  port: number,
  expectedInstance: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (responsive: boolean) => {
      if (settled) return;
      settled = true;
      resolve(responsive);
    };
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        timeout: 1500,
        headers: { Host: `127.0.0.1:${port}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 8192) body += chunk;
        });
        res.once("end", () => {
          if (res.statusCode !== 200) {
            finish(false);
            return;
          }
          try {
            finish(isExpectedEngineHealth(JSON.parse(body), expectedInstance));
          } catch {
            finish(false);
          }
        });
        res.once("error", () => finish(false));
      },
    );
    req.once("timeout", () => {
      req.destroy();
      finish(false);
    });
    req.once("error", () => finish(false));
    req.end();
  });
}

/** Run a diagnostic subprocess WITHOUT blocking the Electron main thread.
 *
 *  The reaper/diagnostic paths used spawnSync for lsof/ps — but sidecar.ts IS
 *  Electron main, and those tools routinely take tens-to-hundreds of ms (lsof
 *  can stall for seconds on a busy machine). spawnSync froze the entire UI for
 *  that long, in exactly the failure mode these paths exist to recover from —
 *  a wedged engine driving watchdog respawns every ~21s, each one freezing the
 *  window again. execFile keeps the event loop free; the timeout + SIGKILL
 *  bound a hung tool so a diagnostic can never wedge the app it's diagnosing. */
function execFileText(
  cmd: string,
  args: string[],
  timeoutMs = 4_000,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: "utf-8", timeout: timeoutMs, killSignal: "SIGKILL" },
      (error, stdout) => {
        resolve({ ok: !error, stdout: stdout ?? "" });
      },
    );
  });
}

/** One lsof snapshot of everything LISTENing on this build's engine range —
 *  the first question to answer when a "ready" engine is unreachable is "who
 *  actually owns the port?", and by the time a human reads the log the moment
 *  has passed. Diagnostic only; failures degrade to a placeholder string. */
async function describeRangeListeners(): Promise<string> {
  const enginePortRange = currentEnginePortRange();
  const probe = await execFileText("lsof", [
    "-nP",
    `-iTCP:${enginePortRange}`,
    "-sTCP:LISTEN",
  ]);
  if (!probe.ok && probe.stdout.trim().length === 0) {
    // lsof exits non-zero BOTH for "no matches" (empty stdout — a real answer)
    // and for "not runnable" — only the latter should read as unavailable.
    return "(no listeners found / lsof unavailable)";
  }
  return probe.stdout.trim() || "(no listeners found)";
}

/** Cross-process readiness gate: the engine manifest proves the child believes
 *  it bound `port`; this proves the independent Electron host can repeatedly
 *  reach that exact boot after later startup subsystems are armed. In beta.84,
 *  an early same-process probe passed before Chokidar started a native macOS
 *  FSEvents watcher; that watcher then deadlocked the Bun-compiled event loop,
 *  producing a TCP listener that never answered Electron, curl, or the renderer.
 *
 *  A failed gate blocks publication and lets spawnEngineWithRecovery relaunch
 *  on the next channel-owned candidate instead of handing a dead bridge to the
 *  renderer or waiting for the watchdog's later kill/respawn cycle. */
async function confirmSpawnReachable(
  port: number,
  generation: number,
  instance: string,
): Promise<boolean> {
  let consecutive = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (state.shuttingDown || state.spawnGeneration !== generation)
      return false;
    if (await engineResponsive(port, instance)) {
      consecutive += 1;
      if (consecutive >= 3) return true;
    } else {
      consecutive = 0;
    }
    if (attempt < 4) await new Promise<void>((r) => setTimeout(r, 500));
  }
  if (state.shuttingDown || state.spawnGeneration !== generation) return false;
  console.error(
    `[Zeros] engine reported ready on port ${port} but its exact /health identity is unreachable from the host — ` +
      `the listener may be wedged or another process may own its traffic. Listeners on ${currentEnginePortRange()}:\n` +
      (await describeRangeListeners()),
  );
  return false;
}

/** Signal the engine's whole PROCESS GROUP, falling back to the single pid.
 *
 *  The engine is spawned as its own group leader (`detached`, see doSpawnEngine),
 *  so `process.kill(-pid, sig)` (negative pid = process group) reaches the engine
 *  AND its forked Node cursor-host / pty-host children — and the pty shells those
 *  own — in one shot. This is THE fix for the ppid=1 orphan leak: the old
 *  single-pid kill left every grandchild running when the engine was SIGKILLed,
 *  and they reparented to launchd and lived forever (18 stranded `cursor-agent`
 *  procs observed). Even after the leader exits, surviving members keep the pgid,
 *  so a group signal still reaps them; an already-empty group just throws ESRCH.
 *
 *  NB: the SDK-spawned `cursor-agent` runtime is itself detached into a SEPARATE
 *  group, so it is NOT reached here — the cursor-host reaps it via run.cancel()
 *  on its own teardown (see cursor-host.cjs). Windows has no process groups; we
 *  fall straight to the single pid there. */
function signalEngineTree(
  child: ChildProcess | null,
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      /* group gone or not a leader — fall back to the single pid below */
    }
  }
  try {
    if (child && !child.killed) child.kill(signal);
    else if (pid !== undefined) process.kill(pid, signal);
  } catch {
    /* already dead or perms */
  }
}

/** SIGTERM → wait → SIGKILL escalation for the current engine child.
 *
 *  THE BUG this fixes: the old version sent SIGTERM and immediately
 *  returned. If the engine's event loop was blocked (mid file re-index,
 *  heavy cache work), it couldn't process the signal and stayed alive.
 *  spawnEngine then created a NEW engine bound to a NEW port; the OLD
 *  one kept running forever, orphaned — `state.child` already points
 *  to the new spawn, so nothing else ever signals it. Across many
 *  watchdog respawns, orphan engines pile up across the channel's port walk.
 *  each holding a port + file watcher + memory. Repro: git commit
 *  triggers cache rebuild → event loop stall → watchdog times out →
 *  respawn loop. lsof showed 3+ bun processes after a few commits.
 *
 *  The fix: SIGTERM, then poll the child for up to 2 s, then SIGKILL
 *  the PID directly if it's still alive. The PID-based fallback is
 *  important because `current.kill()` is a no-op on a process that
 *  ignored SIGTERM — `process.kill(pid, "SIGKILL")` always lands.
 *
 *  Awaitable so spawnEngine can wait for the port to actually be free
 *  before binding (otherwise the new engine bumps to the next port
 *  and the supposedly-dead one keeps listening on the old port). */
async function killCurrentChild(): Promise<void> {
  const current = state.child;
  state.child = null;
  state.port = null;
  state.instance = null;
  state.localToken = null;
  if (!current || current.killed) return;
  const pid = current.pid;

  // SIGTERM first — gives the engine's signal handlers a chance to flush logs,
  // dispose the cursor/pty hosts (which cancel their runs → the SDK reaps the
  // detached cursor-agent group), close sockets, and exit cleanly. Sent to the
  // whole group so the hosts get their own SIGTERM too, not just via the engine.
  signalEngineTree(current, pid, "SIGTERM");

  // Wait up to 15 s for graceful exit. The `exit` event fires when
  // the process actually terminates (whether from SIGTERM or any
  // other cause). Resolve early if it lands within the window.
  //
  // 2026-05-28: bumped from 2 s → 5 s. The engine's `stop()` disposes
  // its chat adapters in parallel; the codex app-server adapter alone
  // does a JSON-RPC `dispose` round-trip + child kill which can take
  // 1-2 s end-to-end. At 2 s we were SIGKILLing on every HMR
  // respawn ("engine PID … ignored SIGTERM; SIGKILLed") which left
  // half-flushed SQLite writes and in-flight
  // permission promises in undefined states.
  //
  // 2026-08-17: bumped from 5 s → 15 s to stay above the engine's own 12 s
  // shutdown cap (apps/desktop/src/cli.ts). ZSR session teardown promotes
  // provider-HOME/shadow-Git state and retires process-domain descriptors;
  // SIGKILLing through that is what turned every dev restart into a
  // "recovered N crashed process domain(s)" boot. A clean exit still
  // resolves this wait immediately, so fast restarts stay fast.
  await new Promise<void>((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve();
      }
    }, 15_000);
    current.once("exit", () => {
      if (!done) {
        done = true;
        clearTimeout(t);
        resolve();
      }
    });
  });

  // Escalate to SIGKILL on the whole GROUP — but ONLY if the engine is still
  // alive after the grace (i.e. it ignored SIGTERM, event-loop wedged). On a
  // CLEAN exit we deliberately do NOT group-SIGKILL: the cursor/pty hosts (same
  // group) received the SIGTERM at t=0 and are mid-teardown, cancelling their
  // runs so the SDK reaps the DETACHED cursor-agent group — SIGKILLing them now
  // would strand exactly the grandchildren we're trying to reap. When the engine
  // IS wedged, the hosts still got their SIGTERM at t=0, so by this 5s mark they
  // have long finished their ≤2.5s teardown; group-SIGKILLing then fells only the
  // stuck engine. process.kill(pid, 0) is a no-signal liveness probe (throws
  // ESRCH if gone).
  if (pid !== undefined) {
    let leaderAlive = false;
    try {
      process.kill(pid, 0);
      leaderAlive = true;
    } catch {
      /* leader exited cleanly — hosts self-reap via stdin-close + their SIGTERM */
    }
    if (leaderAlive) {
      signalEngineTree(current, pid, "SIGKILL");
      console.warn(
        `[Zeros] engine PID ${pid} ignored SIGTERM; SIGKILLed process group`,
      );
    }
  }

  // macOS releases the listening socket a bit after the process
  // exits. 250ms grace so the next spawnEngine doesn't bump to a
  // higher port thinking the channel's base is still in use.
  await new Promise<void>((r) => setTimeout(r, 250));
}

/** Once-per-process flag so we only reap on cold start. Re-spawning the
 *  engine for a different project should NOT reap — by that point we
 *  own the ports through `state.child` and the reaper can't distinguish
 *  our new child from an orphan before bind completes. */
let orphansReaped = false;

/**
 * Kill stranded engine processes left over from prior app runs.
 *
 * Zeros' engine binds the current release channel's isolated walk range:
 * Stable 24193–24200, Beta 24203–24210, or Dev 24293–24300. When the app was
 * killed without a clean shutdown (crash, force-quit, legacy native migration),
 * the child outlives its parent and keeps the port. The next launch then gets
 * bumped up the retry chain, and the renderer — which probes get_engine_port
 * but falls back to the base — may talk to a zombie that speaks an older
 * protocol or is wedged. Symptom: every agent request times out even though
 * "an engine" is running.
 *
 * We defensively scan THIS launch's range with lsof and match known engine
 * (and engine-host) command lines, gated on ppid 1 so a listener whose owner
 * is still alive — an older sibling build from before channel ranges were
 * isolated, a standalone `zeros serve` under a shell, an engine mid-graceful
 * shutdown — is never cross-killed; the bounded port walk plus Electron's
 * external identity check routes this launch around it instead (see
 * shouldReapRangeListener). A linked-
 * worktree dev launch also finds PPID-1 Bun engines from its exact source CLI
 * + ZEROS_INSTANCE across older dynamic port blocks: the launcher
 * intentionally chooses a new free block, so range-only cleanup cannot see
 * yesterday's orphan. Unrecognized processes are left alone.
 *
 * Kills signal the process GROUP (engines are spawned as group leaders), with
 * a single-pid fallback. The old single-pid kill was the root of the beta.82
 * black-holed-port loop: SIGKILLing just the engine left its children
 * (pty-host, cursor-host, agent CLIs) holding inherited copies of the LISTEN
 * socket, so the port stayed "bound" with nobody accepting and every fresh
 * engine that re-bound it answered nothing.
 */
async function reapOrphanEngines(skipPid?: number): Promise<void> {
  const enginePortRange = currentEnginePortRange();
  const rangePids = new Set<number>();
  // lsof/ps run through execFileText (async + bounded) — the old spawnSync
  // calls froze Electron main for the tools' full runtime on every cold start
  // and after every watchdog/HMR respawn. See execFileText.
  const probe = await execFileText("lsof", [
    `-iTCP:${enginePortRange}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  if (probe.ok) {
    for (const raw of probe.stdout.split(/\s+/)) {
      const pid = Number.parseInt(raw, 10);
      if (
        Number.isFinite(pid) &&
        pid > 0 &&
        pid !== process.pid &&
        pid !== skipPid
      ) {
        rangePids.add(pid);
      }
    }
  }
  // else: the exact-instance process-table scan below can still find dev orphans.

  let processRows: ReturnType<typeof parseProcessTable> = [];
  const table = await execFileText("ps", ["-axo", "pid=,ppid=,command="]);
  if (table.ok) {
    processRows = parseProcessTable(table.stdout);
  }
  // else: range candidates still get a per-PID command probe below.
  const rowByPid = new Map(processRows.map((row) => [row.pid, row]));
  const enginePids = new Set<number>();

  // A port-range match is intentionally command-shape-based, but before killing
  // we prove the candidate is engine-shaped (or an orphaned engine HOST holding
  // the engine's inherited listen socket) AND that no live parent still owns it.
  // Shape alone is never proof that this process is abandoned.
  for (const pid of rangePids) {
    const row = rowByPid.get(pid);
    let command = row?.command ?? "";
    let ppid: number | null = row?.ppid ?? null;
    if (!command) {
      const ps = await execFileText("ps", [
        "-p",
        String(pid),
        "-o",
        "ppid=,command=",
      ]);
      if (ps.ok) {
        const m = ps.stdout.trim().match(/^(\d+)\s+(.*)$/s);
        if (m) {
          ppid = Number.parseInt(m[1]!, 10);
          command = m[2]!.trim();
        }
      }
      // A failed probe (exited/unreadable candidate) is harmless — the
      // shouldReapRangeListener null-ppid case fails closed.
    }
    if (shouldReapRangeListener({ command, ppid })) enginePids.add(pid);
  }

  // Per-worktree dev ports are dynamic. Find only parentless engines carrying
  // this exact linked-worktree identity, even if they listen on an older block.
  const instance = process.env.ZEROS_INSTANCE?.trim() ?? "";
  if (IS_DEV && instance) {
    const cliPath = path.join(
      path.resolve(__dirname, ".."),
      "apps",
      "desktop",
      "src",
      "cli.ts",
    );
    for (const row of processRows) {
      if (
        row.ppid !== 1 ||
        row.pid === skipPid ||
        !row.command.includes(cliPath)
      ) {
        continue;
      }
      const envProbe = await execFileText("ps", [
        "eww",
        "-p",
        String(row.pid),
        "-o",
        "command=",
      ]);
      if (!envProbe.ok) continue;
      const processWithEnvironment = envProbe.stdout;
      if (
        isSameDevInstanceOrphan(row, {
          cliPath,
          instance,
          processWithEnvironment,
          skipPid,
        })
      ) {
        enginePids.add(row.pid);
      }
    }
  }

  if (enginePids.size === 0) return;

  // Signal the whole process GROUP, falling back to the single pid. Engines
  // are spawned as group leaders, so the group signal also reaches the
  // pty/cursor hosts and agent CLIs holding inherited copies of the engine's
  // LISTEN socket — the single-pid kill used to leave those alive, and the
  // port stayed black-holed for every later bind (beta.82 respawn loop). A
  // non-leader candidate (an orphaned host) has no group of its own pgid, so
  // the group attempt throws ESRCH and the plain pid signal lands instead.
  const signalTree = (pid: number, signal: NodeJS.Signals): boolean => {
    let landed = false;
    try {
      process.kill(-pid, signal);
      landed = true;
    } catch {
      /* not a group leader, or the group is already empty */
    }
    try {
      process.kill(pid, signal);
      landed = true;
    } catch {
      /* already gone, or permissions issue */
    }
    return landed;
  };

  // SIGTERM first — gives the process a chance to flush logs / close sockets
  // cleanly. Track only PIDs we actually signalled.
  const signalled: number[] = [];
  for (const pid of enginePids) {
    if (signalTree(pid, "SIGTERM")) signalled.push(pid);
  }
  await new Promise<void>((r) => setTimeout(r, 500));

  // Escalate any orphan that ignored SIGTERM, then let macOS release sockets.
  const stillAlive = signalled.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  for (const pid of stillAlive) {
    signalTree(pid, "SIGKILL");
  }
  await new Promise<void>((r) => setTimeout(r, 250));

  for (const pid of signalled) {
    console.log(
      rangePids.has(pid)
        ? `[Zeros] reaped orphan engine PID ${pid} on port range ${enginePortRange}`
        : `[Zeros] reaped orphan engine PID ${pid} for this dev instance`,
    );
  }
}

/**
 * Spawn the engine with `projectRoot` as its working directory. Kills any
 * previous child first, then waits through bounded stale-containment recovery
 * for the exact child to publish and answer through its owned manifest.
 */
// Single-flight chain across ALL respawn drivers: the HMR code-watcher, the
// crash watchdog, IPC engineRestart/openProjectFolder, and deep-link handling
// each call spawnEngine() independently. The HMR watcher's `respawning` flag is
// closure-local and doesn't cover the others, so without a shared guard two
// spawns can interleave at killCurrentChild()'s await boundary: the second sees
// state.child already nulled, skips the kill, and spawns a SECOND engine while
// the first is orphaned (the range reaper mostly cleans it up, but it's a real
// port-flap / wrong-state.port window). Chaining every spawn through one
// promise makes them run strictly sequentially — no interleave, no orphan — and
// the latest request still produces a fresh engine. Errors are swallowed on the
// chain so one failed spawn doesn't wedge the next.
let spawnChain: Promise<unknown> = Promise.resolve();

// Cold-start PATH hydration is independent of BrowserWindow creation, but the
// engine child must inherit the repaired PATH. main.ts installs this barrier
// and starts spawnEngine immediately; the spawn remains single-flight behind
// it while the renderer can paint its validated boot snapshot in parallel.
let engineSpawnBarrier: Promise<void> = Promise.resolve();

/** Private main→engine capability courier. Kept outside process.env so shell,
 * updater, and other main-process children cannot inherit the browser bearer.
 * The engine captures and scrubs these two names before it spawns an agent. */
let browserServiceEnvironment: { url: string; token: string } | null = null;

export function setBrowserServiceEnvironment(
  value: { url: string; token: string } | null,
): void {
  browserServiceEnvironment = value;
}

export function setEngineSpawnBarrier(barrier: Promise<unknown>): void {
  engineSpawnBarrier = barrier.then(
    () => undefined,
    (error) => {
      console.warn(
        `[Zeros] engine spawn prerequisite failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  );
}

// Coalesce: the root + promise of the most-recently-queued spawn while it is
// still pending. Several drivers can fire for the SAME root in quick succession
// — the crash watchdog, a deep-link, and a recent-project re-open all hitting
// one folder — and chaining each would serialize a full kill+respawn (≈ one
// kill grace apiece) for what should be a single spawn. If a request arrives
// for the root that's already the latest in-flight spawn, we hand back that
// promise instead of stacking another. Distinct roots still queue normally.
let pendingSpawnRoot: string | null = null;
let pendingSpawn: Promise<number> | null = null;

export function spawnEngine(projectRoot: string): Promise<number> {
  if (pendingSpawnRoot === projectRoot && pendingSpawn) {
    return pendingSpawn;
  }
  const prerequisite = engineSpawnBarrier;
  const next = spawnChain.then(
    () => spawnEngineWithRecovery(projectRoot, prerequisite),
    () => spawnEngineWithRecovery(projectRoot, prerequisite),
  );
  spawnChain = next.then(
    () => undefined,
    () => undefined,
  );
  pendingSpawnRoot = projectRoot;
  pendingSpawn = next;
  // Clear the coalesce slot once THIS spawn settles (only if it's still the
  // latest — a newer queued spawn must keep its own slot).
  const clear = () => {
    if (pendingSpawn === next) {
      pendingSpawnRoot = null;
      pendingSpawn = null;
    }
  };
  next.then(clear, clear);
  return next;
}

/** Start on the channel base, publish only after an external exact-identity
 *  health response, and move monotonically through the rest of this channel's
 *  range when a bound listener cannot answer.
 *
 *  LocalTransport still handles ordinary EADDRINUSE by walking within the
 *  span passed to it. This outer loop covers the harder case: Bun accepted a
 *  bind but traffic is black-holed (for example, a stale inherited socket).
 *  Keeping the retry here gives the verifier an independent process/network
 *  stack and makes it impossible to walk into another channel's footprint. */
async function spawnEngineWithRecovery(
  projectRoot: string,
  prerequisite: Promise<void>,
): Promise<number> {
  const rangeStart = currentEngineBasePort();
  const rangeEnd = rangeStart + ENGINE_PORT_SPAN - 1;
  console.log(
    `[Zeros] engine spawn entering externally-verified range ${rangeStart}-${rangeEnd}`,
  );
  let requestedPort = rangeStart;
  let barrier = prerequisite;
  let lastFailedPort = rangeStart;

  while (requestedPort <= rangeEnd) {
    if (state.shuttingDown) {
      throw new Error("engine spawn cancelled while the app is shutting down");
    }
    try {
      return await doSpawnEngine(
        projectRoot,
        barrier,
        rangeStart,
        requestedPort,
        rangeEnd - requestedPort + 1,
      );
    } catch (err) {
      if (state.shuttingDown) throw err;
      if (!(err instanceof EngineHealthUnreachableError)) throw err;
      lastFailedPort = err.port;
      const nextPort = Math.max(requestedPort + 1, err.port + 1);
      if (nextPort > rangeEnd) break;
      console.warn(
        `[Zeros] external readiness failed on port ${err.port}; retrying engine at ${nextPort}`,
      );
      requestedPort = nextPort;
      // The first attempt already awaited the cold-start prerequisites.
      barrier = Promise.resolve();
    }
  }

  throw new Error(
    `engine could not answer /health on any channel-owned port ` +
      `${rangeStart}-${rangeEnd} (last failed port ${lastFailedPort})`,
  );
}

/** Resolve the current or already-queued engine start without guessing a port
 * or stacking a default-root spawn behind an in-flight project switch. */
export function ensureEngineRunning(): Promise<number> {
  const port = currentPort();
  if (port !== null) return Promise.resolve(port);
  if (pendingSpawn) return pendingSpawn;
  return spawnEngine(currentRoot() ?? defaultProjectRoot());
}

async function doSpawnEngine(
  projectRoot: string,
  prerequisite: Promise<void> = Promise.resolve(),
  rangeBasePort = currentEngineBasePort(),
  requestedPort = currentEngineBasePort(),
  portSpan = ENGINE_PORT_SPAN,
): Promise<number> {
  let orphanCleanup: Promise<void> = Promise.resolve();
  if (!orphansReaped) {
    orphansReaped = true;
    orphanCleanup = reapOrphanEngines();
  }
  // Cold-start orphan cleanup and macOS shell-PATH hydration are independent.
  // Run them concurrently, then spawn only after both are complete.
  await Promise.all([prerequisite, orphanCleanup]);
  console.log(
    `[Zeros] engine spawn prerequisites complete; requesting ${requestedPort}-${requestedPort + portSpan - 1}`,
  );
  await killCurrentChild();

  const { cmd, args: engineArgs } = resolveEngineSpawn();
  // The engine writes its bootstrap manifest (port + boot identity, never the
  // /ws bearer) here — in the app-data dir keyed by repo, NOT into
  // <projectRoot>/.zeros. We read the port back below. Delete a stale one first
  // so a slow boot can't read the previous run's port.
  const manifestFile = path.join(engineRuntimeDir(projectRoot), "engine.json");
  try {
    unlinkSync(manifestFile);
  } catch {
    /* file may not exist; fine */
  }

  // Always pipe stdio. We used to use `inherit` in dev so engine logs
  // appeared in the dev terminal — that worked locally but made remote
  // diagnosis impossible because the central main.log file (the one
  // the renderer's "View → Toggle Developer Tools → main log path"
  // surfaces) only captured Electron-main logs. Anything from the
  // engine subprocess vanished. Now we pipe in both modes and forward:
  //   - dev:      child stdout/stderr → console.log/error → main.log
  //               (and the dev terminal still sees them via the
  //                inherited console writes from Electron main).
  //   - packaged: same forwarding, plus a side-stream into engine.log
  //               for raw spool inspection.
  const isPackaged = IS_PACKAGED;

  // Hand the engine the path to the encrypted secret store so its
  // `secret-account` auth probes (e.g. Cursor's CURSOR_API_KEY) can check
  // key-presence. The engine is a separate process and can't call Electron
  // safeStorage; it reads key-presence only, never the (encrypted) value.
  // Guarded so a pre-`ready` spawn can't throw — an unset var just makes
  // those probes a no-op and the agent falls back to CLI/file probes.
  let secretsFile: string | undefined;
  try {
    secretsFile = secretsFilePath();
  } catch {
    /* userData unavailable — engine falls back to CLI/file probes */
  }

  // Hand the engine the path to the legacy Electron-main agent-history DB so it
  // can run the one-time legacy migration into the unified Zeros DB. The engine
  // reads it read-only and no-ops when the file is absent / already migrated.
  let legacyAgentDb: string | undefined;
  try {
    legacyAgentDb = path.join(
      app.getPath("userData"),
      "zeros-agent-history.db",
    );
  } catch {
    /* userData unavailable — migration is a no-op */
  }

  const extraEnv: Record<string, string> = {};
  if (browserServiceEnvironment) {
    extraEnv.ZEROS_BROWSER_SERVICE_URL = browserServiceEnvironment.url;
    extraEnv.ZEROS_BROWSER_SERVICE_TOKEN = browserServiceEnvironment.token;
  }
  if (secretsFile) extraEnv.ZEROS_SECRETS_FILE = secretsFile;
  if (legacyAgentDb) extraEnv.ZEROS_LEGACY_AGENT_DB = legacyAgentDb;

  // PTY host runtime. The engine runs under bun, where node-pty's PTY I/O is
  // broken (a spawned shell emits no bytes). It therefore runs the real
  // node-pty shells in a tiny Node subprocess (pty-host.cjs). Hand it the
  // runtime to spawn that with — THIS Electron binary, run as Node via
  // ELECTRON_RUN_AS_NODE — plus the ABI-matching node-pty path and the host
  // script path. (A standalone/source engine with no Electron host falls back
  // to `node` on PATH; see pty-host-client.ts.)
  extraEnv.ZEROS_PTY_HOST_RUNTIME = process.execPath;
  extraEnv.ZEROS_PTY_HOST_RUNTIME_ELECTRON = "1";
  extraEnv.ZEROS_HOST_SUPERVISOR_RUNTIME = process.execPath;
  const hostProcessSupervisor = resolveHostProcessSupervisorPath();
  if (hostProcessSupervisor) {
    extraEnv.ZEROS_HOST_SUPERVISOR_SCRIPT = hostProcessSupervisor;
  }
  extraEnv.ZEROS_ZSR_SUPERVISOR_RUNTIME = process.execPath;
  const zsrSupervisor = resolveZsrSupervisorPath();
  if (zsrSupervisor) extraEnv.ZEROS_ZSR_SUPERVISOR_SCRIPT = zsrSupervisor;
  const zsrRipgrep = resolveZsrRipgrepPath();
  if (zsrRipgrep) extraEnv.ZEROS_ZSR_RIPGREP_PATH = zsrRipgrep;
  const zsrMacosProcessDomain = resolveZsrMacosProcessDomainHelperPath();
  if (zsrMacosProcessDomain) {
    extraEnv.ZEROS_ZSR_MACOS_PROCESS_DOMAIN_HELPER = zsrMacosProcessDomain;
  }
  const zsrGitDispatch = resolveZsrGitDispatchBinaryPath();
  if (zsrGitDispatch) {
    extraEnv.ZEROS_ZSR_GIT_DISPATCH_BINARY = zsrGitDispatch;
  }

  // Parent-death watchdog opt-in: the engine self-exits (bounded graceful
  // stop) when THIS Electron process dies without cleanly stopping it —
  // stdin EOF or a ppid change away from this pid (engine/zeros-engine.ts
  // setupParentDeathWatchdog). Only the Electron host sets this; standalone
  // `zeros serve` / cloud runs keep their existing lifecycle.
  extraEnv.ZEROS_PARENT_PID = String(process.pid);
  const { script: ptyHostScript, nodePty: ptyNodePty } = resolvePtyHostPaths();
  if (ptyHostScript) extraEnv.ZEROS_PTY_HOST_SCRIPT = ptyHostScript;
  if (ptyNodePty) extraEnv.ZEROS_PTY_NODE_PTY = ptyNodePty;

  // Cursor SDK host. Same story as the PTY host: @cursor/sdk's agent-run streams
  // over node:http2, which bun can't reliably do against Cursor's backend, so
  // the engine runs the SDK in a Node subprocess (cursor-host.cjs), reusing the
  // PTY host runtime resolved above. Hand it the host script + the @cursor/sdk
  // entry to load.
  const { script: cursorHostScript, sdkEntry: cursorSdkEntry } =
    resolveCursorHostPaths();
  // Explicit env wins: ZEROS_CURSOR_HOST_SCRIPT / ZEROS_CURSOR_SDK_ENTRY are
  // documented override knobs (host-client.ts) — e.g. pointing the host at a
  // stand-in script to exercise the crash-loop guard in dev. The engine spawn
  // merges `{...process.env, ...extraEnv}`, so writing these unconditionally
  // silently clobbered a user-set value.
  if (cursorHostScript && !process.env.ZEROS_CURSOR_HOST_SCRIPT) {
    extraEnv.ZEROS_CURSOR_HOST_SCRIPT = cursorHostScript;
  }
  if (cursorSdkEntry && !process.env.ZEROS_CURSOR_SDK_ENTRY) {
    extraEnv.ZEROS_CURSOR_SDK_ENTRY = cursorSdkEntry;
  }

  // Claude Code CLI. NOT a host script — the SDK runs in-process under bun just
  // fine; what it cannot do is FIND its own executable, because that lives in a
  // platform-specific optional npm dep resolved relative to sdk.mjs and the
  // packaged engine has no node_modules (see resolveClaudeCliPaths). Hand over
  // the staged binary + its version so the engine never depends on module
  // resolution for either. Explicit env wins, same as the Cursor knobs above.
  const claudeCli = resolveClaudeCliPaths();
  if (claudeCli.binary && !process.env.ZEROS_CLAUDE_CLI_PATH) {
    extraEnv.ZEROS_CLAUDE_CLI_PATH = claudeCli.binary;
  }
  if (claudeCli.version && !process.env.ZEROS_CLAUDE_CLI_VERSION) {
    extraEnv.ZEROS_CLAUDE_CLI_VERSION = claudeCli.version;
  }

  // Codex native runtime. Keep the executable, version, and managed package
  // root atomic: an explicit binary override must not inherit metadata from a
  // different staged runtime.
  // Browser Use has a separate OpenAI `cua_node` helper in desktop bundles;
  // expose the resource root so the engine can discover a future staged copy
  // without guessing Electron's installation layout. An explicit developer
  // override remains authoritative.
  if (!process.env.ZEROS_RESOURCES_PATH) {
    extraEnv.ZEROS_RESOURCES_PATH = process.resourcesPath;
  }
  const codexCli = resolveCodexCliPaths();
  if (codexCli.binary && !process.env.ZEROS_CODEX_CLI_PATH) {
    extraEnv.ZEROS_CODEX_CLI_PATH = codexCli.binary;
    if (codexCli.version && !process.env.ZEROS_CODEX_CLI_VERSION) {
      extraEnv.ZEROS_CODEX_CLI_VERSION = codexCli.version;
    }
    if (
      codexCli.managedPackageRoot &&
      !process.env.CODEX_MANAGED_PACKAGE_ROOT
    ) {
      extraEnv.CODEX_MANAGED_PACKAGE_ROOT = codexCli.managedPackageRoot;
    }
  }

  // Account-binding config for the engine. Both code exchange and the engine
  // verifier consume the same selected desktop-auth contract. In WorkOS mode
  // this pins RS256, exact issuer/audience/client, and the complete required
  // application claim set. The engine receives public verification material
  // only; management API keys are scrubbed below.
  Object.assign(
    extraEnv,
    resolveDesktopEngineAuthEnv(desktopAuthConfig(), process.env, IS_DEV),
  );

  // Tell the engine that fd 3 is a private engine→host control pipe (added to
  // `stdio` below). The engine publishes its per-process loopback authority and
  // MCP OAuth-vault persistence messages there — a channel the host never logs
  // (unlike stdout) and the relay never sees. Absent this flag (a standalone /
  // CLI engine), the engine does not touch a stray fd 3.
  extraEnv.ZEROS_CONTROL_FD = "3";

  const child = spawn(
    cmd,
    [
      ...engineArgs,
      "serve",
      "--root",
      projectRoot,
      "--port",
      String(rangeBasePort),
      "--port-start",
      String(requestedPort),
      "--port-span",
      String(portSpan),
    ],
    {
      cwd: projectRoot,
      // [stdin, stdout, stderr, control] — fd 3 is the engine→host control pipe
      // (ZEROS_CONTROL_FD) for local authority and the MCP OAuth vault; the rest
      // are the usual pipes.
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      // process.env is spread first; extraEnv overrides it. The engine is
      // local-only (no relay); only the loopback bridge listens.
      env: stripWorkOSApiKeys({ ...process.env, ...extraEnv }),
      // Make the engine its OWN process-group leader (pgid == pid). WITHOUT this
      // the engine shares Electron-main's group, so killCurrentChild could only
      // signal the single engine pid — and when the engine was SIGKILLed (which
      // the HMR/respawn storm did thousands of times) its forked grandchildren
      // (the Node cursor-host / pty-host, and the pty shells they own) were never
      // signalled and reparented to launchd (ppid=1), leaking memory forever.
      // As a group leader we can `process.kill(-pid, …)` to fell the whole engine
      // subtree atomically (see killCurrentChild / shutdown). We deliberately do
      // NOT child.unref() — the engine stays a tracked child we manage; detached
      // only changes the process group, not the stdio pipes or fd 3.
      detached: process.platform !== "win32",
    },
  );

  // Publish the exact child before attaching fd-3 listeners. The engine emits
  // its authority immediately at start; assigning later risks dropping a
  // legitimate early control message as belonging to no active generation.
  state.child = child;
  state.root = projectRoot;
  state.localToken = null;
  // Wrapping add; JS numbers are safe up to 2^53.
  state.spawnGeneration = (state.spawnGeneration + 1) & 0xffffffff;

  // Forward child stdout/stderr line-by-line through the parent's
  // overridden console.log / console.error so they land in main.log
  // (set up in apps/desktop/electron/main.ts setupLogFile()). Without this every
  // engine `[agents] adapter created`, `[agents] adapterForSession
  // miss`, codex/claude/cursor stderr leak, and AGENT_ERROR breadcrumb
  // vanished into the void in dev — making remote diagnosis blind.
  const forwardLines = (
    stream: NodeJS.ReadableStream | null,
    write: (s: string) => void,
  ) => {
    if (!stream) return;
    // Bound both the partial-line buffer AND downstream log volume. A child
    // that never emits a newline gets one fixed diagnostic for that logical
    // line; the remaining bytes are discarded until its newline arrives.
    const forwarder = createBoundedLineForwarder(write);
    stream.setEncoding?.("utf-8");
    stream.on("data", (chunk: string | Buffer) => {
      forwarder.push(chunk);
    });
    stream.on("end", () => forwarder.end());
  };
  // Strip ANSI escapes before the console sinks: the engine's startup banner
  // and run/setup surfaces emit color codes (apps/desktop/src/cli.ts), and forwarding them
  // verbatim put raw `\x1b[36m` sequences into main.log and the structured
  // app.jsonl store — breaking grep and the "machine-readable" promise both
  // make. The packaged engine.log side-stream below stays RAW on purpose (it
  // is the byte-exact spool for deep-dive parsing).
  // CSI sequences (colors, cursor) + the rare bare two-byte escapes. The
  // control character IS the thing being matched here, hence the lint opt-out.
  // eslint-disable-next-line no-control-regex
  const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  // eslint-disable-next-line no-control-regex
  const ANSI_BARE = /\x1b[@-Z\\-_]/g;
  const stripAnsi = (line: string): string =>
    line.replace(ANSI_CSI, "").replace(ANSI_BARE, "");
  forwardLines(child.stdout, (line) => {
    console.log(`[engine] ${stripAnsi(line)}`);
  });
  forwardLines(child.stderr, (line) => {
    const text = stripAnsi(line);
    const level = classifyEngineStderrLine(text);
    if (level === "log") console.log(`[engine] ${text}`);
    else if (level === "warn") console.warn(`[engine] ${text}`);
    else console.error(`[engine] ${text}`);
  });
  // fd 3 — the engine→host control pipe. It carries the child-minted loopback
  // bearer plus MCP vault persistence. Deliberately never routed to logs.
  forwardLines(
    (child.stdio[3] as unknown as NodeJS.ReadableStream | null) ?? null,
    (line) => {
      const authority = parseEngineLocalAuthorityControl(line);
      if (authority) {
        // Bind the secret to the exact child generation whose pipe delivered
        // it. A stale child racing after replacement cannot overwrite state.
        if (state.child === child) state.localToken = authority;
        return;
      }
      let controlValue: unknown;
      try {
        controlValue = JSON.parse(line) as unknown;
      } catch {
        controlValue = null;
      }
      void handleCloudReplicaEngineControl(controlValue, (responseLine) => {
        if (
          state.child === child &&
          child.stdin &&
          child.stdin.writable &&
          !child.killed
        ) {
          child.stdin.write(responseLine);
        }
      })
        .then((handled) => {
          if (handled) return;
          const snapshot = parseVaultControl(line);
          if (!snapshot) return;
          try {
            setSecret(MCP_VAULT_ACCOUNT, JSON.stringify(snapshot));
          } catch (err) {
            console.warn(
              "[Zeros] MCP vault persist failed:",
              err instanceof Error ? err.message : String(err),
            );
          }
        })
        .catch((error) => {
          console.warn(
            "[Zeros] engine cloud-control handling failed:",
            error instanceof Error ? error.message : String(error),
          );
        });
    },
  );

  if (isPackaged) {
    // Side-stream into a raw engine log for deep-dive parsing — useful
    // when the line-buffered forwarding above can't keep up with bursty
    // codex/claude streams or when inspecting binary blobs. Keep the SAME
    // channel identity as main.log (com.zeros / com.zeros.beta); the old
    // hard-coded `Logs/Zeros` path mixed beta + stable output and sent beta
    // diagnostics to the wrong directory.
    const engineLogDir = path.join(
      os.homedir(),
      "Library",
      "Logs",
      appIdentity(),
    );
    const engineLogPath = path.join(engineLogDir, "engine.log");
    try {
      mkdirSync(engineLogDir, { recursive: true });
      // Match main.log's bounded footprint. Rotate before opening, retain one
      // prior generation for failures that crossed an app restart — and keep
      // rotating MID-SESSION: a respawn storm inside one long-running session
      // used to grow this file without bound because the size check only ran
      // here at open time.
      const MAX_ENGINE_LOG_BYTES = 8 * 1024 * 1024;
      const nodeFs = require("node:fs") as typeof import("node:fs");
      try {
        if (statSync(engineLogPath).size > MAX_ENGINE_LOG_BYTES) {
          renameSync(engineLogPath, `${engineLogPath}.1`);
        }
      } catch {
        /* no prior log (or a harmless rotate race) */
      }
      let logStream = nodeFs.createWriteStream(engineLogPath, { flags: "a" });
      const logSources = [child.stdout, child.stderr].filter(
        (source): source is NonNullable<typeof source> => source != null,
      );
      const backpressure = createSharedBackpressureGate(logSources);
      let writtenBytes = 0;
      try {
        writtenBytes = statSync(engineLogPath).size;
      } catch {
        /* fresh file */
      }
      // Byte-counting writer instead of a raw pipe so the size cap holds while
      // the stream is live. Volume is line-buffered engine chatter — the write
      // path is not a throughput concern, and a swallowed write on a rotate
      // race is acceptable for a diagnostic spool.
      const writeRotating = (chunk: string | Buffer) => {
        writtenBytes += Buffer.isBuffer(chunk)
          ? chunk.byteLength
          : Buffer.byteLength(chunk, "utf8");
        backpressure.write(logStream, chunk);
        if (writtenBytes > MAX_ENGINE_LOG_BYTES) {
          writtenBytes = 0;
          // Order matters: end() flushes to the OLD inode via its fd, so the
          // rename must happen before a new stream re-creates the path —
          // otherwise the fresh stream would open the same inode and follow
          // it into `.1`, defeating the rotation.
          logStream.end();
          try {
            renameSync(engineLogPath, `${engineLogPath}.1`);
          } catch {
            /* rotate race — keep appending to the same file */
          }
          logStream = nodeFs.createWriteStream(engineLogPath, { flags: "a" });
        }
      };
      child.stdout?.on("data", writeRotating);
      child.stderr?.on("data", writeRotating);
      // `close` follows stdout/stderr closure; `exit` can fire while buffered
      // pipe data is still arriving and would end the sink too early.
      child.once("close", () => {
        backpressure.dispose();
        try {
          logStream.end();
        } catch {
          /* already closed */
        }
      });
    } catch {
      /* unable to create log stream — main.log forwarding still works */
    }
  }

  // Seed GitHub credentials over the private parent→child pipe. Keeping this
  // out of the spawn environment prevents the engine's terminal and agent
  // subprocesses from inheriting a durable credential.
  void pushGithubCredentialToEngine();

  // Seed only the short-lived WorkOS bearer and public device identity. The
  // Ed25519 private key remains in Electron safeStorage; signing requests make
  // the reverse trip over fd 3 and return over this same stdin pipe.
  seedCloudReplicaSessionToEngineIfEnabled({
    push: pushCloudReplicaSessionToEngine,
  });

  // Seed the engine's OAuth token vault from the durable store (safeStorage) so
  // the MCP gateway restores its sign-ins without re-auth. Pushed on stdin
  // (buffered until the engine reads it), NOT env — an env blob would be inherited
  // by every agent subprocess the engine spawns.
  pushMcpVaultToEngine();

  child.once("exit", (code, signal) => {
    // Only clear the child reference if this is still the active one
    // (a newer spawn may have already replaced it). CRITICAL: do NOT
    // clear `state.port` OR `state.instance` here — the watchdog needs the
    // owned identity to stay set so its health probe can fail, accumulate
    // strikes, and trigger a respawn. Clearing either on exit would make the
    // watchdog treat a dead engine as "nothing to monitor" and skip respawn.
    if (state.child === child) {
      state.child = null;
    }
    console.log(`[Zeros] engine exited code=${code} signal=${signal ?? ""}`);
    // Report genuine engine crashes to the renderer for PostHog error
    // tracking. Filter out deliberate kills: app shutdown (shuttingDown)
    // and SIGTERM/SIGKILL (our own restart/teardown). Only a non-zero
    // exit code or a hard fault signal counts as a crash. Metadata only.
    const hardSignal =
      !!signal &&
      ["SIGSEGV", "SIGABRT", "SIGBUS", "SIGILL", "SIGFPE"].includes(signal);
    if (
      !state.shuttingDown &&
      ((typeof code === "number" && code !== 0) || hardSignal)
    ) {
      emitEvent("engine-crash", { code: code ?? null, signal: signal ?? null });
    }
  });

  const startupBeganAt = Date.now();
  while (true) {
    const waitDecision = engineStartupWaitDecision({
      elapsedMs: Date.now() - startupBeganAt,
      childExited: child.exitCode !== null || child.signalCode !== null,
    });
    if (waitDecision === "child-exited") {
      throw new Error(
        `engine child exited before binding ` +
          `(code=${child.exitCode ?? "none"}, signal=${child.signalCode ?? "none"})`,
      );
    }
    if (waitDecision === "timed-out") {
      // A child that binds just after its supervisor gives up must not race the
      // next generation for the manifest or a channel-owned port.
      await killCurrentChild();
      throw new Error(
        `engine did not bind within ${ENGINE_STARTUP_TIMEOUT_MS / 60_000} minutes`,
      );
    }
    let manifest: ReturnType<typeof parseOwnedEngineManifest> = null;
    try {
      const raw = readFileSync(manifestFile, "utf-8");
      manifest = parseOwnedEngineManifest(
        JSON.parse(raw) as unknown,
        child.pid,
      );
    } catch {
      /* port file not written yet; keep polling */
    }
    // Two app instances serving the same repo (dogfooding: a second dev build
    // pointed at the same project) share this manifest path — same data dir,
    // same repoKey — and their engines race to write it, last writer wins.
    // Adopting the port blindly can point THIS app at the OTHER instance's
    // engine, whose /ws token differs → the socket upgrade is rejected and
    // every request dies as "Request timeout: WORKSPACE_REQUEST". Only accept
    // a manifest written by the child we just spawned.
    if (manifest && state.localToken) {
      const rangeEnd = requestedPort + portSpan - 1;
      if (manifest.port < requestedPort || manifest.port > rangeEnd) {
        console.error(
          `[Zeros] engine child ${child.pid ?? "unknown"} published out-of-range port ` +
            `${manifest.port}; expected ${requestedPort}-${rangeEnd}`,
        );
        await killCurrentChild();
        throw new EngineHealthUnreachableError(manifest.port);
      }
      const reachable = await confirmSpawnReachable(
        manifest.port,
        state.spawnGeneration,
        manifest.instance,
      );
      if (!reachable) {
        await killCurrentChild();
        throw new EngineHealthUnreachableError(manifest.port);
      }
      // Publish port + identity atomically only after the independent host
      // proved this exact child can answer. ensureEngineRunning/currentPort
      // can never expose a manifest-only listener to the renderer.
      state.instance = manifest.instance;
      state.port = manifest.port;
      console.log(
        `[Zeros] engine ready and externally verified on port ${manifest.port}`,
      );
      return manifest.port;
    }
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

/** Idempotent engine shutdown. Flips the shutting-down flag so the
 *  watchdog stops respawning. Called from app.on("before-quit"). */
export function shutdown(): void {
  state.shuttingDown = true;
  if (state.watchdogTimer) {
    clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
  }
  const child = state.child;
  if (child && !child.killed) {
    // Group SIGTERM: the engine is now a detached group leader, so it no longer
    // dies automatically when Electron main exits — we must fell the whole tree
    // (engine + cursor/pty hosts) or it orphans. SIGTERM lets the engine run its
    // 3s-capped clean stop() and the hosts reap their detached agent groups; a
    // stranded leftover is caught by reapOrphanEngines() on the next cold start.
    signalEngineTree(child, child.pid, "SIGTERM");
    console.log("[Zeros] engine stopped");
  }
  state.child = null;
  state.port = null;
  state.instance = null;
  state.localToken = null;
  state.root = null;
}

export function currentLocalToken(): string {
  if (!state.localToken) {
    throw new Error("engine launch authority is not ready");
  }
  return state.localToken;
}

/** Courier the selected GitHub credential to the running engine over stdin —
 *  a trusted parent→child channel the renderer can't observe. Call after any
 *  connect / disconnect / method change. Refresh tokens stay in main. */
export async function pushGithubCredentialToEngine(): Promise<void> {
  const child = state.child;
  if (!child || child.killed || !child.stdin || !child.stdin.writable) return;
  let credential: Awaited<
    ReturnType<typeof githubCredentialStore.getSelectedCredential>
  > = null;
  let selectedMethod = "gh-cli";
  try {
    selectedMethod = await githubCredentialStore.getSelectedMethod();
    credential = await githubCredentialStore.getSelectedCredential();
  } catch {
    credential = null;
  }
  const engineCredential = githubCredentialForEngine(
    credential,
    getProductAccountIdForMain(),
  );
  try {
    child.stdin.write(
      `${JSON.stringify({
        type: "host.githubCredential",
        method: selectedMethod,
        credential: engineCredential,
      })}\n`,
    );
  } catch {
    /* engine exiting — the next spawn re-seeds over stdin */
  }
}

/** Refresh/clear the engine's in-memory cloud-replica session over the private
 * parent pipe. Never place this bearer in argv, env, renderer IPC, or logs. */
export async function pushCloudReplicaSessionToEngine(): Promise<void> {
  if (!cloudWorkspaceDesktopCapabilityEnabled()) return;
  const child = state.child;
  if (!child || child.killed || !child.stdin || !child.stdin.writable) return;
  let line: string;
  try {
    line = await cloudReplicaSessionControlLine();
  } catch {
    line = `${JSON.stringify({
      type: "host.cloudReplicaSession",
      session: null,
    })}\n`;
  }
  if (state.child !== child || child.killed || !child.stdin.writable) return;
  try {
    child.stdin.write(line);
  } catch {
    /* engine exiting — the next spawn re-seeds over stdin */
  }
}

/** Seed the engine's MCP OAuth token vault from the durable store (safeStorage)
 *  over stdin — the engine mints/refreshes these tokens but can't persist them
 *  itself, so the host restores them on (re)spawn. Stdin (not env) keeps the token
 *  blob out of agent subprocess environments; the engine→host persist direction
 *  rides the control fd (see spawnEngine). No-op if the engine isn't running or
 *  the store is empty. */
export function pushMcpVaultToEngine(): void {
  const child = state.child;
  if (!child || child.killed || !child.stdin || !child.stdin.writable) return;
  let snapshot: ReturnType<typeof parseVaultBlob> = null;
  try {
    snapshot = parseVaultBlob(getSecret(MCP_VAULT_ACCOUNT));
  } catch {
    return; // keychain unavailable — engine starts empty, user re-authenticates
  }
  if (!snapshot) return;
  try {
    child.stdin.write(vaultSeedLine(snapshot));
  } catch {
    /* engine exiting — the next spawn re-seeds */
  }
}

export function currentPort(): number | null {
  return state.port;
}

export function currentRoot(): string | null {
  return state.root;
}

/** Dev-only: watch engine TypeScript sources and respawn the running
 *  engine when any of them change. No-op in packaged builds.
 *
 *  Why we now respawn directly instead of only SIGTERM'ing:
 *  the previous version sent SIGTERM and left the actual respawn to
 *  the watchdog. That worked, but the watchdog needs FAIL_THRESHOLD=5
 *  consecutive unreachable probes at POLL_INTERVAL_MS=3000 to act —
 *  ~15 s on the best day, and far longer when the engine's event
 *  loop is briefly stuck and ignores SIGTERM (we've seen 2+ minute
 *  gaps in main.log between "engine source changed" and the watchdog
 *  actually noticing). During that window every renderer surface
 *  that depends on the bridge — chat dropdown, agents panel,
 *  providers panel — sits on "Engine connecting…" / "Loading
 *  agents…", which looks like a hang every time the user saves a
 *  file in apps/desktop/src/engine/**.
 *
 *  killCurrentChild() inside spawnEngine() already does
 *  SIGTERM → 5 s wait → SIGKILL escalation, so the worst case here
 *  is ~5-6 s instead of 15-120 s.
 *
 *  Coalescing strategy (2026-05-28 audit):
 *  In a real dev session a single user-visible action (git
 *  checkout, branch switch, a checkpoint restore, `pnpm
 *  install`, even a multi-write editor save) can drop dozens of
 *  events on apps/desktop/src/engine/** within a few hundred ms. The previous
 *  250ms debounce caught the inside-burst events, but the 5-second
 *  SIGTERM grace meant each respawn took ~5s end-to-end; a second
 *  burst arriving after the first respawn started would queue
 *  another full respawn back-to-back. Audit log showed 175 respawns
 *  in one hour, ~30 of them inside 30s windows.
 *
 *  Three guards now layer on top of the debounce:
 *    1. POST_RESPAWN_COOLDOWN_MS  — after a respawn lands, ignore
 *       further events for N ms; tsup-watch and similar tools
 *       finish writing within that window.
 *    2. BURST_WINDOW_MS / BURST_THRESHOLD — when many events arrive
 *       in a short window (git checkout territory), extend the
 *       debounce so we only fire ONCE per burst rather than chaining
 *       a respawn per write.
 *    3. shouldIgnoreEventPath — drop noise from generated dirs,
 *       JetBrains/VSCode atomic-save tmp files, and .DS_Store. */
export function startEngineCodeWatcher(): void {
  if (IS_PACKAGED) return;
  // Escape hatch for "develop in one place, TEST in another" setups
  // (e.g. a file-sync tool mirroring an active worktree's edits into the
  // checkout you're running): set ZEROS_NO_ENGINE_HMR=1 to disable
  // engine hot-reload entirely, so incoming source changes never respawn
  // the engine mid-turn (which silently drops the live stream — the
  // renderer disconnects and only sees the persisted result on reopen). The
  // crash watchdog still runs, so a genuinely dead engine still recovers;
  // you just pick up code changes on the next manual restart instead.
  if (process.env.ZEROS_NO_ENGINE_HMR === "1") {
    console.log(
      "[Zeros] engine HMR watcher disabled (ZEROS_NO_ENGINE_HMR=1) — " +
        "source changes will NOT respawn the engine; restart manually to apply.",
    );
    return;
  }
  const repoRoot = path.resolve(__dirname, "..");
  const cliSrc = path.join(repoRoot, "apps", "desktop", "src", "cli.ts");
  const engineDir = path.join(repoRoot, "apps", "desktop", "src", "engine");

  // `recursive: true` is supported on macOS + Windows (not Linux, but
  // we're macOS-only). Gives us events for every nested file in
  // apps/desktop/src/engine/** with a single watcher.
  let watchers: Array<import("node:fs").FSWatcher> = [];

  // Single-flight guard. Bursts of file events are coalesced by the
  // 250ms debounce below, but a slow respawn could still overlap with
  // a follow-up change (e.g. user keeps editing while bun is starting
  // the new engine). Without this guard the second triggerRespawn
  // call would race spawnEngine's killCurrentChild, leak an orphan,
  // and reaped-orphans flooded the log.
  let respawning = false;

  // Timestamp (ms) of the last successful respawn completion. Used by
  // the cooldown guard so burst-driven follow-up writes (tsup writing
  // dist-engine after we already respawned, secondary saves from an
  // editor's "auto-format + save" chain) don't queue ANOTHER respawn.
  let lastRespawnFinishedAt = 0;
  const POST_RESPAWN_COOLDOWN_MS = 2000;

  // Circuit-breaker — the hard ceiling the 15,311-respawn storm never had. The
  // debounce/cooldown/burst guards throttle bursts but cap NOTHING over time: a
  // steady ~2s phantom cadence slips every one of them and respawns forever. If
  // we complete more than RESPAWN_CAP respawns within RESPAWN_WINDOW_MS we TRIP:
  // close the watchers, stop respawning until the app restarts, log once, and
  // tell the renderer. Worst case is now RESPAWN_CAP respawns, not thousands.
  // Paired with the content-hash guard above this should only fire in a
  // genuinely pathological environment.
  const RESPAWN_CAP = 12;
  const RESPAWN_WINDOW_MS = 5 * 60_000;
  let respawnHistory: number[] = [];
  let hmrTripped = false;

  // HMR-safe hot reload: defer respawning while the engine is mid-turn so a
  // save doesn't kill the in-flight agent response (the "Agent is responding…
  // forever / no reply" symptom). The engine writes `<root>/.zeros/.busy`
  // (heartbeated every 10s, see ZerosEngine.enterPrompt) while any
  // AGENT_PROMPT is active; we re-check on a short poll until it clears. Two
  // caps keep hot-reload from ever wedging: a marker older than
  // BUSY_STALE_MS is treated as a crashed engine (ignored), and we force the
  // respawn after BUSY_MAX_DEFER_MS regardless.
  const BUSY_STALE_MS = 30_000;
  const BUSY_POLL_MS = 1500;
  const BUSY_MAX_DEFER_MS = 5 * 60_000;
  let respawnDeferredSince = 0;
  const engineBusy = (root: string): boolean => {
    try {
      const st = statSync(path.join(engineRuntimeDir(root), "busy"));
      return Date.now() - st.mtimeMs < BUSY_STALE_MS;
    } catch {
      return false; // no marker → idle
    }
  };

  // Burst detection: when >= BURST_THRESHOLD events arrive within
  // BURST_WINDOW_MS we treat the run as a "checkout-class" burst
  // and extend the debounce so we coalesce the entire operation
  // into a single respawn instead of chaining several.
  const BURST_WINDOW_MS = 800;
  const BURST_THRESHOLD = 4;
  const DEBOUNCE_NORMAL_MS = 500;
  const DEBOUNCE_BURST_MS = 1500;
  let recentEventTimestamps: number[] = [];

  const isBurst = (): boolean => {
    const now = Date.now();
    recentEventTimestamps = recentEventTimestamps.filter(
      (t) => now - t < BURST_WINDOW_MS,
    );
    return recentEventTimestamps.length >= BURST_THRESHOLD;
  };

  // Filter for events we never care about even when chokidar/fs.watch
  // surfaces them. Atomic-save backup files (.swp, ~), Finder
  // metadata, and anything inside generated dirs nested under src/.
  const shouldIgnoreEventPath = (filename: string | null): boolean => {
    if (!filename) return false;
    const base = filename.includes("/")
      ? filename.slice(filename.lastIndexOf("/") + 1)
      : filename;
    // Editor atomic-save / swap / lock detritus + OS metadata. We do NOT
    // blanket-ignore every dotfile (the old `startsWith(".")` was too
    // blunt) — a future engine dotfile config (e.g. a `.zerosrc` or
    // `.env` under apps/desktop/src/engine) must still trigger a respawn.
    if (base === ".DS_Store") return true;
    if (base.endsWith("~")) return true; // backup files
    if (/\.sw[a-p]$/.test(base)) return true; // vim swap (.swp/.swo/.swn…)
    if (base.endsWith(".tmp")) return true; // generic atomic-save temp
    if (base.startsWith(".#")) return true; // emacs lock symlink
    // tsup --watch sometimes writes a stamp next to its config
    // resolution; that's harmless.
    if (filename.includes("__generated__")) return true;
    return false;
  };

  const triggerRespawn = async () => {
    if (respawning) return;
    if (hmrTripped) return; // breaker open — HMR auto-disabled until restart
    const root = state.root;
    if (!root) return;
    if (state.shuttingDown) return;

    // Post-respawn cooldown — silently drop the trigger if we
    // respawned very recently. The fired event is almost always a
    // late echo of the previous batch (tsup completing its write,
    // node-fs delivering a buffered macOS FSEvent). Letting it
    // through would respawn the still-warm new engine for nothing.
    const sinceLast = Date.now() - lastRespawnFinishedAt;
    if (lastRespawnFinishedAt > 0 && sinceLast < POST_RESPAWN_COOLDOWN_MS) {
      return;
    }

    // Defer while an agent turn is in flight (see engineBusy), so a save
    // mid-turn doesn't SIGTERM the engine out from under the running
    // response. Re-check on a short poll; force the respawn once the cap is
    // hit so a runaway/hung turn can't block hot-reload forever.
    if (engineBusy(root)) {
      if (respawnDeferredSince === 0) {
        respawnDeferredSince = Date.now();
        console.log(
          "[Zeros] engine source changed — deferring respawn until the active agent turn finishes",
        );
      }
      if (Date.now() - respawnDeferredSince < BUSY_MAX_DEFER_MS) {
        setTimeout(() => {
          void triggerRespawn().catch((error: unknown) => {
            console.warn(
              `[Zeros] deferred engine respawn failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }, BUSY_POLL_MS);
        return;
      }
      console.warn(
        "[Zeros] agent turn still active after max defer — respawning anyway",
      );
    }
    respawnDeferredSince = 0;

    respawning = true;
    try {
      console.log("[Zeros] engine source changed — respawning");
      const newPort = await spawnEngine(root);
      console.log(`[Zeros] engine respawned on port ${newPort} (HMR)`);
      // Notify the renderer so ws-client.ts drops its cached port,
      // re-resolves via native IPC, and reconnects. Without this the
      // browser would still be pointed at the previous engine's
      // socket (now closed) and stay on "Engine connecting…" until
      // a manual reload.
      emitEvent("engine-restarted", newPort);
      // Belt-and-suspenders: same cleanup the watchdog runs after
      // its own respawns. Catches the rare case where bun forked a
      // grandchild that's still holding a port in this channel's
      // engine range.
      // range. Skips the freshly-spawned engine's own PID.
      await reapOrphanEngines(state.child?.pid);
    } catch (err) {
      console.error(
        `[Zeros] engine respawn failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      respawning = false;
      lastRespawnFinishedAt = Date.now();
      // Circuit-breaker bookkeeping: record this respawn, prune the window, and
      // trip if the cap is exceeded so a pathological churn source can't respawn
      // without bound.
      respawnHistory.push(lastRespawnFinishedAt);
      respawnHistory = respawnHistory.filter(
        (t) => lastRespawnFinishedAt - t < RESPAWN_WINDOW_MS,
      );
      if (respawnHistory.length > RESPAWN_CAP && !hmrTripped) {
        hmrTripped = true;
        console.warn(
          `[Zeros] engine HMR auto-disabled: ${respawnHistory.length} respawns in ` +
            `${Math.round(RESPAWN_WINDOW_MS / 60_000)}min exceeds the cap (${RESPAWN_CAP}). ` +
            `Source changes will NOT respawn the engine until you restart the app — ` +
            `this is almost always FSEvents / remote-sync churn, not your edits. ` +
            `Set ZEROS_NO_ENGINE_HMR=1 to disable HMR permanently for this instance.`,
        );
        for (const w of watchers) {
          try {
            w.close();
          } catch {
            /* best-effort */
          }
        }
        watchers = [];
        emitEvent("engine-hmr-disabled", {
          respawns: respawnHistory.length,
          windowMs: RESPAWN_WINDOW_MS,
        });
      }
    }
  };

  try {
    const { watch } = require("node:fs") as typeof import("node:fs");
    // Coalesce bursts of events (editors save in multiple writes,
    // tsup --watch writes dist-engine in a few stages, git checkout
    // dropping 30+ files, etc.).
    let scheduled: NodeJS.Timeout | null = null;

    // ── Phantom-event guard (content-aware) ──────────────────
    // macOS fs.watch (FSEvents) fires "change" for METADATA-only mutations —
    // atime, xattr, Spotlight (`mds`) indexing — AND, the case that actually
    // drove the storm here, for mtime bumps with BYTE-IDENTICAL content:
    // file-sync tools mirror files (rewriting mtime), `git
    // checkout`/stash restore identical bytes, and editors' atomic save
    // (write-temp → rename over the original) all move mtime while the source is
    // unchanged. The old guard compared only `${mtimeMs}:${size}`, so every such
    // touch read as a "real" edit and respawned the engine — the 15,311-respawn
    // storm. We now compare a CONTENT HASH: mtime+size is a cheap fast-path
    // (unchanged → definitely no respawn), and only when they move do we hash the
    // file and respawn iff the bytes actually differ. A stat/read miss
    // (delete/rename/unreadable) counts as a real change so we never swallow one.
    interface FileSig {
      mtimeMs: number;
      size: number;
      hash: string;
    }
    const fileSig = new Map<string, FileSig>();
    // Only source files can drive an engine rebuild; anything else (binaries,
    // huge blobs) is given an empty hash so it degrades to the old mtime/size
    // verdict without slurping a large file into memory on every event.
    const HASHABLE = /\.(ts|tsx|cts|mts|cjs|mjs|js|json)$/;
    const MAX_HASH_BYTES = 4 * 1024 * 1024;
    const sigOf = (abs: string): FileSig | null => {
      // Open ONCE and derive both the stat and the content hash from the same
      // file descriptor. Doing path-based statSync(abs) then readFileSync(abs)
      // is a TOCTOU race: the path could be re-pointed (rename / swapped
      // symlink) between the check and the read, so the mtime/size and the
      // hashed bytes would describe different inodes. The fd pins the exact
      // inode we stat'd for the read too.
      let fd: number | null = null;
      try {
        fd = openSync(abs, "r");
        const st = fstatSync(fd);
        if (!HASHABLE.test(abs) || st.size > MAX_HASH_BYTES) {
          return { mtimeMs: st.mtimeMs, size: st.size, hash: "" };
        }
        const hash = createHash("sha1").update(readFileSync(fd)).digest("hex");
        return { mtimeMs: st.mtimeMs, size: st.size, hash };
      } catch {
        return null;
      } finally {
        // readFileSync(fd) does NOT close the descriptor — do it ourselves.
        if (fd !== null) closeSync(fd);
      }
    };
    const isRealChange = (abs: string): boolean => {
      const sig = sigOf(abs);
      if (sig === null) {
        fileSig.delete(abs);
        return true; // deleted / renamed / unreadable → real change (fail-open)
      }
      const prev = fileSig.get(abs);
      fileSig.set(abs, sig);
      if (!prev) return true; // first sight → real
      // Fast path: mtime+size unchanged → no content change, no respawn.
      if (prev.mtimeMs === sig.mtimeMs && prev.size === sig.size) return false;
      // mtime/size moved: respawn only if the CONTENT hash actually differs.
      // An empty hash (unhashable file) has no content to compare, so fall back
      // to the mtime/size verdict — which already differs here → treat as real.
      if (sig.hash === "" || prev.hash === "") return true;
      return prev.hash !== sig.hash;
    };
    // Seed the entry file's baseline so its first (usually phantom) event
    // compares against the real on-disk state instead of respawning once.
    const cliSig = sigOf(cliSrc);
    if (cliSig !== null) fileSig.set(cliSrc, cliSig);

    const onEvent = (base: string, filename: string | Buffer | null) => {
      const name =
        typeof filename === "string"
          ? filename
          : filename instanceof Buffer
            ? filename.toString("utf-8")
            : null;
      if (shouldIgnoreEventPath(name)) return;
      // Pin the concrete file the event is about: the cli.ts watcher always
      // means cliSrc; the recursive engineDir watcher carries a relative name.
      const abs =
        base === cliSrc ? cliSrc : name ? path.join(engineDir, name) : null;
      // Drop metadata-only (phantom) events AND unverifiable ones. Previously a
      // null `abs` (macOS omits the filename for some recursive FSEvents — and
      // Spotlight/remote-sync bulk touches are exactly those) short-circuited
      // the guard and fell straight through to a respawn. Since a genuine edit
      // almost always ALSO arrives as a named event on the same file (tsup and
      // every editor deliver a concrete relative name), dropping the unnamed
      // ones closes a direct phantom→respawn path without losing real reloads.
      if (!abs || !isRealChange(abs)) return;
      recentEventTimestamps.push(Date.now());
      const wait = isBurst() ? DEBOUNCE_BURST_MS : DEBOUNCE_NORMAL_MS;
      if (scheduled) clearTimeout(scheduled);
      scheduled = setTimeout(() => {
        void triggerRespawn().catch((error: unknown) => {
          console.warn(
            `[Zeros] debounced engine respawn failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }, wait);
    };
    if (existsSync(cliSrc)) {
      watchers.push(watch(cliSrc, (_e, fn) => onEvent(cliSrc, fn)));
    }
    if (existsSync(engineDir)) {
      watchers.push(
        watch(engineDir, { recursive: true }, (_e, fn) =>
          onEvent(engineDir, fn),
        ),
      );
    }
  } catch (err) {
    console.warn(
      `[Zeros] engine source watcher setup failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  app.on("before-quit", () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* best-effort */
      }
    }
    watchers = [];
  });
}

/** Starts an application-level heartbeat against the engine every 3 s.
 *  Five consecutive failed `/health` probes (~15 s) trigger a respawn and emit
 *  `engine-restarted { port: <new> }` so the renderer reconnects. */
export function startWatchdog(): void {
  if (state.watchdogTimer) return; // already running; idempotent

  // Threshold bumped from 3 → 5 to tolerate transient stalls during
  // heavy file activity. A real engine death still triggers a
  // respawn within ~15s (5 × 3s poll); a brief stall during a
  // commit/checkout doesn't.
  const FAIL_THRESHOLD = 5;
  const POLL_INTERVAL_MS = 3000;
  let fails = 0;
  // Consecutive respawns without ONE successful probe in between. A healthy
  // respawn recovers within a probe or two; several zero-contact cycles in a
  // row means respawning isn't the cure (beta.82: a stale listener black-holed
  // the port, and the loop ran silently every ~21s) — say so, with evidence.
  let respawnsWithoutContact = 0;
  // Exponential hold-off between zero-contact respawns — the cap the ~21s
  // kill/respawn loop never had. A 0.0.13 field log showed the watchdog
  // SIGKILLing and relaunching a "ready" engine every cycle for 13+ hours:
  // when respawning has already failed to restore contact N times in a row,
  // the (N+1)th attempt this second is not going to be the one that works,
  // and each attempt costs a SIGKILL, a full engine boot, an lsof/ps reap
  // sweep, and a burst of log output. Double the wait after every
  // zero-contact respawn (first retry stays immediate), capped at 5 minutes,
  // and reset the moment ANY probe succeeds. Recovery for a genuinely dead
  // engine is unchanged — that path succeeds on its first respawn.
  const RESPAWN_BACKOFF_CAP_MS = 5 * 60_000;
  let nextRespawnAllowedAt = 0;

  state.watchdogTimer = setInterval(() => {
    void (async () => {
      if (state.shuttingDown) return;

      const port = state.port;
      const instance = state.instance;
      if (port === null || instance === null) {
        // No owned manifest — never spawned successfully, or a respawn is
        // mid-flight. Nothing to monitor. Port and instance are published
        // together after parseOwnedEngineManifest accepts our exact child.
        fails = 0;
        return;
      }

      if (await engineResponsive(port, instance)) {
        fails = 0;
        respawnsWithoutContact = 0;
        nextRespawnAllowedAt = 0;
        return;
      }

      fails += 1;
      if (fails < FAIL_THRESHOLD) return;

      const root = state.root;
      if (!root) {
        fails = 0;
        return;
      }

      if (Date.now() < nextRespawnAllowedAt) {
        // Hold-off window from a previous zero-contact respawn — keep probing
        // (a recovered engine resets everything above) but don't kill/relaunch
        // yet. Cap `fails` so the counter can't run away while we wait.
        fails = FAIL_THRESHOLD;
        return;
      }

      console.error(
        `[Zeros] engine unreachable on port ${port} after ${FAIL_THRESHOLD} probes; respawning`,
      );
      fails = 0;
      respawnsWithoutContact += 1;
      if (respawnsWithoutContact >= 2) {
        const backoffMs = zeroContactRespawnBackoffMs(respawnsWithoutContact, {
          probeWindowMs: POLL_INTERVAL_MS * FAIL_THRESHOLD,
          capMs: RESPAWN_BACKOFF_CAP_MS,
        });
        nextRespawnAllowedAt = Date.now() + backoffMs;
        // The lsof evidence dump is throttled to the first few zero-contact
        // cycles: it was logged on EVERY cycle, and during a storm the repeated
        // multi-line listener tables were a major main.log flooder.
        if (respawnsWithoutContact <= 3) {
          console.error(
            `[Zeros] ${respawnsWithoutContact} watchdog respawns in a row with zero successful probes — ` +
              `respawning is not recovering this; a stale process may be black-holing the port. ` +
              `Next attempt in ${Math.round(backoffMs / 1000)}s. ` +
              `Listeners on ${currentEnginePortRange()}:\n` +
              (await describeRangeListeners()),
          );
        } else {
          console.error(
            `[Zeros] watchdog zero-contact respawn #${respawnsWithoutContact}; ` +
              `backing off ${Math.round(backoffMs / 1000)}s before the next attempt`,
          );
        }
      }

      try {
        const newPort = await spawnEngine(root);
        console.log(`[Zeros] watchdog respawned engine on port ${newPort}`);
        emitEvent("engine-restarted", newPort);
        // Belt-and-suspenders cleanup: even with killCurrentChild now
        // doing SIGTERM→SIGKILL escalation, edge cases (a freshly-
        // spawned child crashing before we got its handle, an engine
        // that fork-exec'd a stuck subprocess on its port) can still
        // leave a listener stranded in this channel's range. Reaping
        // after every respawn — not just cold start — catches those.
        // Skips the current `state.child` PID via lsof's process
        // matching (the new engine is `bun apps/desktop/src/cli.ts` or the prod
        // binary; both match the engine-pattern but we filter by PID
        // below).
        await reapOrphanEngines(state.child?.pid);
      } catch (err) {
        console.error(
          `[Zeros] watchdog respawn failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })().catch((error: unknown) => {
      console.error(
        `[Zeros] watchdog timer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, POLL_INTERVAL_MS);
}

// ──────────────────────────────────────────────────────────
// Initial project root resolution
// ──────────────────────────────────────────────────────────
//
// The engine's file watcher indexes every file under its root. That's
// fine for a user repo (~thousands of files) but catastrophic for
// $HOME (~millions) or / (entire filesystem). When the watcher exceeds
// macOS's EMFILE ceiling the engine crashes on every fs event and the
// IPC bridge stalls indefinitely — the exact "Fetching agent registry..."
// hang users hit when the packaged app is launched from Finder (CWD=/)
// or from a shell where the cwd isn't a real project.
//
// Strategy: refuse to root at anything that doesn't look like a user
// project. Use a dedicated empty sentinel at
//   ~/.zeros/default-project/
// The user then opens their real project via File → Open Folder,
// which respawns the engine rooted there.

const SENTINEL_DIR_NAME = "default-project";

function sentinelRoot(): string {
  // Dev-aware dot-dir so a dev run's sentinel lands in ~/.zeros-dev, not the
  // production ~/.zeros (zerosStateRoot honors HOME via os.homedir()).
  const dir = path.join(zerosStateRoot(), SENTINEL_DIR_NAME);
  try {
    if (!existsSync(dir)) {
      require("node:fs").mkdirSync(dir, { recursive: true });
    }
  } catch {
    /* falls back to the unwritable path — spawn surfaces the error */
  }
  return dir;
}

/** A directory is a "plausible project" when it has a .git, a
 *  package.json, or an existing .zeros subdir. Anything else is
 *  treated as "not a project" and redirected to the sentinel. */
export function isPlausibleProject(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return (
    existsSync(path.join(dir, ".git")) ||
    existsSync(path.join(dir, "package.json")) ||
    existsSync(path.join(dir, ".zeros")) ||
    existsSync(path.join(dir, "pyproject.toml")) ||
    existsSync(path.join(dir, "Cargo.toml")) ||
    existsSync(path.join(dir, "go.mod"))
  );
}

/** Bail-out directories we KNOW aren't projects even if they happen
 *  to contain a git/package.json accidentally. $HOME, /, system dirs. */
export function isSystemDir(dir: string): boolean {
  if (!dir) return true;
  const home = process.env.HOME;
  if (home && path.resolve(dir) === path.resolve(home)) return true;
  // Any of the Unix system root dirs (/tmp, /private/tmp, /var, /etc,
  // /usr, /bin, /Applications, /Library, etc.) or the filesystem
  // root itself. Match by leading segment rather than a hardcoded
  // list so new macOS volumes don't slip through.
  if (
    /^\/(?:private\/)?(?:tmp|var|etc|usr|bin|sbin|opt|System|Library|Volumes|Applications|Network|cores|dev)(?:\/|$)/.test(
      dir,
    )
  ) {
    return true;
  }
  return dir === "/" || dir.includes(".app/Contents/");
}

export function defaultProjectRoot(): string {
  const cwd = process.cwd();

  // Legacy dev-tree tolerance (harmless to keep).
  if (path.basename(cwd) === "src-tauri") {
    return path.dirname(cwd);
  }

  // Is the CWD actually a user project we can safely index?
  if (!isSystemDir(cwd) && isPlausibleProject(cwd)) {
    return cwd;
  }

  // Otherwise: sentinel. The user picks a real project next.
  return sentinelRoot();
}

/** Validate a path exists and is a directory before we spawn into it.
 *  Used by open_project_folder_path / open_cloned_project so the UI
 *  gets a clear error for stale recent-projects entries. */
export function assertIsDirectory(p: string): void {
  if (!existsSync(p)) {
    throw new Error(`folder does not exist: ${p}`);
  }
  if (!statSync(p).isDirectory()) {
    throw new Error(`not a directory: ${p}`);
  }
}

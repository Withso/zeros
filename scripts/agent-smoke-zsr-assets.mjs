import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ZSR_ASSETS = {
  ZEROS_ZSR_SUPERVISOR_SCRIPT: "zsr-supervisor.mjs",
  ZEROS_ZSR_NETWORK_BRIDGE_SCRIPT: "zsr-network-bridge.mjs",
  ZEROS_ZSR_CONTAINER_WORKER_SCRIPT: "zsr-container-worker.mjs",
  ZEROS_ZSR_ORBSTACK_CONTAINER_HOST_SCRIPT:
    "zsr-orbstack-container-host.mjs",
  ZEROS_ZSR_ORBSTACK_CLOUD_INIT: "zsr-orbstack-cloud-init.yaml",
  ZEROS_ZSR_MACOS_PROCESS_DOMAIN_HELPER: "zsr-macos-process-domain",
  ZEROS_ZSR_MACOS_PORT_BIND_LIBRARY: "zsr-macos-port-bind.dylib",
};

const DARWIN_ONLY_ASSETS = new Set([
  "ZEROS_ZSR_MACOS_PROCESS_DOMAIN_HELPER",
  "ZEROS_ZSR_MACOS_PORT_BIND_LIBRARY",
]);

const moduleRequire = createRequire(import.meta.url);

function defaultModuleResolver(specifier, anchor) {
  return anchor
    ? createRequire(anchor).resolve(specifier)
    : moduleRequire.resolve(specifier);
}

/** The smoke gateway is bundled to ESM before it is imported. Dynamic
 * `require.resolve` calls inside that bundle cannot reproduce the real
 * engine's package-relative runtime discovery and used to fall through to
 * unrelated global Claude/Codex installs. Resolve the pinned artifacts while
 * this unbundled launcher still has normal Node module semantics, then hand
 * their physical paths to the gateway exactly as Electron main does. */
export function agentSmokeProviderRuntimeEnvironment(
  ambient = process.env,
  platform = process.platform,
  arch = process.arch,
  resolveModule = defaultModuleResolver,
) {
  const resolved = {};
  const explicitClaude = ambient.ZEROS_CLAUDE_CLI_PATH?.trim();
  if (explicitClaude) {
    resolved.ZEROS_CLAUDE_CLI_PATH = explicitClaude;
  } else {
    const sdkEntry = resolveModule("@anthropic-ai/claude-agent-sdk");
    const binary = platform === "win32" ? "claude.exe" : "claude";
    const packages =
      platform === "linux"
        ? [
            `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
            `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
          ]
        : [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];
    let claudePath;
    for (const packageName of packages) {
      try {
        claudePath = resolveModule(`${packageName}/${binary}`, sdkEntry);
        break;
      } catch {
        // Try the platform's next official binary variant.
      }
    }
    if (!claudePath) {
      throw new Error(
        `live smoke pinned Claude runtime is unavailable for ${platform}-${arch}`,
      );
    }
    resolved.ZEROS_CLAUDE_CLI_PATH = claudePath;
  }

  const explicitCodex = ambient.ZEROS_CODEX_CLI_PATH?.trim();
  if (explicitCodex) {
    resolved.ZEROS_CODEX_CLI_PATH = explicitCodex;
  } else {
    const codexPackage = resolveModule("@openai/codex/package.json");
    resolved.ZEROS_CODEX_CLI_PATH = path.join(
      path.dirname(codexPackage),
      "bin",
      "codex.js",
    );
  }
  return resolved;
}

/** Resolve the same generated ZSR assets that the Electron sidecar exports.
 * The live smoke deliberately serves a temporary repository, so relying on
 * AgentGateway's projectRoot-relative development fallback points at files
 * that cannot exist and silently turns every contained auth probe into an
 * "unauthenticated" skip. Explicit caller/package overrides still win. */
export function agentSmokeZsrEnvironment(
  repoRoot,
  runtime = process.execPath,
  ambient = process.env,
) {
  const hostRuntime = ambient.ZEROS_PTY_HOST_RUNTIME?.trim() || runtime;
  const supervisorRuntime =
    ambient.ZEROS_ZSR_SUPERVISOR_RUNTIME?.trim() ||
    (ambient.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1"
      ? hostRuntime
      : runtime);
  const resolved = {
    ZEROS_PTY_HOST_RUNTIME: hostRuntime,
    ZEROS_CURSOR_HOST_SCRIPT:
      ambient.ZEROS_CURSOR_HOST_SCRIPT?.trim() ||
      path.join(
        repoRoot,
        "apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs",
      ),
    ZEROS_ZSR_SUPERVISOR_RUNTIME: supervisorRuntime,
  };
  for (const [name, leaf] of Object.entries(ZSR_ASSETS)) {
    resolved[name] =
      ambient[name]?.trim() || path.join(repoRoot, "binaries", leaf);
  }
  return resolved;
}

export function installAgentSmokeZsrEnvironment(
  repoRoot,
  runtime = process.execPath,
  ambient = process.env,
  platform = process.platform,
) {
  const resolved = {
    ...agentSmokeZsrEnvironment(repoRoot, runtime, ambient),
    ...agentSmokeProviderRuntimeEnvironment(
      ambient,
      platform,
      process.arch,
    ),
  };
  const unavailable = Object.entries(resolved).filter(
    ([name, file]) =>
      (platform === "darwin" || !DARWIN_ONLY_ASSETS.has(name)) &&
      (!path.isAbsolute(file) || !existsSync(file)),
  );
  if (unavailable.length > 0) {
    throw new Error(
      `live smoke ZSR asset is unavailable: ${unavailable
        .map(([name]) => name)
        .join(", ")}; run pnpm build:zsr-supervisor first`,
    );
  }
  Object.assign(ambient, resolved);
  return resolved;
}

export function agentSmokeSkipReason(agent) {
  if (agent.installed === false) return "not installed";
  if (agent.authenticated === true) return null;
  const unavailable = agent.authenticationUnavailableReason?.trim();
  return unavailable
    ? `authentication check unavailable: ${unavailable}`
    : "not authenticated";
}

export function agentSmokeProviderCwd(workspaceRoot, agentId) {
  const safeAgent = String(agentId ?? "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return path.join(
    path.resolve(workspaceRoot),
    ".zeros-agent-smoke",
    safeAgent || "agent",
  );
}

export function canonicalAgentSmokeWorkspace(directory) {
  return realpathSync(directory);
}

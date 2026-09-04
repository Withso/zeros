import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const moduleRequire = createRequire(import.meta.url);

function defaultModuleResolver(specifier, anchor) {
  return anchor
    ? createRequire(anchor).resolve(specifier)
    : moduleRequire.resolve(specifier);
}

/** The smoke gateway is bundled to ESM before it is imported. Dynamic
 * `require.resolve` calls inside that bundle cannot reproduce the real
 * engine's package-relative runtime discovery and could fall through to
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

/** Resolve the native process owner and provider host used by the live Code
 * smoke. Its gateway serves a temporary repository, so projectRoot-relative
 * development discovery would point at files that do not exist. Design-agent
 * ZSR assets are deliberately absent: this command opens Code sessions only. */
export function agentSmokeRuntimeEnvironment(
  repoRoot,
  runtime = process.execPath,
  ambient = process.env,
) {
  const hostRuntime = ambient.ZEROS_PTY_HOST_RUNTIME?.trim() || runtime;
  return {
    ZEROS_PTY_HOST_RUNTIME: hostRuntime,
    ZEROS_CURSOR_HOST_SCRIPT:
      ambient.ZEROS_CURSOR_HOST_SCRIPT?.trim() ||
      path.join(
        repoRoot,
        "apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs",
      ),
    ZEROS_HOST_SUPERVISOR_RUNTIME:
      ambient.ZEROS_HOST_SUPERVISOR_RUNTIME?.trim() || hostRuntime,
    ZEROS_HOST_SUPERVISOR_SCRIPT:
      ambient.ZEROS_HOST_SUPERVISOR_SCRIPT?.trim() ||
      path.join(
        repoRoot,
        "apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs",
      ),
  };
}

export function installAgentSmokeRuntimeEnvironment(
  repoRoot,
  runtime = process.execPath,
  ambient = process.env,
  platform = process.platform,
) {
  const resolved = {
    ...agentSmokeRuntimeEnvironment(repoRoot, runtime, ambient),
    ...agentSmokeProviderRuntimeEnvironment(ambient, platform, process.arch),
  };
  const unavailable = Object.entries(resolved).filter(
    ([, file]) => !path.isAbsolute(file) || !existsSync(file),
  );
  if (unavailable.length > 0) {
    throw new Error(
      `live Code smoke runtime is unavailable: ${unavailable
        .map(([name]) => name)
        .join(", ")}`,
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

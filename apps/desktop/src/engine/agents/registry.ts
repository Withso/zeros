// ──────────────────────────────────────────────────────────
// Agent registry — local manifest
// ──────────────────────────────────────────────────────────
//
// Replaces the former remote agent registry. The old registry fetched
// CDN JSON describing how to spawn npx/uvx adapters. We don't do that
// anymore — users bring their own CLI installs, and we know exactly
// which CLIs we support.
//
// This file is the single source of truth for:
//   - which agents Zeros knows about
//   - what CLI binary to probe on PATH
//   - which adapter class to instantiate
//   - what auth-file to check for the green-dot indicator
//   - how `<cli> login` gets triggered from the UI
//
// Adding a new agent = one entry here + one adapter module.
//
// ──────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, AgentAdapterContext } from "./types";
import type { AccountDetails, EnrichedRegistryAgent } from "../types";
import { AGENT_INSTALL_COMMANDS } from "./install-commands";
import { createClaudeSdkAdapter } from "./adapters/claude-sdk";
import {
  CLAUDE_CLI_VERSION_ENV,
  claudeCliMissingMessage,
  resolveClaudeCli,
} from "./adapters/claude-sdk/binary-resolver";
import { createCodexAdapter } from "./adapters/codex";
import { createCursorSdkAdapter } from "./adapters/cursor-sdk";

// ── Auth-probe spec ──────────────────────────────────────
//
// "File" = check existence of path (expands ~ to home, never reads
//   contents).
// "Keychain" = macOS `security find-generic-password -s <name>` exit
//   code. Used by Claude's macOS Keychain storage.
// "Command" = run `<cli> auth status` / `<cli> status` and check exit
//   code 0. Slowest — only used when filesystem and keychain paths
//   don't pin down the answer.

export type AuthProbe =
  | { kind: "file"; paths: string[] }
  | { kind: "keychain"; service: string }
  | { kind: "command"; binary: string; args: string[] }
  | { kind: "any-of"; probes: AuthProbe[] }
  /** "File" + content-aware expiry check. Reads a JSON file, walks
   *  `expiryFieldPath` to extract a timestamp, and returns false when
   *  the timestamp is in the past. Returns false on missing file,
   *  parse error, or missing field. Catches the "credentials file
   *  still on disk but the OAuth token expired hours ago" case that
   *  a plain `file` probe misses. We only read the expiry field —
   *  tokens never cross this boundary. Apply to agents whose auth
   *  file format is stable enough that the field path is reliable
   *  (Claude); skip for ones with multi-mode auth files
   *  (Codex — uses an active command probe instead). */
  | {
      kind: "file-with-expiry";
      path: string;
      expiryFieldPath: string[];
      /** "ms" = expiry stored as Unix epoch ms (Claude). "s" =
       *  epoch seconds (some OAuth libs). Defaults to "ms". */
      expiryUnit?: "ms" | "s";
    }
  /** "File" + content-aware field-presence check. Reads a JSON file and
   *  walks `fieldPath`; authenticated iff the leaf is a non-empty
   *  string. Returns false on missing file, parse error, or
   *  missing/empty field. This is the right probe for OAuth credential
   *  files where a long-lived `refresh_token` — NOT the short-lived
   *  access-token `expiry_date` — is the real "signed in" signal: the
   *  CLI silently mints a fresh access token from the refresh token, so
   *  an expired `expiry_date` does not mean signed-out. The field VALUE
   *  is read but never escapes the probe — only the boolean does. */
  | {
      kind: "file-with-field";
      path: string;
      fieldPath: string[];
    }
  /** Exists-only check for a key in the app's encrypted secret store
   *  (`<userData>/secrets.json`, written by Electron safeStorage). The
   *  engine runs as a separate process and can't call safeStorage, so the
   *  Electron shell passes the store's path via the ZEROS_SECRETS_FILE env
   *  var at spawn (apps/desktop/electron/sidecar.ts). Authenticated iff the file holds a
   *  non-empty entry under `account`. The stored value is encrypted and is
   *  NEVER read or decrypted — only key-presence escapes, making this
   *  strictly more conservative than `file-with-field`. Backs API-key
   *  agents whose credential never lands in a CLI dotfile (Cursor's
   *  @cursor/sdk reads CURSOR_API_KEY). Returns false when the env var is
   *  unset (engine run outside Electron), so it's a safe no-op there. */
  | {
      kind: "secret-account";
      /** Account key in secrets.json (e.g. "cursor-api-key"). */
      account: string;
    };

// ── Manifest entry ───────────────────────────────────────

export interface AgentManifestEntry {
  id: string;
  name: string;
  description: string;
  icon?: string;
  /** The CLI binary the user invokes directly. This is what we probe
   *  on PATH to decide if the agent is installed. */
  cliBinary: string;
  /** Shown in Settings → Agents. Used by the "Install" affordance. */
  installHint?: {
    command: string;
    docsUrl?: string;
  };
  /** Auth detection. Most probes are existence-only (file present /
   *  command exits 0 / keychain entry exists). The `file-with-expiry`
   *  variant opens a credential JSON to read a single expiry field —
   *  see the token-handling policy at the top of probes.ts. Tokens
   *  never escape the probe function. */
  authProbe: AuthProbe;
  /** Command the UI's "Sign in" button runs in Terminal. */
  loginCommand: { binary: string; args: string[] };
  /** Minimum `<cliBinary> --version` we've tested our translator
   *  against. Below this, the UI surfaces "supported versions: X+"
   *  so the user doesn't chase ghost parse errors. Omitted = no
   *  floor (early-adopter territory, best-effort parse). */
  minCliVersion?: string;
  /** Maximum version we've pinned to. Usually omitted — we only set
   *  this when a vendor ships a breaking CLI/SDK schema change
   *  that we know breaks our translator, while we work on a fork. */
  maxCliVersion?: string;
  /** Marks the agent as beta. The renderer shows a "Beta" tag next to
   *  the name, and the enabled-agents store keeps it off-by-default on
   *  first run so new users have to opt in. Remove once the upstream
   *  CLI exposes the surfaces our adapter actually needs. */
  beta?: boolean;
  /** SDK-backed agent: its runtime ships WITH the app (an npm dependency),
   *  not a user-installed CLI on PATH. When true, `installed` is always
   *  true (the PATH probe is skipped) and auth is the provider API key,
   *  not a CLI sign-in. Cursor (via @cursor/sdk) is the first such agent. */
  bundledRuntime?: boolean;
  /** For agents whose runtime ships WITH the app: can that runtime actually be
   *  found and executed right now? Returns null when it can, or a
   *  user-actionable reason when it cannot.
   *
   *  This exists because "has credentials" and "can run" are INDEPENDENT, and
   *  conflating them shipped a green "Connected" badge on a completely broken
   *  Claude in Beta + Production (0.0.14): the auth probe found a keychain item
   *  and reported success, while `query()` threw "Native CLI binary for
   *  darwin-arm64 not found" on every send. Cheap + synchronous (a couple of
   *  stat() calls behind a process-lifetime memo), so it can run on every
   *  listAgents.
   *
   *  `override` is the user's persisted Settings → Agent providers → Executable
   *  path for this agent (resolved by the gateway from the user settings layer).
   *  It MUST be honoured: the missing-runtime message tells the user to set
   *  exactly that value, so a probe that ignored it left them in a dead end —
   *  `installed`/`authenticated` stayed false, `isRunnableAgent()` returned false,
   *  and every send was refused no matter what they typed in the field. */
  runtimeUnavailable?: (override?: string) => string | null;
  /** Adapter factory. Called lazily on first use. */
  createAdapter: (ctx: AgentAdapterContext) => AgentAdapter;
}

// ── Manifest ─────────────────────────────────────────────
//
// Adapter factories are imported lazily so the engine boots fast and
// unused agents never load their modules.

export const AGENT_MANIFEST: AgentManifestEntry[] = [
  {
    id: "claude",
    name: "Claude Code",
    description: "Anthropic's Claude Code CLI (subscription or API key).",
    cliBinary: "claude",
    // Lobehub static-svg CDN serves official mono brand marks with
    // `currentColor` fills, which AgentIcon recolors to the agent's
    // brand hue (or leaves currentColor in monochrome mode for the
    // summary-pill row). Pinning to @latest keeps mark refreshes in
    // sync with brand updates without us re-vendoring assets.
    icon: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/claude.svg",
    installHint: {
      command: AGENT_INSTALL_COMMANDS.claude,
      docsUrl: "https://code.claude.com/docs",
    },
    authProbe: {
      // Keychain is the modern Claude Code storage (Catalina+). Fall
      // back to the older dotfiles for users on legacy installs.
      // Crucially: when the credentials live in `.credentials.json`
      // we read the `claudeAiOauth.expiresAt` field (Unix ms) so an
      // expired refresh-token doesn't keep the dot stuck on green.
      // Token contents never leave the probe — only the boolean.
      kind: "any-of",
      probes: [
        { kind: "keychain", service: "Claude Code-credentials" },
        {
          kind: "file-with-expiry",
          path: "~/.claude/.credentials.json",
          expiryFieldPath: ["claudeAiOauth", "expiresAt"],
          expiryUnit: "ms",
        },
        {
          // Legacy credential file ONLY. Deliberately NOT settings.json:
          // that's the user's prefs (theme, etc.), which Claude Code keeps
          // after `claude /logout`. Including it made `any-of` return true
          // for anyone who'd ever opened Claude Code — so the Providers card
          // stayed "Connected" even when signed out (no keychain entry, no
          // .credentials.json). auth.json is a real (older) credential file.
          kind: "file",
          paths: ["~/.claude/auth.json"],
        },
      ],
    },
    loginCommand: { binary: "claude", args: ["/login"] },
    // minVersion gates the version-compat warning for a user's globally
    // installed `claude` (used for sign-in via Terminal). The agent itself
    // runs through the SDK's own bundled, pinned claude-code CLI, so the
    // global version doesn't affect execution.
    minCliVersion: "1.0.0",
    // Claude's runtime ships WITH the app (the Agent SDK's pinned claude-code,
    // staged into Contents/Resources/claude at pack time), so "is it installed"
    // must mean "did the app ship a usable runtime" — NOT "is there a global
    // `claude` on PATH", which is unrelated to whether chats work.
    bundledRuntime: true,
    // …and because the runtime is bundled, its ABSENCE is a build defect the UI
    // has to state plainly instead of rendering a green "Connected" badge on a
    // Claude that fails every send (the 0.0.14 Beta/Production bug).
    // Passes the user's persisted Executable path through, so setting it is a real
    // remedy rather than advice the probe then ignores.
    runtimeUnavailable: (override) =>
      resolveClaudeCli({ override }).path === null
        ? claudeCliMissingMessage()
        : null,
    // Claude runs EXCLUSIVELY through the official
    // @anthropic-ai/claude-agent-sdk: one persistent `query()` per session
    // (streaming-input mode), in-loop `canUseTool` permissions (no hook
    // server), SDK-managed thinking-block round-trips, and a pinned bundled
    // CLI. The old per-turn `claude -p` stream-json adapter was removed —
    // there is intentionally NO fallback path, so there's only one Claude
    // code path to reason about.
    createAdapter: (ctx) => createClaudeSdkAdapter(ctx),
  },
  {
    id: "codex",
    name: "Codex",
    description: "OpenAI Codex CLI (ChatGPT subscription or API key).",
    cliBinary: "codex",
    // Codex is an OpenAI product so we reuse the canonical OpenAI mark.
    icon: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openai.svg",
    installHint: {
      command: AGENT_INSTALL_COMMANDS.codex,
      docsUrl: "https://developers.openai.com/codex",
    },
    authProbe: {
      // `codex login status` is the authoritative check — exits 0
      // when signed in, non-zero otherwise. We previously used a
      // file-existence probe on `~/.codex/auth.json`, which lied for
      // expired credentials: file present, CLI rejects on spawn,
      // panel stuck on green while the chat composer fires "Sign in
      // required" toasts. The command probe is ~150ms slower per
      // listAgents but it's the CLI's own opinion, which is the only
      // signal that's never wrong. Codex CLI v0.21+ ships this
      // command; for older installs the probe returns false (push
      // those users to update — modern Codex is far ahead anyway).
      kind: "command",
      binary: "codex",
      args: ["login", "status"],
    },
    loginCommand: { binary: "codex", args: ["login"] },
    // 2026-05-24 — bumped from 0.8.0 (legacy `codex exec resume`) to
    // 0.131.0 (the floor for the `codex app-server` adapter that
    // replaced exec --json). 0.131 also dropped the legacy
    // `[features].codex_hooks` config in favour of `[features].hooks`,
    // and added the permission-profile / remote-control surfaces our
    // initialize-handshake version check expects. Below this, the
    // app-server initialize fails fast with a clear upgrade prompt.
    minCliVersion: "0.131.0",
    createAdapter: (ctx) => createCodexAdapter(ctx),
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    description: "Cursor's coding agent (bundled @cursor/sdk, API key).",
    // `cliBinary` is retained only for the install-hint label + the displayed
    // `--version` probe. The RUNTIME is the bundled @cursor/sdk (an npm dep),
    // NOT this CLI — `bundledRuntime: true` skips the PATH probe entirely.
    cliBinary: "cursor-agent",
    icon: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/cursor.svg",
    installHint: {
      command: AGENT_INSTALL_COMMANDS.cursor,
      docsUrl: "https://cursor.com/docs/cli",
    },
    // API-key only. The @cursor/sdk reads CURSOR_API_KEY (pasted in
    // Settings → Providers → Cursor, stored in the app's encrypted secret
    // store). There is no `cursor-agent login` session in the run path, so the
    // file/command probes are gone — key presence is the whole signal.
    authProbe: { kind: "secret-account", account: "cursor-api-key" },
    loginCommand: { binary: "cursor-agent", args: ["login"] },
    // Cursor runs EXCLUSIVELY through the bundled @cursor/sdk (in-process
    // Agent.create/send + run.stream()): real image input, native cross-restart
    // resume, typed events, live model catalog, and in-process custom tools.
    // ONE Cursor code path — no CLI/ACP fallback. The SDK ships with the app,
    // so `installed` is always true. Trade-off: the SDK is HTTP/2-only (no
    // HTTP/1.1 fallback), so on HTTP/2-constrained networks a prompt can fail
    // with a TLS/HTTP-2 error — the adapter surfaces that as an actionable
    // message. Auth is the Cursor API key.
    bundledRuntime: true,
    createAdapter: (ctx) => createCursorSdkAdapter(ctx),
  },
];

// ── Public API ───────────────────────────────────────────

export function findAgent(id: string): AgentManifestEntry | undefined {
  return AGENT_MANIFEST.find((a) => a.id === id);
}

/** Per-agent version compatibility summary the gateway fans out to
 *  the wire. The caller (AgentGateway.listAgents) runs the probes
 *  concurrently so we don't pay N × 2s of serialised `--version` calls. */
export interface AgentVersionInfo {
  installedVersion?: string;
  versionCompatible?: boolean;
}

// tsup compiles the engine to CJS, so the ambient `require` is the resolver
// (matches codex/binary-resolver.ts). Used to locate bundled agent packages.
declare const require: NodeJS.Require;

let cachedClaudeCliVersion: string | null | undefined;
let cachedCodexVersion: string | null | undefined;

/** The Claude Code CLI version BUNDLED inside `@anthropic-ai/claude-agent-sdk`
 *  — i.e. what `query()` actually runs — read from the SDK's manifest.json
 *  (`version`) / package.json (`claudeCodeVersion`). The package's `package.json`
 *  is NOT an exported subpath (resolving it throws ERR_PACKAGE_PATH_NOT_EXPORTED),
 *  so we resolve the package main (exported) and walk up to the manifest. Cached
 *  per process — it only changes when the SDK dep is bumped (needs reinstall +
 *  restart anyway). Returns null if unresolvable (caller falls back to the PATH
 *  probe). */
function readClaudeBundledCliVersion(): string | null {
  if (cachedClaudeCliVersion !== undefined) return cachedClaudeCliVersion;
  cachedClaudeCliVersion = null;
  // PACKAGED FIRST. The require.resolve walk below CANNOT work in the packaged
  // app — the engine is a `bun build --compile` single-file binary with no
  // node_modules on disk — so before this it silently returned null and Beta/
  // Production reported NO Claude runtime version while dev reported the right
  // one. Electron main reads the version from the staged
  // Contents/Resources/claude-cli-version.txt and forwards it here (see
  // apps/desktop/electron/sidecar.ts resolveClaudeCliPaths + claude-sdk/binary-resolver.ts).
  const fromEnv = process.env[CLAUDE_CLI_VERSION_ENV]?.trim();
  if (fromEnv) {
    cachedClaudeCliVersion = fromEnv;
    return cachedClaudeCliVersion;
  }
  try {
    let dir = path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
    for (let i = 0; i < 6; i++) {
      const manifest = path.join(dir, "manifest.json");
      if (existsSync(manifest)) {
        const v = JSON.parse(readFileSync(manifest, "utf8")).version;
        if (typeof v === "string") {
          cachedClaudeCliVersion = v;
          break;
        }
      }
      const pkg = path.join(dir, "package.json");
      if (existsSync(pkg)) {
        const j = JSON.parse(readFileSync(pkg, "utf8")) as {
          name?: string;
          claudeCodeVersion?: string;
        };
        if (j.name === "@anthropic-ai/claude-agent-sdk") {
          if (typeof j.claudeCodeVersion === "string") {
            cachedClaudeCliVersion = j.claudeCodeVersion;
          }
          break;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* SDK not resolvable — fall back to the global probe */
  }
  return cachedClaudeCliVersion;
}

/** The Codex CLI version BUNDLED via the `@openai/codex` npm dep (the
 *  binary-resolver prefers it over the user's global `codex`). */
function readCodexBundledVersion(): string | null {
  if (cachedCodexVersion !== undefined) return cachedCodexVersion;
  cachedCodexVersion = null;
  // Same packaged-first ordering as Claude above: require.resolve is dead in the
  // bun-compiled engine, so Electron main forwards the version written by
  // scripts/stage-codex-cli.mjs beside the staged native runtime.
  const fromEnv = process.env.ZEROS_CODEX_CLI_VERSION?.trim();
  if (fromEnv) {
    cachedCodexVersion = fromEnv;
    return cachedCodexVersion;
  }
  try {
    const pkg = require.resolve("@openai/codex/package.json");
    const v = JSON.parse(readFileSync(pkg, "utf8")).version;
    if (typeof v === "string") cachedCodexVersion = v;
  } catch {
    /* not resolvable — fall back to the global probe */
  }
  return cachedCodexVersion;
}

/** The version of the CLI that ACTUALLY runs for an agent whose runtime is
 *  BUNDLED with the app — Claude (the Agent SDK's pinned claude-code) and Codex
 *  (the @openai/codex dep). This is the load-bearing version for "can I run this
 *  model", as opposed to the user's global `<cli> --version` (which only matters
 *  for sign-in via Terminal). Returns null for agents whose runtime IS the
 *  user's global CLI (cursor) — those use the PATH probe. */
export function bundledRuntimeVersion(agentId: string): string | null {
  switch (agentId) {
    case "claude":
      return readClaudeBundledCliVersion();
    case "codex":
      return readCodexBundledVersion();
    default:
      return null;
  }
}

/** Produce the agent list the engine broadcasts over `AGENT_AGENTS_LIST`.
 *  `installed` comes from PATH probing (caller passes the result).
 *  Typed as `EnrichedRegistryAgent` so it drops cleanly into the
 *  existing wire message; browser-side `BridgeRegistryAgent` is
 *  structurally compatible. */
export function toBridgeAgents(
  installedBinaries: Set<string>,
  authenticatedAgentIds?: Set<string>,
  versionInfoByAgentId?: Map<string, AgentVersionInfo>,
  accountByAgentId?: Map<string, AccountDetails>,
  /** Per-agent persisted Executable-path overrides (Settings → Agent providers),
   *  resolved from the user settings layer by the caller. Fed to each agent's
   *  `runtimeUnavailable` probe so a user-supplied binary clears the
   *  missing-runtime state — see that field's doc for why ignoring it was a
   *  dead end. */
  runtimeOverrides?: Map<string, string>,
  /** Manifest to project. Defaults to the real one; injected by tests so the
   *  runtime-unavailable path is reachable without hiding node_modules (in
   *  vitest the real Claude runtime always resolves, which is exactly the blind
   *  spot that let the packaged bug ship). */
  manifest: AgentManifestEntry[] = AGENT_MANIFEST,
): EnrichedRegistryAgent[] {
  return manifest.map((m) => {
    // Can the runtime we'd actually spawn be found? For bundled-runtime agents
    // this is the real "installed" question; a global CLI on PATH is irrelevant
    // to whether chats work.
    const runtimeUnavailableReason =
      m.runtimeUnavailable?.(runtimeOverrides?.get(m.id)) ?? undefined;
    // SDK-backed agents (bundledRuntime) ship with the app, so they're
    // always "installed" — no `cliBinary` on PATH required — UNLESS the shipped
    // runtime is actually missing, which is a packaging defect we must surface
    // rather than paper over.
    const installed = runtimeUnavailableReason
      ? false
      : m.bundledRuntime === true || installedBinaries.has(m.cliBinary);
    const vinfo = versionInfoByAgentId?.get(m.id);
    return {
      id: m.id,
      name: m.name,
      // `version` historically held the registry-declared version; we
      // now always pass the CLI's actually-installed version when we
      // have it. Empty string = not probed / not installed.
      version: vinfo?.installedVersion ?? "",
      description: m.description,
      icon: m.icon,
      distribution: {}, // no npx/uvx/binary registry — user-installed
      installed,
      launchKind: installed ? "binary" : "unavailable",
      authBinary: m.cliBinary,
      // The Login-in-Terminal flow needs the per-agent args (e.g.
      // `codex login`). Surface them so the IPC handler doesn't have
      // to duplicate the manifest.
      loginArgs: m.loginCommand.args,
      // Surface install hints to the UI so the "no CLI detected" state
      // can tell the user exactly what to run. Cheap — a few strings
      // on every AGENT_AGENTS_LIST broadcast.
      installHint: m.installHint,
      // Engine-resolved auth state. Undefined when the caller didn't
      // supply a probe set (older gateway path); the legacy
      // `ai_cli_is_authenticated` IPC is the fallback in that case.
      //
      // AND-ed with runtime availability: the credential probe only proves an
      // artifact EXISTS (a keychain item survives token revocation and even
      // uninstalling the CLI), so on its own it reported "Connected" for a
      // Claude that threw on every single send. "Connected" has to mean
      // "will work", and it cannot work without a runtime.
      authenticated: runtimeUnavailableReason
        ? false
        : authenticatedAgentIds?.has(m.id),
      runtimeUnavailableReason,
      installedVersion: vinfo?.installedVersion,
      versionCompatible: vinfo?.versionCompatible,
      minCliVersion: m.minCliVersion,
      maxCliVersion: m.maxCliVersion,
      beta: m.beta,
      // Account details (provider / plan / org / email) when the gateway's
      // account probe has them cached for this agent; undefined otherwise.
      account: accountByAgentId?.get(m.id),
    } satisfies EnrichedRegistryAgent;
  });
}

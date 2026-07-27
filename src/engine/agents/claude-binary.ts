// ──────────────────────────────────────────────────────────
// Claude Code binary resolution (for the embedded terminal).
// ──────────────────────────────────────────────────────────
//
// The composer's inline embedded-terminal commands (`/mcp`, `/login`,
// `/config`, …) run the real `claude` CLI in an ephemeral login-shell PTY.
// They all operate on the SHARED `~/.claude` config + credential store — the
// SAME files the claude-sdk adapter reads — so ANY on-disk `claude` is
// config-consistent with the agent; the version is immaterial for these TUIs.
//
// We deliberately do NOT chase the Agent SDK's bundled binary: it's a ~218 MB
// blob embedded in the bun executable, extracted to a /tmp path via an internal
// `extractFromBunfs(embeddedPath)` whose `embeddedPath` lives in minified
// sdk.mjs — heavy, version-specific, and ugly in a visible terminal. Instead we
// resolve a clean, stable path the way Codex's binary-resolver does:
//
//   1. **override** — a user-set `cliBinary` (Settings → Providers → Advanced).
//   2. **well-known** — the documented install locations (official local
//      installer, Homebrew, common user bins), checked for existence.
//   3. **path** — a `claude` found by scanning `process.env.PATH`.
//   4. **fallback** — the bare name `claude`. The PTY is a LOGIN shell with the
//      user's full profile PATH, so the shell resolves it at exec even when the
//      engine's own (minimal) PATH didn't — the always-works safety net.
//
// Returning the *full path* when we have one lets the terminal show a clean
// `'/abs/path/claude' /mcp` line (mockup parity) AND covers the case where the
// engine's PATH is minimal but a well-known install exists.
// ──────────────────────────────────────────────────────────

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ClaudeBinarySource {
  /** Absolute path to a `claude` executable, or the bare name `claude`. */
  readonly path: string;
  readonly source: "override" | "well-known" | "path" | "fallback";
}

const BIN = "claude";

/** Documented + common install locations for the `claude` CLI, in priority
 *  order. Absolute so they resolve regardless of the engine's PATH.
 *
 *  Exported because the claude-sdk binary-resolver uses the SAME list as its
 *  last-resort tier (a user's own global install, when the app's staged runtime
 *  is missing). One list, so a new install location added here is picked up by
 *  both the embedded terminal and the agent run path. */
export function claudeWellKnownPaths(home: string = os.homedir()): string[] {
  return [
    path.join(home, ".claude", "local", BIN), // official local installer
    path.join(home, ".local", "bin", BIN), // official installer / pipx-style
    "/opt/homebrew/bin/" + BIN, // Homebrew (Apple Silicon)
    "/usr/local/bin/" + BIN, // Homebrew (Intel) / manual
    path.join(home, ".bun", "bin", BIN), // bun install -g
    path.join(home, ".deno", "bin", BIN), // deno install
    path.join(home, ".volta", "bin", BIN), // Volta shim
  ];
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return false;
    // Best-effort exec check; on platforms without X_OK semantics access()
    // still confirms the file is reachable.
    await fsp.access(p, fsp.constants.X_OK).catch(() => fsp.access(p));
    return true;
  } catch {
    return false;
  }
}

/** First `claude` found on a PATH string (the engine's PATH — may be minimal
 *  in the packaged app, which is exactly why this is only step 3). */
async function scanPath(pathValue: string | undefined): Promise<string | null> {
  if (!pathValue) return null;
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, BIN);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Resolve a `claude` binary for the embedded terminal. Never throws — an
 *  unresolved binary degrades to the bare name (login-shell PATH resolves it).
 *
 *  `candidates` (the well-known absolute paths) + `pathValue` default to the
 *  real environment; both are injectable so the cascade is unit-testable
 *  without depending on the host's actual installs. */
export async function resolveClaudeBinary(
  opts: {
    override?: string;
    candidates?: string[];
    pathValue?: string;
  } = {},
): Promise<ClaudeBinarySource> {
  // 1. Explicit user override.
  const override = opts.override?.trim();
  if (override) {
    if (await isExecutableFile(override)) {
      return { path: override, source: "override" };
    }
    console.warn(
      `[claude-binary] override '${override}' not found; falling back`,
    );
  }

  // 2. Well-known absolute install locations.
  const candidates = opts.candidates ?? claudeWellKnownPaths(os.homedir());
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) {
      return { path: candidate, source: "well-known" };
    }
  }

  // 3. A `claude` on the engine's PATH.
  const onPath = await scanPath(opts.pathValue ?? process.env.PATH);
  if (onPath) return { path: onPath, source: "path" };

  // 4. Bare name — the login-shell PATH resolves it at exec.
  return { path: BIN, source: "fallback" };
}

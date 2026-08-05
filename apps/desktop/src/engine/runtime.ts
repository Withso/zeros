// ──────────────────────────────────────────────────────────
// Engine runtime mode + loopback port range (single source of truth)
// ──────────────────────────────────────────────────────────
//
// The ENGINE side mirror of apps/desktop/electron/runtime-mode.ts. Where the Electron
// host detects dev/prod from `process.defaultApp`, the engine — which runs
// as a spawned sidecar, in-process inside Electron, as a standalone CLI, or
// in a headless cloud sandbox — keys off an explicit ENV signal instead:
//
//   ZEROS_DEV=1            (set by the electron:dev script AND apps/desktop/electron/main.ts)
//   ZEROS_RUNTIME_MODE=dev (equivalent alias)
//
// Keeping this here — not duplicated across db/paths.ts, git/state.ts and
// crypto/keypair.ts — means exactly ONE place decides "am I dev?". That is
// the hardening that stops a dev run from silently writing a packaged
// build's data dirs (or vice-versa).
// ──────────────────────────────────────────────────────────

/** True when this engine should use the isolated "dev" data dirs + port
 *  range. Reads ENV defensively so the module is safe to import from a
 *  browser bundle (the renderer pulls in the port constants below). */
export function isDevRuntime(): boolean {
  if (typeof process === "undefined" || !process.env) return false;
  return process.env.ZEROS_DEV === "1" || process.env.ZEROS_RUNTIME_MODE === "dev";
}

// Loopback base ports for the engine's HTTP + WebSocket bridge. Every release
// channel owns a DISJOINT footprint so Stable, Beta, and a `pnpm electron:dev`
// engine can run AT THE SAME TIME without competing for ports or cross-killing
// each other in reapOrphanEngines() (which scans only the current channel's
// walk range). Keep Stable pinned for backwards compatibility with installed
// releases. Beta starts after Stable's full footprint: its eight-port engine
// walk PLUS base+8/base+9 for the MCP gateway and OAuth callback.
export const ENGINE_BASE_PORT_PROD = 24193;
export const ENGINE_BASE_PORT_BETA = 24203;
/** Alpha (every merge to main) sits after Beta's full 10-port footprint. Chosen so
 *  all four channels can run SIMULTANEOUSLY: prod 24193-24202, beta 24203-24212,
 *  alpha 24213-24222, dev 24293+. The gap before dev is deliberate headroom — dev
 *  strides instances by span+2 from 24293 (scripts/dev-instance.mjs). */
export const ENGINE_BASE_PORT_ALPHA = 24213;
export const ENGINE_BASE_PORT_DEV = 24293;

/** How many ports LocalTransport walks from the base on EADDRINUSE. The
 *  reaper + localhost inspector scan exactly this span: [base, base+span-1].
 *  NOTE: a per-worktree dev instance's full footprint is span+2 — the walk range
 *  PLUS base+8/base+9 for the MCP gateway + its OAuth callback (engine/zeros-engine.ts
 *  startGateway). scripts/dev-instance.mjs strides instance base ports by span+2
 *  so adjacent instances never collide on the walk range OR the gateway ports. */
export const ENGINE_PORT_SPAN = 8;

/** The base loopback port for THIS runtime.
 *  Resolution order:
 *   1. ZEROS_ENGINE_BASE_PORT — an explicit per-instance override exported by the
 *      dev-instance launcher so two `pnpm electron:dev` worktrees bind DISJOINT
 *      engine blocks (and their range-scoped orphan reapers never cross-kill).
 *   2. else the release-channel default (stable → 24193, beta → 24203,
 *      dev → 24293). */
export function engineBasePort(): number {
  const override = envBasePort();
  if (override !== null) return override;
  switch (channel()) {
    case "alpha":
      return ENGINE_BASE_PORT_ALPHA;
    case "beta":
      return ENGINE_BASE_PORT_BETA;
    case "dev":
      return ENGINE_BASE_PORT_DEV;
    default:
      return ENGINE_BASE_PORT_PROD;
  }
}

/** Parse ZEROS_ENGINE_BASE_PORT into a valid TCP port, or null when unset/bogus.
 *  Reads ENV defensively so the module stays import-safe from the renderer. */
function envBasePort(): number | null {
  if (typeof process === "undefined" || !process.env) return null;
  const raw = process.env.ZEROS_ENGINE_BASE_PORT?.trim();
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  // Leave headroom above the base for the walk range + gateway ports.
  return Number.isInteger(n) && n > 0 && n + ENGINE_PORT_SPAN + 1 <= 65535 ? n : null;
}

// ──────────────────────────────────────────────────────────
// Release channel (dev | beta | stable) — single source of truth
// ──────────────────────────────────────────────────────────
// Three values, not just dev/prod, so a Beta build can (a) keep its OWN data
// dirs (db/paths.ts → com.zeros.beta), (b) point the auto-updater at the beta
// feed (apps/desktop/electron/updater.ts), and (c) flip channel-gated feature flags.
//
// Travels by ENV exactly like ZEROS_DEV: the Electron main seeds
// process.env.ZEROS_CHANNEL once at startup (from a build-time bake) so every
// spawned engine inherits it. The RENDERER has its own resolver keyed off
// import.meta.env.VITE_ZEROS_CHANNEL (apps/desktop/src/renderer/config/release-channel.ts) — this one is for the
// main + engine processes. Reads ENV defensively so the module stays
// import-safe from the renderer bundle (which pulls in the port constants).
/** Every release channel, in promotion order. THE single source of truth: the
 *  `Channel` type, the runtime validator, and the per-channel port/scheme/data-dir
 *  maps all derive from this, so adding a channel is one edit here plus the maps
 *  that the compiler then forces you to complete. */
export const CHANNELS = ["dev", "alpha", "beta", "stable"] as const;

export type Channel = (typeof CHANNELS)[number];

/** Narrow an unknown env value to a Channel. */
export function isChannel(value: unknown): value is Channel {
  return (CHANNELS as readonly unknown[]).includes(value);
}

export function channel(): Channel {
  const raw =
    typeof process !== "undefined" && process.env ? process.env.ZEROS_CHANNEL : undefined;
  if (isChannel(raw)) return raw;

  // A value that is PRESENT but unrecognized is a BUG, and it must not be
  // absorbed. Resolving it to "stable" silently points the build at PRODUCTION's
  // data dir, engine port range, update feed and `zeros://` deep-link scheme —
  // i.e. one typo in ZEROS_CHANNEL turns a Beta or Alpha build into something that
  // reads and WRITES real user data. That is the exact cross-channel collision
  // #204 fixed, reintroduced with no signal anywhere.
  //
  // Throwing is safe here specifically because ZEROS_CHANNEL is never user input
  // on the happy path: apps/desktop/electron/main.ts seeds it from the compile-time bake before
  // anything reads it, and the renderer bundle sees `process.env` as absent (raw
  // === undefined → the fallback below, never this branch). So reaching here means
  // someone exported a bad value into the environment, which is precisely when we
  // want to stop rather than guess.
  if (raw !== undefined && raw !== "") {
    throw new Error(
      `[Zeros] ZEROS_CHANNEL="${raw}" is not a known channel ` +
        `(expected one of: ${CHANNELS.join(" | ")}). Refusing to start: falling ` +
        `back would silently use PRODUCTION's data directory, engine ports, ` +
        `update feed and zeros:// scheme. Unset ZEROS_CHANNEL or set it to a ` +
        `valid channel.`,
    );
  }

  // ABSENT is legitimate and must keep working: Production never sets
  // ZEROS_CHANNEL (release.yml bakes nothing, so main.ts falls through to this
  // signal), and a bare `pnpm serve:engine` / cloud sandbox has no channel either.
  return isDevRuntime() ? "dev" : "stable";
}

// ──────────────────────────────────────────────────────────
// Deep-link URL scheme (per channel) — single source of truth
// ──────────────────────────────────────────────────────────
// stable → zeros://   beta → zeros-beta://   dev → zeros-dev://
//
// One scheme PER channel so an installed Beta, a dev build, and Production each
// own a SEPARATE scheme and macOS LaunchServices routes a returning sign-in /
// invite / pair deep link to the EXACT app that started it. Before this, Beta
// (also packaged) registered the bare `zeros://` alongside Production, so a
// sign-in started in Production could resolve to Beta — the "Open Zeros Beta?"
// mis-route. Mirrors db/paths.ts's data-dir naming (stable → `zeros`, else
// `zeros-<channel>`), and is consumed by BOTH the Electron main deep-link
// handler (registers + validates) and the renderer (builds the /launch URL), so
// the scheme the web deep-links back with always matches what main accepts.
//
// Pure (no process.env read) so it is import-safe from the renderer bundle — the
// caller passes the channel it already resolved (main via channel(); renderer via
// its own build-time CHANNEL / the app_info IPC).
export type DeepLinkScheme =
  | "zeros"
  | "zeros-alpha"
  | "zeros-beta"
  | "zeros-dev";

export function schemeForChannel(ch: Channel): DeepLinkScheme {
  switch (ch) {
    case "alpha":
      return "zeros-alpha";
    case "beta":
      return "zeros-beta";
    case "dev":
      return "zeros-dev";
    default: // stable
      return "zeros";
  }
}

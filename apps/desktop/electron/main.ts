// ──────────────────────────────────────────────────────────
// Zeros Electron — main process entry
// ──────────────────────────────────────────────────────────
//
// Boot sequence:
//   1. registerIpcHandlers()         — install the `zeros:invoke` router
//   2. registerAllCommands()         — wire implemented commands
//   3. start PATH/engine/watchdog    — background, shared single-flight promise
//   4. createMainWindow()            — immediate BrowserWindow + preload
//   5. start updater                 — process-owned background service
//
// Shutdown:
//   - app.on("before-quit") → shutdown() kills the engine child,
//     stops the watchdog, clears state. Without this the Node
//     process outlives the window and holds port 24193.
//
// Window geometry migrated from the legacy native config:
//   1600x1000 default, 1200x700 min, hidden-inset title bar so app
//   content extends under the traffic lights.
// ──────────────────────────────────────────────────────────

// === EARLIEST TRACE (packaged app debug) ===
// Runs before any imports that could fail silently so we get at
// least one line in /tmp proving main.cjs executed. Remove after
// early-launch telemetry is no longer required.
try {
  // SECURITY: redact any zeros:// / zeros-dev:// / zeros-beta:// deep-link arg
  // before writing. On Windows/Linux cold-launch the URL lands in argv, and this
  // log is persistent (flag:"a"). Both bearer secrets ride in the #fragment — the
  // OAuth handoff `#ticket=…` and the pairing `#offer=…` — so redact from the
  // first `?` OR `#` (the old query-only redaction missed fragment-borne
  // secrets). The scheme match covers EVERY channel (zeros, zeros-<channel>) so a
  // Beta cold-launch doesn't leak its ticket just because this runs before
  // ZEROS_CHANNEL is seeded — over-matching a non-secret arg is harmless.
  const safeArgv = process.argv.map((a) =>
    /^zeros(-[a-z0-9]+)?:\/\//i.test(a)
      ? a.replace(/([?#]).*$/, "$1<redacted>")
      : a,
  );
  // SECURITY: a hardcoded "/tmp/zeros-boot.log" opened for APPEND is the classic
  // insecure-temp-file shape (CodeQL js/insecure-temporary-file). /tmp is shared
  // and world-writable, so on a multi-user machine any other local account can
  // pre-create that exact path as a SYMLINK and this append lands wherever the
  // link points — with the app's privileges. Three changes close it without
  // losing the trace:
  //   • O_NOFOLLOW  — refuse a path that is a symlink, instead of following it.
  //   • per-uid name — two accounts no longer contend for one file at all.
  //   • mode 0600    — the argv line (redacted, but still paths) stops being
  //                    world-readable, which it was under the default 0666&~umask.
  // os.tmpdir() replaces the literal /tmp so this is also correct off-macOS.
  // O_NOFOLLOW is POSIX-only and undefined on Windows; `?? 0` degrades to the
  // old behaviour there rather than throwing on the constant lookup.
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const bootLog = require("node:path").join(
    os.tmpdir(),
    `zeros-boot-${os.userInfo().uid}.log`,
  );
  const fd = fs.openSync(
    bootLog,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeSync(
      fd,
      `[${new Date().toISOString()}] main.cjs loaded, argv=${JSON.stringify(safeArgv)}\n`,
    );
  } finally {
    fs.closeSync(fd);
  }
} catch {
  // ignore — can't even write to the temp dir, or the path was a symlink we
  // refused to follow. Either way a boot trace is not worth failing launch over.
}

import {
  app,
  BrowserWindow,
  nativeImage,
  nativeTheme,
  screen,
  shell,
} from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerIpcHandlers } from "./ipc/router";
import { registerIframeSessionCommands } from "./ipc/iframe-session";
import { registerIframePickerCommands } from "./ipc/iframe-picker";
import { installIframeHeaderStripping } from "./iframe-headers";
import { registerAllCommands } from "./ipc/commands";
import {
  readPersistedAppearanceMode,
  readPersistedWindowBackground,
} from "./ipc/commands/window";
import { nativeThemeSourceForAppearanceMode } from "./appearance-mode";
import {
  attachWindowStatePersistence,
  boundsVisibleOnAnyDisplay,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  readPersistedWindowState,
} from "./window-state";
import { setMainWindow, emitEvent } from "./ipc/events";
import {
  defaultProjectRoot,
  shutdown as shutdownSidecar,
  setEngineSpawnBarrier,
  spawnEngine,
  startEngineCodeWatcher,
  startWatchdog,
  pushGithubCredentialToEngine,
} from "./sidecar";
import { installAppMenu } from "./menu";
import { appendLogRecord, flushLogStore, initLogStore } from "./log-store";
import { setupContextMenu } from "./context-menu";
import { installDevToolsGuard } from "./devtools";
import { setupDeepLink } from "./deep-link";
import { setupUpdater } from "./updater";
import { IS_DEV, IS_PACKAGED } from "./runtime-mode";
import { watchSecrets } from "./secret-store";
import { setTokenStore as setGithubTokenStore } from "../src/engine/git/github";
import {
  githubSelectedTokenStore,
  initializeGithubCredentialStore,
} from "./github-auth-runtime";
import {
  handleSharedGithubCredentialChange,
  initializeGithubAppFlow,
  scheduleGithubAppRefresh,
} from "./github-app-flow";
import { onMainAuthSessionChanged } from "./ipc/commands/auth-session";
import {
  appIdentity,
  zerosChannelDataDir,
  zerosDataDir,
} from "../src/engine/db/paths";
// CHANNELS/isChannel only — importing the runtime module is side-effect-free, so
// this cannot read ZEROS_CHANNEL before the seeding block below sets it.
import { CHANNELS, isChannel, type Channel } from "../src/engine/runtime";
import { migrateElectronIdentity } from "./migrate-identity";
import {
  installDesignProtocol,
  registerDesignProtocolPrivileges,
} from "./design-protocol";

// Custom schemes must be privileged before Electron reaches ready. The handler
// itself is installed after ready, before the first renderer window loads.
registerDesignProtocolPrivileges();

// Release channel baked at electron:compile time by apps/desktop/electron/tsup.config.ts's
// `define`. "" in a normal dev compile; "beta" when the beta release workflow
// sets ZEROS_CHANNEL for the compile step. Seeded into process.env below so the
// engine + db/paths.ts resolve the SAME channel.
declare const __ZEROS_CHANNEL_BAKED__: string | undefined;

// ──────────────────────────────────────────────────────────
// Per-worktree dev instance identity (ZEROS_INSTANCE)
// ──────────────────────────────────────────────────────────
// scripts/dev-instance.mjs derives ONE name from the git worktree (or an
// explicit $ZEROS_INSTANCE) and exports it so a `pnpm electron:dev` in each
// git worktree is its OWN app — distinct name, userData, Chromium cache,
// engine data dir (com.zeros.dev.<slug>, resolved in apps/desktop/src/engine/db/paths.ts),
// and single-instance lock (Chromium keys the lock off userData, so a
// per-instance userData makes the lock per-instance too → instances coexist).
// Empty for the primary checkout, which keeps the plain "Zeros Dev" identity.
// The slug is filesystem-/reverse-DNS-safe. INSTANCE_LABEL (a titleized form) is
// retained ONLY for the one-time legacy-userData migration below; the user-visible
// Dock + window name is INSTANCE_NAME ("zeros-<worktree>"). Kept in sync with
// db/paths.ts devInstanceSlug().
const INSTANCE_SLUG = (process.env.ZEROS_INSTANCE ?? "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, "-")
  .replace(/^[-._]+|[-._]+$/g, "")
  .slice(0, 40);
const INSTANCE_LABEL = INSTANCE_SLUG
  ? INSTANCE_SLUG.replace(/[-._]+/g, " ").replace(/\b\w/g, (c) =>
      c.toUpperCase(),
    )
  : "";
// The Dock/window name for this instance. The launcher (scripts/dev-instance.mjs)
// passes "zeros-<worktree>" via ZEROS_INSTANCE_NAME; fall back to deriving it from
// the slug for a bare launch. Empty for the primary checkout (plain "Zeros Dev").
const INSTANCE_NAME =
  (process.env.ZEROS_INSTANCE_NAME ?? "").trim() ||
  (INSTANCE_SLUG ? `zeros-${INSTANCE_SLUG}` : "");

// ──────────────────────────────────────────────────────────
// Dev / prod separation  +  ONE application identity (the crux)
// ──────────────────────────────────────────────────────────
// `pnpm electron:dev` runs an unpackaged app; it must behave like a distinct
// "Zeros Dev" application so it never shares state with a packaged
// /Applications/Zeros.app. This block establishes the SINGLE identity that drives
// EVERYTHING for this (channel, instance) — the engine DB, Electron's userData
// (secrets.json + app-settings.json + the Chromium Singleton lock), the Chromium
// cache, and the logs — all under ONE reverse-DNS id: com.zeros[.dev|.beta][.<slug>].
// This ends the historical 3-way split (com.zeros.* DB vs name-based
// "Zeros — <Label>" userData/secrets/keychain vs design.zeros.app.* caches).
//
// It must run BEFORE anything reads app.getName()/app.getPath("userData") — deep
// link setup, log init, window construction — and before app.ready.
//
// ORDER IS LOAD-BEARING (must precede the first zerosDataDir()/appIdentity() call,
// since those resolve channel()+devInstanceSlug() from these env vars):
//   1. ZEROS_DEV      — so isDevRuntime()/channel() resolve dev
//   2. ZEROS_CHANNEL  — so channel() resolves before any data-dir call
//   3. THEN compute identity from zerosDataDir()/appIdentity()
const explicitDevEnv =
  process.env.ZEROS_DEV === "1" || process.env.ZEROS_RUNTIME_MODE === "dev";
const runningDev = IS_DEV || explicitDevEnv;

// (1) ZEROS_DEV — the engine (spawned sidecar OR imported in-process) resolves its
// data dirs purely from env (apps/desktop/src/engine/runtime.ts isDevRuntime()); seed it so
// BOTH writers agree before any engine code or spawnEngine runs (sidecar inherits
// it via {...process.env}). Without it a dev run would write the packaged build's
// zeros.db / ~/zeros/workspaces, trampling real user data.
if (runningDev) process.env.ZEROS_DEV = "1";

// (2) ZEROS_CHANNEL — travels by env so the spawned engine AND every in-process
// db/paths.ts caller resolve the SAME channel. Seed ONCE, before any data-dir /
// updater code: explicit env wins; else the value baked at electron:compile
// (release workflows set it); else the dev/packaged signal.
//
// A set-but-INVALID value is rejected here rather than absorbed. The old form was
// `if (!process.env.ZEROS_CHANNEL) { … }`, which skipped the whole block when the
// var was set to anything non-empty — so a typo'd `ZEROS_CHANNEL=betaa` survived
// untouched, and channel() then resolved it to "stable". That silently pointed the
// build at PRODUCTION's data dir, engine ports, update feed and zeros:// scheme.
// Fail here, at boot, where the message is greppable in main.log, instead of
// letting a mislabeled build read and write real user data.
{
  const fromEnv = process.env.ZEROS_CHANNEL;
  if (fromEnv !== undefined && fromEnv !== "" && !isChannel(fromEnv)) {
    throw new Error(
      `[Zeros] ZEROS_CHANNEL="${fromEnv}" is not a known channel ` +
        `(expected one of: ${CHANNELS.join(" | ")}). Unset it or fix the value.`,
    );
  }
  if (!fromEnv) {
    const baked =
      typeof __ZEROS_CHANNEL_BAKED__ === "string"
        ? __ZEROS_CHANNEL_BAKED__
        : "";
    process.env.ZEROS_CHANNEL = isChannel(baked)
      ? baked
      : runningDev
        ? "dev"
        : "stable";
  }
}

// (3) One identity for EVERY channel. app.getName() is pinned to the CHANNEL name
// only — NEVER the per-worktree slug — so macOS safeStorage derives ONE keychain
// key per channel ("Zeros Dev Safe Storage"), shared by every dev worktree. The
// human worktree label is cosmetic: it drives the window title + Dock tooltip only
// (see WINDOW_TITLE), never userData/app.getName()/the keychain.
// A total Record keyed on Channel, so adding a channel is a COMPILE ERROR here
// rather than silently inheriting Production's name — which would also silently
// share Production's safeStorage keychain key ("Zeros Safe Storage") and sign the
// new channel's users into the wrong secret store.
const CHANNEL_DISPLAY_NAME: Record<Channel, string> = {
  dev: "Zeros Dev",
  alpha: "Zeros Alpha",
  beta: "Zeros Beta",
  stable: "Zeros",
};
const CHANNEL_NAME = isChannel(process.env.ZEROS_CHANNEL)
  ? CHANNEL_DISPLAY_NAME[process.env.ZEROS_CHANNEL]
  : runningDev
    ? CHANNEL_DISPLAY_NAME.dev
    : CHANNEL_DISPLAY_NAME.stable;
const WINDOW_TITLE = INSTANCE_NAME || CHANNEL_NAME;

// One-time relocation of any legacy name-based Electron state into the new id dir
// (best-effort, marker-guarded). Runs with LITERAL legacy names BEFORE the setPath
// below changes what getPath() returns. Secrets are NOT migrated (old per-name key
// can't decrypt into the new shared key → one-time re-login, per the agreed
// decision); the Chromium session regenerates.
try {
  migrateElectronIdentity({
    appDataDir: app.getPath("appData"),
    newUserData: zerosDataDir(),
    legacyChannelName: CHANNEL_NAME,
    legacyInstanceName: INSTANCE_LABEL ? `Zeros — ${INSTANCE_LABEL}` : null,
  });
} catch (err) {
  console.warn("[Zeros] identity migration skipped:", err);
}

// Redirect Electron's OWN userData to the SAME id dir the engine uses for the DB.
// THE crux: secrets.json / app-settings.json / the Chromium Singleton lock now
// live beside zeros.db under com.zeros[.dev|.beta][.<slug>], ending the split
// where they fell into the name-based "Zeros — <Label>" default. Per-instance
// userData also keeps each dev worktree's Singleton lock distinct → windows
// coexist (the single-instance lock in deep-link.ts keys off userData).
app.setName(CHANNEL_NAME);
app.setPath("userData", zerosDataDir());

// (dev) Shared login: point secrets at the channel-PRIMARY dir (com.zeros.dev),
// so every worktree shares ONE secrets.json — decrypted by the ONE per-channel
// keychain key above → log in once, every worktree authed. ZEROS_ISOLATE=1 opts a
// worktree OUT (its secrets stay in its own per-instance userData). Only
// meaningful in dev (stable/beta have a single instance where the two dirs
// coincide). Set before secret-store or spawnEngine read it.
if (process.env.ZEROS_CHANNEL === "dev" && process.env.ZEROS_ISOLATE !== "1") {
  process.env.ZEROS_SHARED_SECRETS_DIR = zerosChannelDataDir();
}

// ──────────────────────────────────────────────────────────
// Chromium cache → ~/Library/Caches (macOS-correct, purgeable)
// ──────────────────────────────────────────────────────────
// Electron parks Chromium's ENTIRE session profile — the HTTP `Cache`,
// the V8 `Code Cache`, `GPUCache`/Dawn shader caches, plus Local
// Storage / IndexedDB / Cookies — under `sessionData`, which itself
// defaults to `userData` (= ~/Library/Application Support/<app>). That
// strands hundreds of MB of *regenerable* cache in the backed-up,
// never-purged location: Time Machine copies it, iCloud/migration
// drags it along, and macOS never reclaims it under disk pressure.
//
// macOS intends ~/Library/Caches/<id> for exactly this — auto-excluded
// from Time Machine, evicted by the OS when disk is low. A Tauri/WebKit
// app gets this split for free; Electron does not unless we redirect,
// because Chromium ignores app.getPath("cache").
//
// We move the whole session profile there. Safe because: our Local
// Storage is an engine-backed boot cache (loss = slower cold start, not
// data loss); secrets live in <userData>/secrets.json (written via
// getPath("userData"), untouched here); and the engine's zeros.db
// resolves its own path (com.zeros), independent of sessionData.
//
// To avoid a one-time loss of renderer state that is NOT engine-backed
// (composer drafts, theme, UI state) we copy the durable storage
// subdirs old→new once, then reclaim the orphaned cache dirs so the
// ~430 MB is actually freed for existing installs. Marker-guarded and
// idempotent. Must run before app.whenReady().
function relocateChromiumCache(): void {
  // Bound the HTTP disk cache so it can't grow without limit (250 MB).
  app.commandLine.appendSwitch("disk-cache-size", String(250 * 1024 * 1024));

  // getPath("cache") = ~/Library/Caches (macOS), ~/.cache (Linux),
  // %LOCALAPPDATA% (Windows). Keep dev isolated from prod.
  // Electron resolves "cache" at runtime but omits it from getPath()'s typed
  // name union; the suppression bridges that gap (and self-removes if the types
  // ever add it). See the cache-relocation doctrine.
  // @ts-expect-error - "cache" is a valid runtime path name, absent from the types.
  const cacheRoot = app.getPath("cache");
  // New: cache/session under the SAME reverse-DNS id as userData + the DB
  // (com.zeros[.dev|.beta][.<slug>]) — the design.zeros.* scheme is retired, so a
  // logical instance is ONE identifier across Application Support, Caches + Logs.
  const newSessionData = path.join(cacheRoot, appIdentity());

  // Legacy source under the RETIRED design.zeros.* scheme — migrate durable
  // renderer state (composer drafts / theme / Local Storage) forward ONCE. Named
  // by its LITERAL old value: app.getPath("sessionData") now resolves to the
  // fresh new userData (the Phase-1 redirect ran above), so it can't be the source.
  const ch = process.env.ZEROS_CHANNEL;
  const legacyBase =
    ch === "dev"
      ? "design.zeros.app.dev"
      : ch === "beta"
        ? "design.zeros.beta"
        : "design.zeros.app";
  const legacyDirName =
    ch === "dev" && INSTANCE_SLUG
      ? `${legacyBase}.${INSTANCE_SLUG}`
      : legacyBase;
  const oldSessionData = path.join(cacheRoot, legacyDirName);
  if (path.resolve(oldSessionData) === path.resolve(newSessionData)) {
    app.setPath("sessionData", newSessionData);
    return;
  }

  try {
    fs.mkdirSync(newSessionData, { recursive: true });
  } catch (err) {
    // Leave the default profile in place rather than risk a broken one.
    console.error(`[Zeros] cache: cannot create ${newSessionData}:`, err);
    return;
  }

  // Durable renderer state we preserve across the move; the cache dirs
  // we deliberately abandon (they regenerate) and reclaim from old.
  const DURABLE = [
    "Local Storage",
    "Session Storage",
    "IndexedDB",
    "Cookies",
    "Cookies-journal",
    "WebStorage",
    "SharedStorage",
    "SharedStorage-wal",
  ];
  const REGENERABLE = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnWebGPUCache",
    "DawnGraphiteCache",
    "Shared Dictionary",
    "VideoDecodeStats",
  ];

  const marker = path.join(newSessionData, ".zeros-session-migrated");
  const isFreshInstall = !fs.existsSync(
    path.join(oldSessionData, "Local Storage"),
  );
  if (!fs.existsSync(marker) && !isFreshInstall) {
    for (const sub of DURABLE) {
      const src = path.join(oldSessionData, sub);
      const dest = path.join(newSessionData, sub);
      try {
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
          fs.cpSync(src, dest, { recursive: true });
        }
      } catch (err) {
        console.error(`[Zeros] cache: copy "${sub}" failed:`, err);
      }
    }
    // Free the ~430 MB of orphaned cache from Application Support.
    for (const sub of REGENERABLE) {
      try {
        fs.rmSync(path.join(oldSessionData, sub), {
          recursive: true,
          force: true,
        });
      } catch {
        /* best-effort reclaim */
      }
    }
  }
  try {
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* best-effort; the per-dir existence guard keeps copies idempotent */
  }

  app.setPath("sessionData", newSessionData);
  console.log(`[Zeros] sessionData → ${newSessionData} (cache now purgeable)`);
}
relocateChromiumCache();

const APP_LABEL = app.getName(); // "Zeros" in prod, "Zeros Dev" in dev
// Surface the resolved mode so a misconfigured launch is visible, never silent.
console.log(
  `[Zeros] launch mode: ${runningDev ? "dev (Zeros Dev)" : "prod (Zeros)"} · packaged=${IS_PACKAGED} · ZEROS_DEV=${process.env.ZEROS_DEV ?? "(unset)"}`,
);

// Packaged GUI apps detach from the terminal so `console.log` /
// `console.error` vanish. To debug production startup, mirror
// everything into a rotating log file under the user's app-data
// directory. Tail it with:
//   tail -f ~/Library/Logs/com.zeros/main.log       # stable
//   tail -f ~/Library/Logs/com.zeros.beta/main.log  # beta
//   tail -f ~/Library/Logs/com.zeros.dev/main.log   # primary dev
function setupLogFile(): void {
  // Logs under the same id as userData/cache. macOS → ~/Library/Logs/<id>;
  // other platforms keep logs beside the data dir.
  const logDir =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Logs", appIdentity())
      : path.join(zerosDataDir(), "logs");
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    /* can't make the log dir — nothing to do */
    return;
  }
  // Structured sibling of main.log — every line below is ALSO appended to
  // <logDir>/app.jsonl as a structured JSON record (see log-store.ts).
  // That store is what the feedback form's "Include recent app logs" shares
  // and what its View button opens.
  initLogStore(logDir);
  const logPath = path.join(logDir, "main.log");
  // Rotation: an append-only log can't be allowed to grow without bound, and a
  // boot-time check alone provably isn't enough — the primary main.log reached
  // 29 MB / 305k lines during ONE engine-respawn storm, i.e. entirely within a
  // single session, which is both unreadable and unshippable in a bug report.
  // So the cap is enforced twice (keeping ONE previous generation, main.log.1,
  // each time — same policy as log-store.ts rotateIfNeeded):
  //   • at boot, below — reclaims growth left over from prior sessions;
  //   • mid-session, in safeWrite — bytes are counted through the write stream
  //     and the file rolls the moment the count crosses the cap.
  const MAX_LOG_BYTES = 8 * 1024 * 1024;
  let logBytes = 0;
  try {
    logBytes = fs.statSync(logPath).size;
    if (logBytes > MAX_LOG_BYTES) {
      fs.renameSync(logPath, `${logPath}.1`); // overwrites any prior .1
      logBytes = 0;
    }
  } catch {
    /* no existing log yet, or rename raced — the open below handles it;
       logBytes keeps the statted size (if any) so safeWrite retries the roll */
  }
  let stream = fs.createWriteStream(logPath, { flags: "a" });
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const stamp = () => new Date().toISOString();

  /** Best-effort write to the log stream, rolling the file once the byte
   *  count crosses MAX_LOG_BYTES (the mid-session half of the rotation policy
   *  above). The stream can briefly fail during process teardown (writeStream
   *  end mid-flush); swallow the error so a logging call never crashes the
   *  process. */
  const safeWrite = (line: string): void => {
    try {
      stream.write(line);
      logBytes += Buffer.byteLength(line, "utf8");
      if (logBytes > MAX_LOG_BYTES) {
        try {
          // end() flushes the old stream's buffered tail asynchronously into
          // its (still-open) fd — after the rename below, that tail lands in
          // main.log.1, the generation those lines belong to.
          stream.end();
          fs.renameSync(logPath, `${logPath}.1`); // overwrites any prior .1
          logBytes = 0;
        } catch {
          /* rename raced/failed — logBytes stays over the cap, so the next
             write retries the roll (mirrors log-store.ts rotateIfNeeded) */
        }
        // Reopen unconditionally: the old stream is ended (or wedged) either
        // way, and `a` creates the fresh file after a successful rename.
        stream = fs.createWriteStream(logPath, { flags: "a" });
      }
    } catch {
      /* logging is best-effort */
    }
  };

  /** Best-effort write to the original console method. Electron + dev
   *  setups can close stdout/stderr underneath us (electronmon
   *  restarts, orphan-process leftovers from a previous crashed
   *  session, etc.); the resulting EPIPE used to surface as Electron's
   *  "encountered an error" dialog. Swallow it. The log file already
   *  has the message. */
  const safeConsole = (
    fn: (...a: unknown[]) => void,
    args: unknown[],
  ): void => {
    try {
      fn(...args);
    } catch {
      /* terminal pipe is closed — only the log file matters at this point */
    }
  };

  /** Mirror a console line into the structured app.jsonl store. Engine
   *  sidecar output arrives here already prefixed "[engine] " (sidecar.ts
   *  forwardLines), so it can be attributed to its real origin. appendLogRecord
   *  never throws and never calls console.* — no re-entrancy risk. */
  const record = (
    level: "log" | "info" | "warn" | "error",
    args: unknown[],
  ) => {
    const text = args.map(String).join(" ");
    appendLogRecord({
      origin: text.startsWith("[engine] ") ? "engine" : "main",
      level,
      text,
    });
  };

  console.log = (...args: unknown[]) => {
    safeWrite(`[${stamp()}] ${args.map(String).join(" ")}\n`);
    record("log", args);
    safeConsole(origLog, args);
  };
  console.error = (...args: unknown[]) => {
    safeWrite(`[${stamp()}] ERROR ${args.map(String).join(" ")}\n`);
    record("error", args);
    safeConsole(origErr, args);
  };
  // console.info / console.warn were NOT mirrored to the file before, so in
  // packaged builds anything logged at those levels (notably electron-updater's
  // default info-level logging) vanished. Capture them too.
  console.info = (...args: unknown[]) => {
    safeWrite(`[${stamp()}] ${args.map(String).join(" ")}\n`);
    record("info", args);
    safeConsole(origInfo, args);
  };
  console.warn = (...args: unknown[]) => {
    safeWrite(`[${stamp()}] WARN ${args.map(String).join(" ")}\n`);
    record("warn", args);
    safeConsole(origWarn, args);
  };
  // Surface unhandled errors into the log — otherwise the app dies
  // silently and we have no trace. The handlers are also a Node-level
  // guard: with these registered, the process won't terminate on an
  // uncaughtException (Electron still shows a dialog by default — we
  // address that separately via electron.app's own error events).
  process.on("uncaughtException", (err) => {
    safeWrite(`[${stamp()}] UNCAUGHT ${err.stack ?? err.message ?? err}\n`);
    appendLogRecord({
      origin: "main",
      level: "error",
      text: `UNCAUGHT ${String(err.stack ?? err.message ?? err)}`,
      tags: ["crash"],
    });
    // Relay to the renderer so PostHog error tracking sees main-process
    // crashes (drops silently if the window isn't up yet). App-internal
    // stack only — no user content. See apps/desktop/src/renderer/platform/observability/analytics/boot.tsx.
    emitEvent("main-process-error", {
      source: "uncaughtException",
      name: err?.name,
      message: err?.message ?? String(err),
      stack: err?.stack,
    });
  });
  process.on("unhandledRejection", (reason) => {
    safeWrite(`[${stamp()}] UNHANDLED ${String(reason)}\n`);
    appendLogRecord({
      origin: "main",
      level: "error",
      text: `UNHANDLED ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
      tags: ["crash"],
    });
    emitEvent("main-process-error", {
      source: "unhandledRejection",
      name: reason instanceof Error ? reason.name : undefined,
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
  // Defend against piped-stdout EPIPE storms — if the parent pipe
  // closes, stdout writes start throwing EPIPE on every console.log
  // call. Listening for 'error' on the streams prevents Node's
  // default behavior of crashing the process when a write fails.
  try {
    process.stdout.on("error", () => {
      /* parent pipe closed — silent */
    });
    process.stderr.on("error", () => {
      /* parent pipe closed — silent */
    });
  } catch {
    /* nothing to do */
  }
  console.log(
    `[${APP_LABEL}] main log: ${logPath} | packaged=${IS_PACKAGED} cwd=${process.cwd()}`,
  );
}

setupLogFile();

// Attributable memory telemetry. The engine self-logs `[Zeros mem]` for its OWN
// rss, but nothing logged the RENDERER / GPU / utility processes — so when the
// process tree spiked (the reported ~6 GB) there was no way to tell which
// process grew. app.getAppMetrics() is a built-in that returns per-process
// memory for THIS app's whole Chromium tree with NO subprocess spawn; we roll it
// up per type every 10 min so the next spike is decomposable straight from
// main.log. (Sibling engine/vite/tsup processes are separate programs and don't
// show here — `pnpm doctor` covers the full cross-process census.)
function startProcessMetricsLogger(): void {
  const emit = (): void => {
    try {
      const metrics = app.getAppMetrics();
      let totalMb = 0;
      const byType = new Map<string, { n: number; mb: number }>();
      for (const m of metrics) {
        const mb = (m.memory?.workingSetSize ?? 0) / 1024; // KB → MB
        totalMb += mb;
        const t = m.type || "unknown";
        const cur = byType.get(t) ?? { n: 0, mb: 0 };
        cur.n += 1;
        cur.mb += mb;
        byType.set(t, cur);
      }
      const parts = [...byType.entries()]
        .sort((a, b) => b[1].mb - a[1].mb)
        .map(([t, v]) => `${t}=${v.n}/${v.mb.toFixed(0)}MB`)
        .join(" ");
      console.log(`[Zeros procmem] total=${totalMb.toFixed(0)}MB ${parts}`);
    } catch {
      /* getAppMetrics can throw very early / during teardown — best-effort */
    }
  };
  emit();
  const id = setInterval(emit, 600_000);
  if (typeof id.unref === "function") id.unref();
}

// Pinned to the Mac-app Vite port (see vite.config.ts). Must NOT be
// 5173 — that's the default Vite port other Zeros workspace projects
// (apps/marketing, etc.) inherit. If those were running first, a
// 5173 default here would silently load THEIR home page as the Mac
// app. strictPort on both ends now blocks that, but the explicit
// mismatch keeps the failure mode obvious.
const DEV_URL = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5193";
const isDev = IS_DEV;

function createMainWindow(): BrowserWindow {
  // Durable theme mode (userData appearance.json — see ipc/commands/window.ts).
  // Two consumers on the create path:
  //   1. nativeTheme.themeSource — native context menus/dialogs follow the APP
  //      polarity from the first frame. Preserve "system" so the renderer's
  //      matchMedia-based resolution keeps seeing real OS flips; map Orka black
  //      to native dark. Left untouched on a fresh install (null) — the renderer
  //      reports its mode right after boot.
  //   2. additionalArguments — hands the mode to the preload, which exposes it
  //      to the page so the index.html pre-paint stamp and the appearance store
  //      can restore the theme when the Caches-backed localStorage was purged.
  const persistedMode = readPersistedAppearanceMode();
  const persistedNativeThemeSource = persistedMode
    ? nativeThemeSourceForAppearanceMode(persistedMode)
    : null;
  if (
    persistedNativeThemeSource &&
    nativeTheme.themeSource !== persistedNativeThemeSource
  ) {
    nativeTheme.themeSource = persistedNativeThemeSource;
  }

  // Reopen the window the way it was closed (userData window-state.json,
  // written by attachWindowStatePersistence below). Fresh install → no
  // file → the fixed defaults, OS-centered. A remembered position is
  // dropped when it no longer lands on an attached display (monitor
  // unplugged since last run); the size still restores.
  const windowState = readPersistedWindowState(app.getPath("userData"));
  const restoredBounds = windowState?.bounds ?? null;
  const restoredPosition =
    restoredBounds &&
    boundsVisibleOnAnyDisplay(
      restoredBounds,
      screen.getAllDisplays().map((d) => d.workArea),
    )
      ? { x: restoredBounds.x, y: restoredBounds.y }
      : null;

  const win = new BrowserWindow({
    width: restoredBounds?.width ?? 1600,
    height: restoredBounds?.height ?? 1000,
    ...(restoredPosition ?? {}),
    // minWidth keeps all three primary surfaces visible at the floor:
    //   repository navigation: 248 px fixed
    //   conversation: 320 px hard min (renderer/shell/conversation/conversation-pane.tsx)
    //   workbench: 200 px hard min (renderer/shell/workbench/workbench-pane.tsx)
    //   sum: 768 px + 32 px scrollbar/border breathing room → 800.
    // The constants live in window-state.ts so the restored-size clamp
    // and the live window floor can never disagree.
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    // Window title carries the per-worktree label (or channel name) so users can
    // tell dev worktrees / dev / prod apart at a glance. Cosmetic ONLY — it never
    // feeds the app identity or the keychain (see WINDOW_TITLE above).
    title: WINDOW_TITLE,
    titleBarStyle: "hiddenInset",
    // Traffic-light vertical position is shared by EVERY surface that can own
    // the window's left edge: repository navigation, the conversation top bar
    // when navigation is hidden, and the Settings header. All are a full-bleed 40px h-10 top
    // band. y=12 sits the ~12px buttons' midline at ~18-19 — a touch ABOVE
    // the strip's geometric center (20), which optically matches the icon
    // glyphs beside them; y=14 reads about 2px low next to the
    // repository-navigation toggle. x=19 keeps them clear of the window's left edge.
    trafficLightPosition: { x: 19, y: 12 },
    // Pre-paint background. Tracks the app theme: the renderer reports
    // the resolved --bg1 via `window_set_background` on every theme
    // change, and the persisted value is used here so a light-theme
    // user doesn't get a dark flash at launch (and vice versa).
    backgroundColor: readPersistedWindowBackground(
      persistedMode,
      nativeTheme.shouldUseDarkColors,
    ),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox ON — the preload uses only contextBridge/ipcRenderer (both
      // sandbox-safe), so a renderer XSS can't escalate to Node/RCE.
      sandbox: true,
      // Durable theme-mode handoff to the preload (see persistedMode above).
      ...(persistedMode
        ? { additionalArguments: [`--zeros-appearance-mode=${persistedMode}`] }
        : {}),
    },
  });

  // Finish the reopen-as-closed restore: the discrete states can't be
  // constructor options. macOS fullscreen (the green button / its own
  // Space) wins over maximized (title-bar double-click zoom) — both
  // flags can be true in a stale file, and fullscreen is the one the
  // user last SAW. Then keep the state file current for this window's
  // whole life (debounced on resize/move, immediate on state flips and
  // close), so the NEXT launch — including the macOS dock-activate
  // reopen, which also runs createMainWindow — picks it up.
  if (windowState?.fullScreen) win.setFullScreen(true);
  else if (windowState?.maximized) win.maximize();
  attachWindowStatePersistence(win, app.getPath("userData"));

  // Strip X-Frame-Options and CSP
  // frame-ancestors so browser-tab iframes can load arbitrary URLs.
  // See apps/desktop/electron/iframe-headers.ts for the rationale.
  installIframeHeaderStripping(win.webContents.session);

  // Deny sensitive permissions (camera/mic/geolocation/clipboard-read) to
  // browser-tab iframe content. Electron's default approves most requests, so a
  // visited page could otherwise read the clipboard or activate the camera with
  // no prompt. The APP's own document (file:// / dev server) keeps full access.
  const isAppOrigin = (url: string | undefined): boolean =>
    !url ||
    url === "null" ||
    url.startsWith("file://") ||
    url.startsWith(DEV_URL);
  const SENSITIVE_PERMS = new Set([
    "media",
    "camera",
    "microphone",
    "geolocation",
    "clipboard-read",
    "clipboard-sanitized-write",
    "midi",
    "midiSysex",
    "hid",
    "serial",
    "usb",
  ]);
  win.webContents.session.setPermissionRequestHandler(
    (_wc, permission, callback, details) => {
      if (isAppOrigin(details?.requestingUrl)) {
        callback(true);
        return;
      }
      callback(!SENSITIVE_PERMS.has(permission));
    },
  );
  win.webContents.session.setPermissionCheckHandler(
    (_wc, permission, requestingOrigin) => {
      if (isAppOrigin(requestingOrigin)) return true;
      return !SENSITIVE_PERMS.has(permission);
    },
  );

  // Defense-in-depth: the renderer must never navigate away from the app or
  // spawn new windows. A vetted external http(s) link opens in the real browser
  // via shell.openExternal; everything else is denied. (Browser-tab content is
  // <iframe>, not window.open, so this doesn't touch it.)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    // Allow only the app's own document (dev server / packaged file://).
    if (url.startsWith(DEV_URL) || url.startsWith("file://")) return;
    event.preventDefault();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
  });

  // CSP for the app's OWN document (packaged file:// only — the dev server needs
  // eval/inline/ws for HMR, and is the developer's own machine). Permissive on
  // script/style/connect-to-https so the Vite bundle, inline styles, the control plane,
  // PostHog and the relay all keep working, but locks the sinks an XSS would
  // reach for: no <object>/<embed>, no <base> hijack, no framing of the app, no
  // plain-http/data: exfil channel. Low-risk hardening layered under sandbox +
  // contextIsolation + the preload allowlist.
  if (IS_PACKAGED) {
    const CSP = [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "media-src 'self' blob: data:",
      "connect-src 'self' https: wss: ws://127.0.0.1:* ws://localhost:*",
      "worker-src 'self' blob:",
      "frame-src 'self' https: http: data: blob: about: zeros-design:",
      "child-src 'self' https: http: blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
    win.webContents.session.webRequest.onHeadersReceived(
      { urls: ["file://*/*"] },
      (details, callback) => {
        // Only the top app document — not sub-resources or browser-tab frames.
        if (details.resourceType !== "mainFrame") {
          callback({ cancel: false });
          return;
        }
        const headers = { ...(details.responseHeaders ?? {}) };
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === "content-security-policy") delete headers[k];
        }
        headers["Content-Security-Policy"] = [CSP];
        callback({ cancel: false, responseHeaders: headers });
      },
    );
  }

  // DevTools policy. Packaged builds USED to force-close DevTools on the same
  // tick it opened, which is why ⌥⌘I flickered and did nothing in Alpha, Beta
  // and Production. That block is gone — DevTools now works on every channel,
  // opens detached, and Production prints a self-XSS console banner instead.
  // apps/desktop/electron/devtools.ts states the security trade in full, including what the
  // old block did buy and how to re-gate Production deliberately if wanted.
  installDevToolsGuard(win);

  // 2026-05-28: swallow Cmd+R / Cmd+Shift+R / F5 at the BrowserWindow
  // level. Removing the menu items in apps/desktop/electron/menu.ts blocks the
  // application menu's accelerators, but Chromium itself still
  // honours these keystrokes by default — the user would still see
  // their session disappear if they happened to press Cmd+R. We have
  // no use case for a renderer-only reload; auto-updates restart the
  // whole app, which is the canonical fresh-state flow.
  //
  // 2026-07-14: plain Cmd+R (no shift/alt) is REPURPOSED as the "run the
  // default run action" shortcut. Chromium's reload stays swallowed
  // (preventDefault keeps the event from the page too); the keystroke is
  // forwarded to the renderer as a zeros event instead — the run control
  // subscribes via nativeListen("run-shortcut"). Cmd+Shift+R / F5 stay dead.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    const reloadKey = key === "r" && (input.meta || input.control);
    const f5Key = input.key === "F5";
    if (reloadKey || f5Key) {
      event.preventDefault();
      // Only the platform's PRIMARY chord runs (⌘R on macOS, Ctrl+R
      // elsewhere) — on a Mac, Ctrl+R is a common in-terminal keystroke
      // (shell reverse-i-search) and must stay merely swallowed.
      const primary =
        process.platform === "darwin"
          ? input.meta && !input.control
          : input.control && !input.meta;
      if (reloadKey && primary && !input.shift && !input.alt) {
        emitEvent("run-shortcut", {});
      }
    }
  });

  if (isDev) {
    // The dev renderer is served by Vite on :5193. Vite restarts its
    // dev server whenever vite.config.ts (or a config dependency)
    // changes, and an active editing / parallel-agent session triggers
    // that repeatedly. For the ~0.5–1.5 s the server is down, any
    // navigation to DEV_URL fails with ERR_CONNECTION_REFUSED and the
    // window is stranded on a blank black page. Cmd+R / F5 are
    // intentionally swallowed above, so without an automatic retry the
    // user has no way back short of quitting and relaunching — which is
    // exactly the "goes black during development" failure we hit.
    // Retry the load with capped backoff until Vite answers again so
    // the renderer self-heals across every restart.
    let devReloadTimer: ReturnType<typeof setTimeout> | null = null;
    let devReloadDelay = 250;
    const DEV_RELOAD_MAX_DELAY = 2000;
    const loadDevRenderer = (): void => {
      // loadURL rejects when the navigation fails; that rejection is
      // handled by the did-fail-load listener below. The .catch only
      // suppresses the otherwise-unhandled promise rejection.
      win.loadURL(DEV_URL).catch(() => {});
    };
    win.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // Recover only the top-level Mac-app document. Workbench browser
        // tabs are <iframe>s that legitimately fail to load arbitrary
        // URLs — never hijack those navigations.
        if (!isMainFrame) return;
        if (!validatedURL.startsWith(DEV_URL)) return;
        // -3 (ERR_ABORTED) means a newer navigation superseded this one
        // (our own retry, or an HMR-driven reload) — not a real failure.
        if (errorCode === -3) return;
        if (win.isDestroyed()) return;
        console.warn(
          `[Zeros] dev renderer load failed (${errorCode} ${errorDescription}) — ` +
            `Vite is likely restarting; retrying in ${devReloadDelay}ms`,
        );
        if (devReloadTimer) clearTimeout(devReloadTimer);
        devReloadTimer = setTimeout(() => {
          devReloadTimer = null;
          if (win.isDestroyed()) return;
          loadDevRenderer();
        }, devReloadDelay);
        devReloadDelay = Math.min(devReloadDelay * 2, DEV_RELOAD_MAX_DELAY);
      },
    );
    // Reset the backoff once any load completes so the next restart
    // starts from the short delay again.
    win.webContents.on("did-finish-load", () => {
      devReloadDelay = 250;
    });
    loadDevRenderer();
    // DevTools stays closed by default. Toggle with ⌥⌘I (macOS) /
    // Ctrl+Shift+I (Win/Linux) when you actually need it. Opt in at
    // launch with `ZEROS_DEVTOOLS=1 pnpm electron:dev` if you want
    // it to open every run.
    if (process.env.ZEROS_DEVTOOLS === "1") {
      win.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // Guard against the "Electron loaded the marketing site" failure
  // mode: every Mac-app index.html carries
  //   <meta name="zeros-app" content="mac">
  // If it's missing after load, something else (likely a sibling
  // Vite dev server on the same port) is being served as the
  // renderer. Replace the body with a clear error so the user
  // doesn't mistake a public website for the Mac app.
  win.webContents.on("did-finish-load", () => {
    void win.webContents
      .executeJavaScript(
        "(() => { const m = document.querySelector('meta[name=\"zeros-app\"]'); return m ? m.getAttribute('content') : null; })()",
        true,
      )
      .then((value: unknown) => {
        if (value === "mac") return;
        const loaded = win.webContents.getURL();
        const message =
          `Electron loaded the wrong page at ${loaded}. ` +
          `Expected the Mac-app renderer (which stamps a ` +
          `<meta name="zeros-app" content="mac"> tag in index.html), ` +
          `but the loaded document has no such stamp. The most ` +
          `common cause is another Vite dev server (e.g. ` +
          `apps/marketing) running on the configured port. ` +
          `Stop that server and relaunch, or set ELECTRON_RENDERER_URL ` +
          `to point at the Mac app's Vite explicitly.`;
        console.error(`[Zeros] ${message}`);
        void win.webContents
          .executeJavaScript(
            `(() => {
              document.title = "Zeros — wrong page loaded";
              document.body.innerHTML = ${JSON.stringify(
                `<div style="font-family:-apple-system,Segoe UI,sans-serif;padding:48px;color:#fff;background:#0a0a0a;min-height:100vh;line-height:1.6">
                   <h1 style="margin-top:0;font-size:22px">Wrong page loaded</h1>
                   <p style="opacity:.85;max-width:680px">${message
                     .replace(/&/g, "&amp;")
                     .replace(/</g, "&lt;")
                     .replace(/>/g, "&gt;")}</p>
                 </div>`,
              )};
            })()`,
            true,
          )
          .catch(() => {
            /* error UI is best-effort */
          });
      })
      .catch(() => {
        /* couldn't probe — likely a transient nav, ignore */
      });
  });

  // Right-click → standard text edit actions only (no Inspect Element).
  // DevTools stays on the View-menu accelerator (Cmd+Opt+I). Identical in
  // dev and prod.
  setupContextMenu(win);

  return win;
}

// Deep-link setup must happen BEFORE app.whenReady() so the
// single-instance lock is acquired and macOS's open-url handler is
// registered inside will-finish-launching (otherwise cold-launched
// zeros:// URLs get dropped).
setupDeepLink();

// ──────────────────────────────────────────────────────────
// Dock icon — force the .icns onto the running app's dock tile (DEV ONLY)
// ──────────────────────────────────────────────────────────
// A packaged build must NOT touch its own Dock tile. macOS 26 (Tahoe) draws a
// bundle icon it resolved ITSELF with the full Liquid Glass treatment — the
// specular rim + bevel that every other app in the Dock has. An image pushed in at
// runtime via app.dock.setIcon() is blitted as raw pixels instead, with none of
// that, so the tile reads visibly flat next to its neighbours. Verified on 26.3.1
// against a live app: same bundle, same .icns, rim before the call, no rim after.
//
// Dev is the exception, and only because its bundle PATH is reused across runs
// (~/.zeros-dev/dev-instances/*.app, plus node_modules' Electron.app for the
// primary checkout). macOS caches Dock icons per bundle path, so a re-stamped
// electron.icns can keep showing the old pixels. A packaged bundle doesn't have
// that problem — and setIcon was in fact a silent no-op there for months (it
// joined a "../../Resources" path that has never existed) with nobody ever
// reporting a stale packaged icon.
//
// The snag: nativeImage.createFromPath() can't decode .icns (returns empty). So we
// read the .icns ourselves and pull out its largest embedded PNG representation
// (iconutil stores the 128–1024px reps as PNG) — the SAME pixels as the bundle
// icon, so there's no visible "transform" and no separate .png file to keep in sync.

/** Extract the largest PNG-encoded representation from an .icns, or null. An icns
 *  is 'icns' + total-len, then a series of TypeCode(4) + len(4) + data chunks;
 *  modern reps (ic07..ic14) store a whole PNG, so we scan for the PNG signature and
 *  keep the widest (a PNG's width is at byte 16: 8-byte sig + IHDR len+type). */
function largestPngFromIcns(icnsPath: string): Buffer | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(icnsPath);
  } catch {
    return null;
  }
  if (buf.length < 8 || buf.toString("ascii", 0, 4) !== "icns") return null;
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let best: Buffer | null = null;
  let bestWidth = -1;
  let off = 8; // skip the 'icns' magic + total-length header
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off + 4);
    if (len < 8 || off + len > buf.length) break;
    const data = buf.subarray(off + 8, off + len);
    if (data.length >= 24 && data.subarray(0, 4).equals(PNG_SIG)) {
      const width = data.readUInt32BE(16);
      if (width > bestWidth) {
        bestWidth = width;
        best = data;
      }
    }
    off += len;
  }
  return best;
}

/** Force the Dock tile to icon-dev.icns, overriding macOS's per-bundle icon cache.
 *  Dev only — see above: doing this in a packaged build costs us the OS's Liquid
 *  Glass rim. Best-effort — a missing/odd icon is purely cosmetic. */
function setupDockBrand(): void {
  if (process.platform !== "darwin" || IS_PACKAGED) return;
  const icnsPath = path.join(
    __dirname,
    "..",
    "build",
    "icons",
    "icon-dev.icns",
  );
  try {
    const png = largestPngFromIcns(icnsPath);
    if (!png) return;
    const image = nativeImage.createFromBuffer(png);
    if (!image.isEmpty()) app.dock?.setIcon(image);
  } catch {
    /* icon override is cosmetic — carry on */
  }
}

/**
 * Pull the user's real shell PATH into the Electron process BEFORE we
 * spawn the engine. macOS GUI apps launched from Finder or the Dock
 * inherit only `/usr/bin:/bin:/usr/sbin:/sbin` — no Homebrew, no
 * npm-global, no Volta/fnm/mise/asdf shims. That's why `isOnPath(
 * "claude")` in the engine's CLI probe returned false for every user
 * who installed their CLIs the normal way, and why every agent pill
 * showed "not installed" in the packaged app.
 *
 * `fix-path` runs `$SHELL -ilc 'echo $PATH'` once and rewrites
 * `process.env.PATH` before anything else reads it — including the
 * engine child spawn, which inherits the fixed PATH. Every desktop app
 * that shells out to user-installed CLIs lands on this same fix; it's
 * the standard Electron-on-macOS workaround.
 *
 * Dynamic-imported because `fix-path` ships ESM-only and our main
 * bundle is CJS. The await lives inside whenReady() so we never block
 * the event loop before it's running.
 */
async function hydrateShellPath(): Promise<void> {
  try {
    const mod = (await import("fix-path")) as { default: () => void };
    mod.default();
    console.log(
      `[Zeros] shell PATH hydrated (${(process.env.PATH ?? "").split(":").length} entries)`,
    );
  } catch (err) {
    // Non-fatal: on Linux / Windows the default PATH is usually fine,
    // and even on macOS the user can still launch from `pnpm electron:dev`
    // which inherits the terminal PATH anyway.
    console.warn(
      `[Zeros] fix-path failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

app.whenReady().then(async () => {
  setupDockBrand();

  setGithubTokenStore(githubSelectedTokenStore);

  // Install the native app menu (File > Open Folder, Edit, View, etc).
  // Safe to call before the window exists — macOS associates the
  // menu with the app, not a specific window.
  installAppMenu();

  // macOS "About Zeros" panel — drop the legacy copyright line, which carried
  // a brand string that is no longer current.
  // setAboutPanelOptions overrides the bundle's NSHumanReadableCopyright, so an
  // empty string shows no copyright row at all. Name + version still render
  // (macOS fills them from the bundle).
  app.setAboutPanelOptions({ copyright: "" });

  // IPC plumbing BEFORE the window loads so any command fired during
  // boot (ws-client's `get_engine_port` probe, store rehydrate, etc.)
  // finds a registered handler instead of "No handler for 'zeros:invoke'".
  registerIpcHandlers();
  registerAllCommands();
  installDesignProtocol();

  // PATH repair and engine startup are critical background work, not a window
  // creation prerequisite. Register a spawn barrier so the child still inherits
  // the repaired PATH, then start the single-flight boot before loading the UI.
  // get_engine_port awaits this same promise; no renderer ever guesses a port.
  const shellPathReady = hydrateShellPath();
  const githubAuthReady = shellPathReady.then(async () => {
    try {
      await initializeGithubCredentialStore();
    } catch (err) {
      // Non-destructive migration: the legacy read-through remains live, so a
      // keystore/settings failure must not prevent the engine from starting.
      console.warn(
        `[Zeros] GitHub credential migration deferred: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      await initializeGithubAppFlow();
    } catch (err) {
      console.warn(
        `[Zeros] GitHub App refresh scheduling deferred: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
  const disposeGithubSessionSync = onMainAuthSessionChanged(async () => {
    await pushGithubCredentialToEngine();
    await scheduleGithubAppRefresh();
    emitEvent("github-credential-store-changed", {});
  });
  app.on("will-quit", disposeGithubSessionSync);
  setEngineSpawnBarrier(githubAuthReady);
  const root = defaultProjectRoot();
  const engineBoot = spawnEngine(root);

  // Watchdog runs for the life of the process; shutdown() clears its
  // timer so it doesn't race the clean-quit path.
  startWatchdog();

  // Dev-only: when tsup rewrites dist-engine/cli.js we SIGTERM the
  // running engine; watchdog respawns it with the fresh code.
  startEngineCodeWatcher();

  const win = createMainWindow();
  setMainWindow(win);

  // Main-owned update checks continue even when the macOS window is closed.
  // Start only after setMainWindow so the initial event cannot pollute the
  // cold-launch deep-link buffer; the renderer also reads a status snapshot.
  setupUpdater();

  void engineBoot.then(
    (port) => console.log(`[Zeros] engine spawned on port ${port} at ${root}`),
    (err) =>
      console.error(
        `[Zeros] engine spawn failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
  );

  // (dev) Live shared login: when ANOTHER worktree rewrites the shared
  // secrets.json (sign-in / sign-out / token refresh), nudge the renderer to
  // re-sync its session so "log in once, every worktree authed" applies WITHOUT a
  // reload. Only when the store is actually shared (ZEROS_SHARED_SECRETS_DIR) —
  // single-instance stable/beta have no sibling to propagate from. See
  // apps/desktop/src/renderer/features/auth/auth-context.tsx (auth-store-changed).
  if (process.env.ZEROS_SHARED_SECRETS_DIR) {
    const disposeSecretsWatch = watchSecrets((changedAccounts) => {
      if (changedAccounts.includes("auth-session:tokens")) {
        emitEvent("auth-store-changed", {});
        void pushGithubCredentialToEngine();
        void scheduleGithubAppRefresh();
      }
      if (
        changedAccounts.some(
          (account) =>
            account === "github.app" ||
            account === "github.pat" ||
            account === "github_oauth",
        )
      ) {
        void handleSharedGithubCredentialChange();
      }
    });
    app.on("will-quit", () => disposeSecretsWatch());
  }

  // Roll up per-process memory into main.log so a future spike is attributable.
  startProcessMetricsLogger();
  // Workbench browser tabs are
  // <iframe> elements (not WebContentsView). All they need from
  // main is the ability to clear HTTP cache + cookies in the
  // session (operations iframes can't perform themselves).
  registerIframeSessionCommands({ mainWindow: win });
  // Element picker — install/uninstall via
  // WebFrameMain.executeJavaScript + main-window region capture
  // for the picker chip's element thumbnail.
  registerIframePickerCommands({ mainWindow: win });

  // macOS: re-create the window when the dock icon is clicked and no
  // windows are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const next = createMainWindow();
      setMainWindow(next);
      registerIframeSessionCommands({ mainWindow: next });
      registerIframePickerCommands({ mainWindow: next });
    }
  });
});

// Keep the app alive on macOS when all windows close (standard macOS
// behaviour — user explicitly Quits via Cmd+Q).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Kill the engine child before exit. `before-quit` fires once, even
// if multiple windows close, so the shutdown is single-threaded.
app.on("before-quit", () => {
  shutdownSidecar();
  // Interactive PTYs are now engine-owned (apps/desktop/src/renderer/platform/pty.ts → engine bridge),
  // and the engine reaps them on its own shutdown (Engine.stop → pty.killAll).
  // Killing the sidecar above tears the engine down, so there are no
  // renderer-process node-pty children left to reap here.
  // The legacy agent-history SQLite handle (the retired electron/db.ts) is gone —
  // chats + transcripts live in the engine's Zeros DB, which the engine closes.
  //
  // Last: write out any coalesced-repeat summary the log store is still
  // holding (log-store.ts buffers runs of identical lines; if the app quits
  // mid-storm the final count exists only in memory). After the sidecar
  // shutdown lines above, so this really is the tail of the file.
  flushLogStore();
});

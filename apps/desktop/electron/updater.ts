// electron-updater consumes ZIPs and channel metadata; DMGs are for initial installs.

import {
  app,
  autoUpdater as nativeAutoUpdater,
  net,
  powerMonitor,
} from "electron";
import { autoUpdater } from "electron-updater";
import { emitEvent } from "./ipc/events";
import type { CommandHandler } from "./ipc/router";
import { IS_PACKAGED } from "./runtime-mode";
import { channel, type Channel } from "../src/engine/runtime";
import { mergeClientUpgradeRequired, parseClientUpgradeRequired, type ClientUpgradeRequired } from "../shared/client-compatibility";
import { onClientUpgrade } from "./client-upgrade-signal";

let wired = false;

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MIN_OPPORTUNISTIC_CHECK_GAP_MS = 60 * 1000;
// GitHub Releases is the serving layer. `/releases/latest/download/<asset>`
// always resolves to whatever release is marked Latest (release.yml passes
// `--latest`; prereleases never qualify), and the rolling `alpha` / `beta` tags
// give the pre-release channels a stable URL of their own.
const RELEASES = "https://github.com/Withso/zeros/releases";
// Raw feed metadata for the staged-update preflight below (no cache-busting
// query, so GitHub's CDN can serve repeated polls).
const STABLE_FEED_METADATA_URL = `${RELEASES}/latest/download/latest-mac.yml`;
const BETA_FEED_METADATA_URL = `${RELEASES}/download/beta/beta-mac.yml`;
const ALPHA_FEED_METADATA_URL = `${RELEASES}/download/alpha/alpha-mac.yml`;

/** Pin generic feeds per channel: the GitHub provider also accepts stable tags,
 * which may lack prerelease metadata. Feed entries and release uploads must
 * move together (check:packaging-paths); null channels must not poll.
 * ?static=1 disables the updater's noCache query so polls share a CDN key.
 * Never let a bad feed or Latest tag downgrade an installed version. */
const UPDATER_FEED_BY_CHANNEL: Record<
  Channel,
  {
    metadataUrl: string;
    url: string;
    channel: string;
    allowDowngrade: boolean;
  } | null
> = {
  // Dev never reaches the updater at all (the !IS_PACKAGED guard returns first).
  dev: null,
  alpha: {
    metadataUrl: ALPHA_FEED_METADATA_URL,
    url: `${RELEASES}/download/alpha?static=1`,
    channel: "alpha",
    allowDowngrade: false,
  },
  beta: {
    metadataUrl: BETA_FEED_METADATA_URL,
    url: `${RELEASES}/download/beta?static=1`,
    channel: "beta",
    allowDowngrade: false,
  },
  stable: {
    metadataUrl: STABLE_FEED_METADATA_URL,
    // Stable resolves its real feed from the baked app-update.yml rather than an
    // explicit setFeedURL; `url` here is only for the metadata preflight.
    url: `${RELEASES}/latest/download?static=1`,
    channel: "latest",
    allowDowngrade: false,
  },
};

type UpdaterStatusState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes?: string }
  | {
      kind: "downloading";
      version: string;
      downloaded: number;
      total?: number;
    }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

export type UpdaterStatusSnapshot = UpdaterStatusState & { revision: number; required?: ClientUpgradeRequired };

let statusRevision = 0;
let currentStatus: UpdaterStatusSnapshot = { kind: "idle", revision: 0 };
let requiredUpgrade: ClientUpgradeRequired | null = null;

export function requireClientUpgrade(value: unknown): void {
  const required = parseClientUpgradeRequired(value);
  if (!required) throw new Error("Invalid required update");
  const next = mergeClientUpgradeRequired(requiredUpgrade, required);
  if (next === requiredUpgrade) return;
  requiredUpgrade = next;
  installWhenReady = false;
  publish(currentStatus);
  if (wired) checkAutomatically("required");
}

/** Main-process menu consumers cannot subscribe to the renderer's IPC stream. */
const statusListeners = new Set<(status: UpdaterStatusSnapshot) => void>();

/** Subscribe a main-process listener to updater status changes. Returns an
 *  unsubscribe function. Pair with getUpdaterStatus() for the initial state. */
export function subscribeUpdaterStatus(
  listener: (status: UpdaterStatusSnapshot) => void,
): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function getUpdaterStatus(): UpdaterStatusSnapshot {
  return currentStatus;
}

/** Set once electron-updater has fully downloaded an update and staged it for
 *  install. Lets updater_install choose "download" vs "restart now". */
let updateDownloaded = false;
let stagedVersion = "";

/** Set when the user clicks Install before the background download finishes —
 *  we then quitAndInstall the moment `update-downloaded` fires. */
let installWhenReady = false;

/** Version of the update currently being downloaded (download-progress events
 *  don't carry it, so capture it from update-available). */
let pendingVersion = "";

/** On macOS electron-updater's public event means the zip is available to its
 * local proxy; Electron/Squirrel emits its own event only after ingest/staging. */
let macStagingVersion = "";
/** Known-good staged version retained until a replacement zip reaches the
 * native Squirrel handoff. A provider/download failure before then restores it. */
let stagedReplacementFallback = "";

type CheckResult = Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>;
let checkInFlight: Promise<CheckResult> | null = null;
let lastCheckStartedAt: number | null = null;
let lastCheckSucceededAt: number | null = null;
let stagedFeedPollInFlight: Promise<void> | null = null;
let lastStagedFeedPollAt: number | null = null;
let lastStagedFeedSucceededAt: number | null = null;
let automaticCheckTimer: ReturnType<typeof setTimeout> | null = null;

interface ParsedVersion {
  core: number[];
  prerelease: Array<number | string>;
}

/** Parse the subset of SemVer used by stable and beta release feeds. */
function parseVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/, "").split("+", 1)[0];
  const [corePart, prereleasePart] = normalized.split("-", 2);
  const core = corePart.split(".").map((part) => Number(part));
  if (
    core.length === 0 ||
    core.some((part) => !Number.isSafeInteger(part) || part < 0)
  ) {
    return null;
  }
  const prerelease = prereleasePart
    ? prereleasePart.split(".").map((part) => {
        const numeric = Number(part);
        return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : part;
      })
    : [];
  return { core, prerelease };
}

function compareIdentifiers(
  left: number | string,
  right: number | string,
): number {
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "string") return -1;
  if (typeof left === "string" && typeof right === "number") return 1;
  return left < right ? -1 : 1;
}

export function isVersionNewer(candidate: string, baseline: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(baseline);
  if (!left || !right) return false;
  const coreLength = Math.max(left.core.length, right.core.length, 3);
  for (let index = 0; index < coreLength; index += 1) {
    const comparison = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (comparison !== 0) return comparison > 0;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === 0 && right.prerelease.length > 0;
  }
  const prereleaseLength = Math.max(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart !== undefined;
    }
    const comparison = compareIdentifiers(leftPart, rightPart);
    if (comparison !== 0) return comparison > 0;
  }
  return false;
}

/** Read just the feed's version field without asking Squirrel to check again. */
export function parseFeedVersion(metadata: string): string | null {
  const match = metadata.match(
    /^\s*version:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m,
  );
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || null;
}

function publish(status: UpdaterStatusState): void {
  currentStatus = { ...status, revision: ++statusRevision, ...(requiredUpgrade ? { required: requiredUpgrade } : {}) };
  emitEvent("updater-status", currentStatus);
  for (const listener of statusListeners) listener(currentStatus);
}

function publishUnlessReady(status: UpdaterStatusState): void {
  if (!updateDownloaded) publish(status);
}

function markUpdateStaged(version: string): void {
  stagedVersion = version || pendingVersion || stagedVersion;
  updateDownloaded = true;
  stagedReplacementFallback = "";
  publish({ kind: "ready", version: stagedVersion });
  if (installWhenReady) {
    installWhenReady = false;
    applyAndRelaunch();
  }
}

function clearAutomaticCheckTimer(): void {
  if (automaticCheckTimer) clearTimeout(automaticCheckTimer);
  automaticCheckTimer = null;
}

/** Schedule from completion, so a slow check or an explicit manual check does
 * not make the fixed launch interval skip a genuinely due observation. */
function scheduleAutomaticCheck(): void {
  clearAutomaticCheckTimer();
  if (!wired || !updaterEnabled()) return;
  automaticCheckTimer = setTimeout(() => {
    automaticCheckTimer = null;
    checkAutomatically("interval");
  }, CHECK_INTERVAL_MS);
  automaticCheckTimer.unref?.();
}

function automaticCheckThrottled(startedAt: number | null, succeededAt: number | null): boolean {
  const now = Date.now();
  const recent = (at: number | null, gap: number) => at != null && now >= at && now - at < gap;
  return recent(startedAt, MIN_OPPORTUNISTIC_CHECK_GAP_MS) || recent(succeededAt, CHECK_INTERVAL_MS);
}

function checkForUpdatesShared(): Promise<CheckResult> {
  if (checkInFlight) return checkInFlight;
  clearAutomaticCheckTimer();
  lastCheckStartedAt = Date.now();
  const request = autoUpdater.checkForUpdates();
  checkInFlight = request;
  const clear = () => {
    if (checkInFlight !== request) return;
    checkInFlight = null;
    scheduleAutomaticCheck();
  };
  request.then(() => { lastCheckSucceededAt = Date.now(); clear(); }, clear);
  return request;
}

/**
 * Squirrel.Mac can discard an already-staged directory when native
 * checkForUpdates runs again. Poll the tiny channel metadata first and
 * enter electron-updater only when a genuinely newer build exists. This keeps
 * Restart instant for the current staged build while still replacing it with a
 * later same-day release.
 */
function checkForNewerThanStaged(reason: string, force = false): void {
  if (
    stagedFeedPollInFlight ||
    (!force && automaticCheckThrottled(lastStagedFeedPollAt, lastStagedFeedSucceededAt)) ||
    !updateDownloaded ||
    !stagedVersion
  ) {
    // Whatever skipped this poll, the background chain keeps one next check.
    if (!stagedFeedPollInFlight && !automaticCheckTimer) scheduleAutomaticCheck();
    return;
  }
  clearAutomaticCheckTimer();
  lastStagedFeedPollAt = Date.now();
  const previousVersion = stagedVersion;
  stagedFeedPollInFlight = (async () => {
    const metadataUrl =
      UPDATER_FEED_BY_CHANNEL[channel()]?.metadataUrl ??
      STABLE_FEED_METADATA_URL;
    const response = await net.fetch(metadataUrl, {
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) {
      throw new Error(`feed metadata returned HTTP ${response.status}`);
    }
    const candidate = parseFeedVersion(await response.text());
    if (candidate) lastStagedFeedSucceededAt = Date.now();
    if (!candidate || !isVersionNewer(candidate, previousVersion)) return;
    // The old ready toast is no longer actionable once Squirrel starts staging
    // its replacement. Hide it until the native event confirms the new build.
    updateDownloaded = false;
    stagedReplacementFallback = previousVersion;
    console.log(
      `[updater] newer staged candidate ${candidate} found (${reason}); replacing ${previousVersion}`,
    );
    publish({ kind: "checking" });
    try {
      const result = await checkForUpdatesShared();
      const nextVersion = result?.updateInfo?.version ?? "";
      if (
        !result?.isUpdateAvailable ||
        !isVersionNewer(nextVersion, previousVersion)
      ) {
        // Feed/provider disagreement: preserve the known-good staged update.
        stagedVersion = previousVersion;
        updateDownloaded = true;
        stagedReplacementFallback = "";
        publish({ kind: "ready", version: previousVersion });
      }
    } catch (error) {
      stagedVersion = previousVersion;
      updateDownloaded = true;
      stagedReplacementFallback = "";
      publish({ kind: "ready", version: previousVersion });
      throw error;
    }
  })()
    .catch((err) => {
      // Metadata failures are ordinary offline/background conditions. The
      // currently staged update remains untouched and ready to apply.
      console.warn(
        "[updater] staged feed poll failed:",
        err instanceof Error ? err.message : err,
      );
    })
    .finally(() => {
      stagedFeedPollInFlight = null;
      scheduleAutomaticCheck();
    });
}

/** Whether THIS build has a working auto-update source at all.
 *
 *  False for dev (nothing to update) and for any channel whose
 *  UPDATER_FEED_BY_CHANNEL entry is null — currently only dev; Alpha and Beta both
 *  have live feeds. This must gate EVERY entry point, not just the scheduler: the
 *  `-c.publish.url` override bakes a channel URL into the packaged
 *  app-update.yml, so electron-updater would happily poll that prefix on its own
 *  and 404 on every attempt — the 5-minute interval plus every window focus and
 *  every power resume. Exactly the "[updater] Error" flood seen in field logs. */
function updaterEnabled(): boolean {
  return IS_PACKAGED && UPDATER_FEED_BY_CHANNEL[channel()] !== null;
}

function checkAutomatically(reason: string): void {
  if (!updaterEnabled()) return;
  // The interval timer is itself the cadence: it is armed only when a check
  // completes, so its own tick is never throttled. A small wall-clock step
  // could otherwise read the tick as "too soon" and end the background chain.
  const due = reason === "required" || reason === "interval";
  if (updateDownloaded) {
    checkForNewerThanStaged(reason, due);
    return;
  }
  // A newer feed is already downloading. Let that single attempt finish before
  // considering another feed generation; once staged, the preflight above will
  // immediately notice if an even newer version appeared in the meantime.
  if (stagedReplacementFallback) {
    scheduleAutomaticCheck();
    return;
  }
  if (checkInFlight) return;
  if (!due && automaticCheckThrottled(lastCheckStartedAt, lastCheckSucceededAt)) {
    // A throttled focus/resume leaves the next automatic check scheduled.
    if (!automaticCheckTimer) scheduleAutomaticCheck();
    return;
  }
  console.log(`[updater] automatic check (${reason})`);
  void checkForUpdatesShared().catch((err) => {
    // Offline/feed failures are expected background conditions. The updater's
    // error event logs the detail; retain any already-staged update status.
    // A network failure is already that one line.
    if (isTransientNetworkError(err)) return;
    console.warn(
      "[updater] automatic check failed:",
      err instanceof Error ? err.message : err,
    );
  });
}

const TRANSIENT_NETWORK_ERROR =
  /net::ERR_(?:NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE|NETWORK_IO_SUSPENDED|CONNECTION_(?:RESET|REFUSED|CLOSED|ABORTED|TIMED_OUT|FAILED)|TIMED_OUT|PROXY_CONNECTION_FAILED|NETWORK_ACCESS_DENIED)\b/;
const TRANSIENT_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
]);

/** True for an updater failure caused by the network itself (offline, a Wi-Fi
 * or VPN change, DNS). The scheduler retries on its own, so one warning is
 * enough; a stack trace at error level only buries real failures. Exported for
 * tests. */
export function isTransientNetworkError(err: unknown): boolean {
  if (typeof err === "string") return TRANSIENT_NETWORK_ERROR.test(err);
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return typeof message === "string" && TRANSIENT_NETWORK_ERROR.test(message);
}

/** True when an updater failure is the staging extraction running out of disk
 *  space. electron-updater surfaces Squirrel's ditto failure as a plain Error
 *  whose message ends in macOS's "No space left on device"; Node-level ENOSPC
 *  carries the code instead. Exported for tests. */
export function isDiskFullError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === "ENOSPC") return true;
  return (
    typeof message === "string" &&
    (message.includes("ENOSPC") || message.includes("No space left on device"))
  );
}

/** Apply an already-staged update now (quit → replace → relaunch). Returns
 *  false when nothing is staged — callers with a UI affordance (the app menu's
 *  "Restart to Update" item) only appear in the ready state, so false means a
 *  stale click raced a state change and should do nothing. */
export function installStagedUpdate(): boolean {
  if (!updateDownloaded) return false;
  if (requiredUpgrade?.minimumVersion && isVersionNewer(requiredUpgrade.minimumVersion, stagedVersion)) return false;
  applyAndRelaunch();
  return true;
}

/** Run quitAndInstall off the current event-loop tick (electron-updater's own
 *  guidance — calling it synchronously inside an event handler can race the
 *  download cleanup). isForceRunAfter relaunches into the new version. */
function applyAndRelaunch(): void {
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      console.warn("[updater] quitAndInstall failed:", err);
      publish({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export function setupUpdater(): void {
  if (wired) return;
  wired = true;

  // Dev / unpackaged builds, and any channel with no feed (Alpha, Beta): no
  // meaningful update source, so wire NOTHING — no interval, no focus/resume
  // triggers, no event handlers. One info line so a field log says why the app
  // never self-updates, instead of leaving it a mystery.
  if (!updaterEnabled()) {
    if (IS_PACKAGED) {
      console.log(
        `[updater] channel "${channel()}" has no update feed — self-update disabled ` +
          `(install manually from the GitHub prerelease)`,
      );
    }
    return;
  }

  // Route electron-updater's own logging (checking / found / downloading /
  // staged / errors) through the main-process console, which setupLogFile
  // mirrors to ~/Library/Logs/<app>/main.log. Without this the updater logs at
  // info level via its default `console` logger — and console.info isn't
  // captured in packaged builds, so a stuck/failing updater left no trace.
  // console.log / console.error are the patched, file-backed methods.
  autoUpdater.logger = {
    info: (m) => console.log("[updater]", m),
    warn: (m) => console.error("[updater] WARN", m),
    // The "error" event below records a network failure once as a warning.
    error: (m) => {
      if (isTransientNetworkError(m)) return;
      console.error(
        "[updater]",
        m instanceof Error ? (m.stack ?? m.message) : m,
      );
    },
    debug: (m) => console.log("[updater:debug]", m),
  };

  // Download in the background as soon as a newer version is found, and stage it
  // to apply on the next natural quit — an update never forces a restart out
  // from under a running agent.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Point the updater at THIS build's channel feed. Dev never reaches here (the
  // !IS_PACKAGED guard above returns first). The channel is seeded into
  // process.env by main.ts.
  // Feed + downgrade policy come from UPDATER_FEED_BY_CHANNEL (see its doc block
  // for the per-channel rationale). Non-stable channels point the GENERIC provider
  // at their rolling release tag: it fetches <url>/<channel>-mac.yml and resolves
  // the zip filenames inside it against the same base — exactly the assets each
  // release workflow uploads, and nothing else. electron-updater's GitHub PROVIDER
  // remains unusable for this: its channel filter also accepts stable tags, so it
  // 404s on beta-mac.yml under a stable tag and, with allowDowngrade, tries to swap
  // Beta for the older prod build.
  const feed = UPDATER_FEED_BY_CHANNEL[channel()];
  if (feed && channel() !== "stable") {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: feed.url,
      channel: feed.channel,
    });
  }
  // Stable deliberately keeps the baked app-update.yml as its feed source, so only
  // the downgrade policy is applied here.
  autoUpdater.allowDowngrade = feed?.allowDowngrade ?? true;

  autoUpdater.on("checking-for-update", () =>
    publishUnlessReady({ kind: "checking" }),
  );

  autoUpdater.on("update-available", (info) => {
    pendingVersion = info?.version ?? "";
    publishUnlessReady({
      kind: "available",
      version: pendingVersion,
      notes:
        typeof info?.releaseNotes === "string" ? info.releaseNotes : undefined,
    });
    // autoDownload=true → electron-updater starts the download itself; the
    // download-progress / update-downloaded events below drive the pill.
  });

  autoUpdater.on("update-not-available", () => {
    publishUnlessReady({ kind: "idle" });
  });

  autoUpdater.on("download-progress", (p) => {
    publishUnlessReady({
      kind: "downloading",
      version: pendingVersion,
      downloaded: typeof p?.transferred === "number" ? p.transferred : 0,
      total: typeof p?.total === "number" ? p.total : undefined,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const version = info?.version ?? pendingVersion;
    if (process.platform === "darwin") {
      // MacUpdater dispatches this before native Squirrel finishes fetching
      // from its loopback proxy. Wait for Electron's native event below so a
      // "ready" toast always means Restart can quit immediately.
      macStagingVersion = version;
      // The replacement zip is now being handed to native Squirrel; from this
      // point the prior staged directory can no longer be promised as usable.
      stagedReplacementFallback = "";
      console.log(
        `[updater] ${version} downloaded; waiting for native macOS staging`,
      );
      return;
    }
    markUpdateStaged(version);
  });

  if (process.platform === "darwin") {
    nativeAutoUpdater.on("update-downloaded", () => {
      markUpdateStaged(macStagingVersion || pendingVersion);
      macStagingVersion = "";
    });
  }

  autoUpdater.on("error", (err) => {
    // Background check/download failures are noisy but non-fatal — log and stay
    // idle rather than flashing a red Retry pill the user can't act on. Common
    // causes: 404 before first release, offline, rate-limited.
    console.warn("[updater] error:", err?.message ?? err);
    if (!updateDownloaded) {
      installWhenReady = false;
      if (stagedReplacementFallback) {
        stagedVersion = stagedReplacementFallback;
        stagedReplacementFallback = "";
        updateDownloaded = true;
        publish({ kind: "ready", version: stagedVersion });
      } else if (isDiskFullError(err)) {
        // The one background failure that is NOT transient noise: Squirrel's
        // staging extraction hit ENOSPC. It recurs on every retry until the
        // user frees disk space, and swallowing it as `idle` left installs
        // stranded on old builds for days with zero signal (field incident,
        // 2026-08-06). Publish an actionable error so the renderer can say
        // "free up disk space" once; the scheduler keeps retrying regardless.
        publish({
          kind: "error",
          message:
            "There isn't enough free disk space to install it. " +
            "Free up some space and the update will retry automatically.",
        });
      } else {
        publish({ kind: "idle" });
      }
    }
  });

  // Main-process ownership means updates keep arriving even if all macOS
  // windows are closed. Focus/resume catches sleep or a long offline interval;
  // successful checks stay fresh for five minutes, failed checks can retry on
  // focus after one minute. The completion schedules one next automatic check.
  app.on("browser-window-focus", () => checkAutomatically("focus"));
  powerMonitor.on("resume", () => checkAutomatically("resume"));
  checkAutomatically("launch");
}


/** Check for updates. Returns lightweight metadata so the renderer can react
 *  immediately when a new version is live; the event stream drives the
 *  download/ready progress.
 *
 *  Contract with the renderer's "Check for Updates" menu handler:
 *    metadata  → an update IS available for this build (toast re-surfaces)
 *    null      → genuinely up to date ("You're up to date!" toast)
 *    throws    → the CHECK failed (offline, feed unreachable) — propagate so
 *                the renderer shows its error toast instead of a false "up to
 *                date". The main-owned scheduler catches its own failures, so
 *                letting this reject never surfaces UI for an unattended check. */
export const updaterCheck: CommandHandler = async () => {
  // Feedless channels (Alpha, Beta) return null, i.e. "no update available" —
  // the same shape as an up-to-date stable. Polling here would 404 against a
  // prefix that was never populated.
  if (!updaterEnabled()) return null;
  // Never re-run Squirrel for the same staged update. The main scheduler's
  // metadata preflight independently notices and downloads a newer release.
  if (updateDownloaded && requiredUpgrade?.minimumVersion && isVersionNewer(requiredUpgrade.minimumVersion, stagedVersion)) {
    checkForNewerThanStaged("required", true);
    await stagedFeedPollInFlight;
  }
  if (updateDownloaded) {
    if (requiredUpgrade && currentStatus.kind === "error") publish({ kind: "ready", version: stagedVersion });
    return { version: stagedVersion };
  }
  const result = await checkForUpdatesShared();
  if (!result?.updateInfo || !result.isUpdateAvailable) {
    return updateDownloaded ? { version: stagedVersion } : null;
  }
  return {
    version: result.updateInfo.version,
    notes:
      typeof result.updateInfo.releaseNotes === "string"
        ? result.updateInfo.releaseNotes
        : undefined,
  };
};

/** "Install" the available update. If it's already staged → quit, replace
 *  in place, and relaunch. If the background download is still running → mark it
 *  to install the moment it finishes. The normal renderer calls this only from
 *  the ready toast; the latch is defensive for older clients. */
export const updaterInstall: CommandHandler = async (args) => {
  if (args.requireReady !== undefined && typeof args.requireReady !== "boolean") throw new Error("Invalid update restart request");
  if (!updaterEnabled()) return;
  if (!updateDownloaded && (requiredUpgrade || args.requireReady === true)) throw new Error("The update must be staged before restarting");
  if (updateDownloaded && requiredUpgrade?.minimumVersion && isVersionNewer(requiredUpgrade.minimumVersion, stagedVersion)) throw new Error("A compatible update must be staged before restarting");
  if (updateDownloaded) {
    applyAndRelaunch();
    return;
  }
  // Not staged yet (still in flight via autoDownload). Arm the
  // install-on-ready latch and reflect progress; the update-downloaded handler
  // will relaunch. Also kick a download in case autoDownload was bypassed.
  installWhenReady = true;
  publishUnlessReady({
    kind: "downloading",
    version: pendingVersion,
    downloaded: 0,
  });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    // A download already in progress rejects here — that's fine, the latch
    // still fires on update-downloaded. Only surface genuine failures.
    console.warn(
      "[updater] downloadUpdate:",
      err instanceof Error ? err.message : err,
    );
  }
};

/** Subscribe-then-snapshot renderer handshake. Events can be dropped while no
 * window exists; this monotonic snapshot makes the current staged state exact. */
export const updaterStatus: CommandHandler = () => currentStatus;
export const updaterRequire: CommandHandler = (args) => requireClientUpgrade(args);

/** Explicit process relaunch. Kept for any caller that still needs an in-place
 *  restart after external state change. */
export const processRelaunch: CommandHandler = () => {
  if (updateDownloaded) {
    applyAndRelaunch();
    return;
  }
  app.relaunch();
  // app.exit bypasses before-quit, orphaning the engine and skipping the
  // updater's install-on-quit path. A clean quit is still immediate here: the
  // sidecar shutdown only signals its process tree and does not await it.
  app.quit();
};

// Registered after every module binding above is initialized, so a buffered
// early answer can be applied safely.
onClientUpgrade(requireClientUpgrade);

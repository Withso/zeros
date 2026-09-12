// ──────────────────────────────────────────────────────────
// zeros:// deep-link handler
// ──────────────────────────────────────────────────────────
//
// Migrated from the legacy native deep-link handler. Electron handles URL
// schemes differently on each platform — all three code
// paths converge here:
//
//   1. App ALREADY running, user clicks zeros:// URL
//      → macOS: `app.on("open-url", ...)`
//      → Win/Linux: `app.on("second-instance", (_, argv) => ...)`
//         with the URL at the end of argv (requires single-instance
//         lock, which we take below)
//
//   2. App launched COLD by clicking zeros:// URL
//      → macOS: must register `open-url` INSIDE `will-finish-launching`,
//         otherwise the URL is dropped before the handler binds.
//      → Win/Linux: process.argv contains the URL on first boot.
//
// Action routing:
//   zeros://open?path=/abs/project  → spawn engine at path, emit
//                                     project-changed (the renderer then
//                                     REGISTERS the root if it's unknown —
//                                     see AddProjectProvider). Registration
//                                     only: unlike the in-app add flows this
//                                     does NOT fork a first worktree, because
//                                     a web page can fire this link.
//   zeros://open that can't resolve → emit project-open-failed so the
//                                     renderer can toast a reason
//   anything else                   → forward verbatim to renderer
//                                     as `deep-link` event so JS can
//                                     handle it without a rebuild
// ──────────────────────────────────────────────────────────

import { app } from "electron";
import {
  assertIsDirectory,
  isPlausibleProject,
  isSystemDir,
  spawnEngine,
} from "./sidecar";
import { emitEvent, whenRendererReady } from "./ipc/events";
import { channel, schemeForChannel } from "../src/engine/runtime";

// Each release channel registers its OWN URL scheme so macOS LaunchServices
// routes to the right instance: stable → zeros://, beta → zeros-beta://,
// `pnpm electron:dev` → zeros-dev://. Keeping them distinct is what stops a
// packaged Beta from stealing zeros:// links meant for the installed prod app
// (the "Open Zeros Beta?" mis-route) — Beta is also packaged, so keying off
// IS_PACKAGED alone gave prod + beta the SAME zeros:// and let the OS route a
// prod sign-in to Beta. See schemeForChannel() in apps/desktop/src/engine/runtime.ts.
//
// Resolved LAZILY (a function, not a module-const): apps/desktop/electron/main.ts seeds
// process.env.ZEROS_CHANNEL *after* this module is imported but BEFORE
// setupDeepLink() (and every handler) runs, so a top-level channel() read would
// capture the unseeded value and mis-scheme a Beta/dev build. Every call site
// below runs post-seed, so channel() is authoritative each time.
function scheme(): string {
  return schemeForChannel(channel());
}

/** Register this channel's scheme as a default protocol client. Must be called
 *  EARLY (before app.whenReady) on Windows/Linux because the OS
 *  caches the registration at app startup. On macOS registration
 *  is declared in Info.plist (electron-builder wires that in;
 *  the beta pack rewrites it to zeros-beta in scripts/electron-after-pack.cjs);
 *  this runtime call is a safety net for dev. */
export function registerProtocol(): void {
  const s = scheme();
  // Electron's helper — on macOS this ultimately updates
  // LaunchServices; on Win/Linux it edits the registry / .desktop file.
  // In dev (unpackaged) the exact call varies; we call the simple
  // form here and let electron-builder configure bundle-level
  // registration at packaging time.
  if (process.defaultApp) {
    // `defaultApp` is true when running via `electron .` — the
    // launching binary is Electron itself, not Zeros. Register with
    // explicit process.execPath + script path so the OS knows what
    // to spawn. Works around macOS Finder ignoring the scheme when
    // the registering binary is generic `Electron`.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(s, process.execPath, [process.argv[1]]);
    }
  } else {
    app.setAsDefaultProtocolClient(s);
  }
}

/** Parse a zeros:// URL and dispatch. Safe to call before the main
 *  window exists — emitEvent no-ops if mainWindow isn't set yet; the
 *  URL is re-emitted once the window binds (see enqueueBeforeWindow).
 *
 *  Exported for tests; production callers go through setupDeepLink(). */
export async function handleUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // SECURITY: never log the raw URL — invite tokens + OAuth/pairing secrets
    // ride in the query/fragment (mirrors main.ts's argv redaction). Redact
    // from the first `?` or `#`; a mangled-but-secret-bearing link that fails
    // new URL() otherwise leaks the full token into the persistent log.
    console.warn(
      `[Zeros] deep-link: invalid URL ${rawUrl.replace(/([?#]).*$/, "$1<redacted>")}`,
    );
    return;
  }

  if (parsed.protocol !== `${scheme()}:`) {
    // A foreign-channel scheme (e.g. a zeros:// link reaching a Beta app that
    // owns only zeros-beta://) — reject rather than act on another app's link.
    console.warn(`[Zeros] deep-link: unexpected protocol ${parsed.protocol}`);
    return;
  }

  // The legacy native handler put the action in the host component for `zeros://open?...`
  // because there's no //user@ part. WHATWG URL parsing also puts it
  // in `hostname`; falls back to the stripped pathname for exotic
  // forms like `zeros:/open?...`.
  const action = parsed.hostname || parsed.pathname.replace(/^\/+/, "");

  // SECURITY: never log the raw URL. The fragment carries short-lived secrets —
  // the sign-in handoff `zeros://auth/callback#ticket=…` and the pairing
  // `zeros://pair#offer=<base64url>` — which would otherwise be written verbatim
  // to main.log. Log only the scheme + action.
  console.log(`[Zeros] deep-link: ${parsed.protocol}//${action}`);

  if (action === "auth") {
    // Web sign-in handoff: after the browser completes provider sign-in AND the
    // user clicks "Launch Zeros", app.zeros.build/launch deep-links here as
    //   zeros://auth/callback#ticket=…&nonce=…
    // `ticket` is an OPAQUE, single-use, short-TTL handoff code — NOT a token.
    // The renderer redeems it over HTTPS (auth_redeem_handoff) using the PKCE
    // verifier held in the MAIN process, so an intercepted ticket is useless. We
    // never carry raw access / refresh tokens through the OS URL plumbing.
    //
    // `ticket` is read from the URL FRAGMENT (kept out of any intermediary that
    // might observe the redirect target), with a QUERY-STRING fallback.
    //
    // NOTE: the log line above prints only scheme+action — never the query or
    // fragment — so the ticket is never written to main.log.
    const subPath = parsed.pathname.replace(/^\/+/, "");
    if (subPath !== "callback") {
      console.warn(`[Zeros] deep-link: unknown auth sub-action ${subPath}`);
      return;
    }
    const frag = parsed.hash.startsWith("#")
      ? parsed.hash.slice(1)
      : parsed.hash;
    const fragParams = new URLSearchParams(frag);
    const ticket =
      fragParams.get("ticket") ?? parsed.searchParams.get("ticket");
    const nonce = fragParams.get("nonce") ?? parsed.searchParams.get("nonce");
    if (ticket) {
      emitEvent("auth-handoff", { ticket, nonce });
      return;
    }

    // WorkOS's Desktop Application returns to the hosted Zeros callback first.
    // That no-store page then hands only the short-lived, PKCE-bound code and
    // state to Electron through this channel-specific deep link. The verifier
    // remains in main memory and neither token ever travels through the URL.
    const code = fragParams.get("code") ?? parsed.searchParams.get("code");
    const state = fragParams.get("state") ?? parsed.searchParams.get("state");
    const rawProviderError =
      fragParams.get("error") ?? parsed.searchParams.get("error");
    if (rawProviderError && rawProviderError !== "provider_error") {
      console.warn(
        "[Zeros] deep-link auth/callback: invalid WorkOS provider error",
      );
      return;
    }
    const providerError = rawProviderError;
    if (state && (code || providerError)) {
      // macOS can cold-launch a different Dev worktree to receive this URL.
      // Its encrypted shared callback relay requires native safeStorage.
      await app.whenReady();
      const { acceptWorkOSDesktopCallback } = await import(
        "./ipc/commands/workos-auth"
      );
      if (
        !acceptWorkOSDesktopCallback({
          state,
          code,
          error: providerError,
        })
      ) {
        console.warn(
          "[Zeros] deep-link auth/callback: no matching WorkOS sign-in",
        );
      }
      return;
    }

    console.warn("[Zeros] deep-link auth/callback: missing ticket");
    emitEvent("auth-error", { reason: "missing_ticket" });
    return;
  }

  if (action === "github") {
    // GitHub's web callback carries only the main-generated, single-use nonce.
    // Complete the exchange inside Electron main so neither the raw deep link
    // nor the returned token pair ever reaches renderer JavaScript.
    const subPath = parsed.pathname.replace(/^\/+/, "");
    if (subPath !== "connected") {
      console.warn(`[Zeros] deep-link: unknown github sub-action ${subPath}`);
      return;
    }
    const fragment = parsed.hash.startsWith("#")
      ? parsed.hash.slice(1)
      : parsed.hash;
    const fragmentParams = new URLSearchParams(fragment);
    const nonce =
      fragmentParams.get("nonce") ?? parsed.searchParams.get("nonce");
    const error =
      fragmentParams.get("error") ?? parsed.searchParams.get("error");
    try {
      // macOS can deliver open-url before ready; safeStorage and the
      // main-process Auth0 session are not safe to touch until then.
      await app.whenReady();
      // main.ts creates the window inside that same whenReady turn, so by the
      // time we resume `emitEvent` no longer buffers. Without this the connected
      // / error events of a cold-launch callback are sent to a document that
      // cannot receive them: credential stored, but no toast, no analytics, and
      // no auth-cache invalidation.
      await whenRendererReady();
      const { completeGithubAppConnection } = await import("./github-app-flow");
      await completeGithubAppConnection({ nonce, error });
    } catch {
      // Raw URLs and caught errors may contain OAuth material. Emit only a
      // fixed, secret-free reason through the normal bottom-right toast path.
      emitEvent("github-app-error", { reason: "github_unavailable" });
    }
    return;
  }

  if (action === "open") {
    const pathParam = parsed.searchParams.get("path");
    if (!pathParam) {
      console.warn("[Zeros] deep-link: zeros://open missing path=");
      // `project-open-failed`, not `deep-link`: the only `deep-link` subscriber
      // is the team-invite handler, which drops every non-invite URL — so this
      // used to fail completely silently despite the comment below claiming a
      // toast. Emitting a typed reason gives the renderer something to show.
      emitEvent("project-open-failed", {
        root: null,
        reason: "The link didn't include a folder to open.",
      });
      return;
    }
    try {
      assertIsDirectory(pathParam);
      // A web page can fire `zeros://open?path=/` with one click. Apply the
      // cold-start guards so a deep link can't re-root the engine at `/`, $HOME
      // or a system dir (EMFILE watch crash + widening the remotely-reachable
      // file/PTY surface). A genuine project folder (.git/package.json/.zeros/…)
      // still opens.
      if (isSystemDir(pathParam)) {
        throw new Error(`refusing to open a system directory: ${pathParam}`);
      }
      if (!isPlausibleProject(pathParam)) {
        throw new Error(`not a project folder: ${pathParam}`);
      }
      const port = await spawnEngine(pathParam);
      emitEvent("project-changed", { root: pathParam, port });
      console.log(`[Zeros] deep-link open: spawned engine on port ${port}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[Zeros] deep-link open failed: ${reason}`);
      // Typed failure so the renderer can actually toast this. The raw URL is
      // deliberately NOT forwarded: `deep-link` has exactly one subscriber (the
      // invite handler) which ignores non-invite URLs, so this was silent.
      emitEvent("project-open-failed", { root: pathParam, reason });
    }
    return;
  }

  // Unknown action — forward to renderer for JS-side handling.
  emitEvent("deep-link", rawUrl);
}

/** Pulled from argv so the Windows / Linux cold-launch path works.
 *  macOS never puts the URL in argv — it delivers via open-url. */
function findUrlInArgv(argv: string[]): string | null {
  const prefix = `${scheme()}://`;
  for (const arg of argv) {
    if (arg.startsWith(prefix)) return arg;
  }
  return null;
}

/** Primary entry point for boot wiring in main.ts. Registers the
 *  protocol, locks to single-instance, and binds the three possible
 *  OS paths that can deliver a zeros:// URL. */
export function setupDeepLink(): void {
  registerProtocol();

  // Single-instance lock: if the user clicks a zeros:// URL while the
  // app is running, Windows/Linux open a second Electron process; we
  // want the existing one to handle it. macOS already enforces
  // single-instance for .app bundles, but taking the lock makes the
  // `second-instance` event fire there too for symmetry.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", (_event, argv) => {
    const url = findUrlInArgv(argv);
    if (url) void handleUrl(url);
  });

  // macOS: URL delivered via open-url. Must be registered inside
  // will-finish-launching so a cold-launched URL doesn't get dropped
  // before the handler is attached.
  app.on("will-finish-launching", () => {
    app.on("open-url", (event, url) => {
      event.preventDefault();
      void handleUrl(url);
    });
  });

  // Windows / Linux cold launch — the URL is in our own argv.
  const bootUrl = findUrlInArgv(process.argv);
  if (bootUrl) {
    // Defer until after whenReady so mainWindow exists for emitEvent.
    void app.whenReady().then(() => handleUrl(bootUrl));
  }
}

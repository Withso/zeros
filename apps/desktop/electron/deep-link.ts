// Cold macOS links need open-url bound during will-finish-launching; Windows/Linux
// use boot argv and second-instance. Web-triggered opens register a project
// without creating its first worktree.

import { app, shell } from "electron";
import { formatLocalLink, parseLocalLink } from "@zeros/protocol/local-orchestration";
import { IS_LOCAL_DEVELOPMENT } from "./runtime-mode";
import {
  assertIsDirectory,
  isPlausibleProject,
  isSystemDir,
  spawnEngine,
} from "./sidecar";
import { emitEvent, emitLocalNavigation, whenRendererReady } from "./ipc/events";
import { channel, schemeForChannel } from "../src/engine/runtime";

// Keep stable, alpha, beta and dev URL schemes distinct. Resolve lazily because
// main seeds ZEROS_CHANNEL after imports and before handlers run.
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
  // Local development also accepts navigation links. Its dev-only scheme
  // stays separate from installed stable/alpha/beta copies.
  const s = scheme();
  if (process.defaultApp) {
    // A generic Electron binary needs the script path to register this app's URL handler.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(s, process.execPath, [process.argv[1]]);
    }
  } else {
    app.setAsDefaultProtocolClient(s);
  }
}

/** A sibling Dev checkout may have claimed the channel since startup. Prefer
 * the initiating app before OAuth opens, including older checkouts that cannot
 * relay callbacks. Concurrent current checkouts still use the nonce-bound relay. */
export async function openDesktopAuthBrowser(url: string): Promise<void> {
  if (channel() === "dev") registerProtocol();
  await shell.openExternal(url);
}

/** Parse a zeros:// URL and dispatch. Local navigation waits for an explicit
 * renderer subscription, including when every macOS window was closed.
 *
 *  Exported for tests; production callers go through setupDeepLink(). */
export async function handleUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    console.warn("[Zeros] deep-link: invalid URL");
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

  if (action === "chat" || action === "workspace") {
    const link = parseLocalLink(rawUrl);
    if (!link || link.scheme !== scheme()) {
      console.warn("[Zeros] deep-link: invalid Local navigation");
      return;
    }
    emitLocalNavigation(formatLocalLink(link.scheme, link.kind, link.id));
    return;
  }
  if (IS_LOCAL_DEVELOPMENT) return;

  // Query and fragment can carry handoff or pairing secrets; log only scheme and action.
  console.log(`[Zeros] deep-link: ${parsed.protocol}//${action}`);

  if (action === "auth") {
    // Handoff tickets are short-lived, single-use codes redeemed over HTTPS with
    // main's PKCE verifier; raw tokens never enter OS URLs. Prefer fragment values
    // to keep them out of redirect observers, retaining the query fallback.
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
      const { completeGithubAppConnection, relayGithubAppCallback } = await import("./github-app-flow");
      // A cold-launched sibling Dev window may never load its renderer (its
      // dev server may be stopped). Forward first; only the owner exchanges.
      if (relayGithubAppCallback({ nonce, error })) return;
      // main.ts creates the window inside that same whenReady turn, so by the
      // time we resume `emitEvent` no longer buffers. Without this the connected
      // / error events of a cold-launch callback are sent to a document that
      // cannot receive them: credential stored, but no toast, no analytics, and
      // no auth-cache invalidation.
      await whenRendererReady();
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
      // The invite-only deep-link subscriber drops this error; use its typed event.
      emitEvent("project-open-failed", {
        root: null,
        reason: "The link didn't include a folder to open.",
      });
      return;
    }
    try {
      assertIsDirectory(pathParam);
      // A web page can fire this link: refuse system/home roots to avoid exhausting
      // watchers or widening the exposed file/PTY surface.
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
      console.error(`[Zeros] deep-link open failed: ${JSON.stringify(reason).slice(0, 2_048)}`);
      // Use the typed failure event; the invite-only deep-link subscriber ignores it.
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

  // Windows/Linux launch a second process for links; the lock routes them to
  // the existing app and enables second-instance handling on macOS too.
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

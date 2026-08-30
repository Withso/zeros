// Shared session-aware hub for app.zeros.build — served at BOTH `/`
// (functions/index.ts) and `/launch` (functions/launch.ts).
//
// The desktop opens this with the handoff context (scheme/nonce/challenge) in the
// query. We ALSO persist that context in a short-lived host-only cookie so it
// SURVIVES the OAuth round-trip (/auth/callback's return always points back here
// explicitly, so there is no provider-level "Site URL" fallback to rescue
// anymore) — otherwise the user lands on a context-less page after sign-in
// instead of seeing "Launch Zeros". After sign-in everyone returns to the
// canonical hub (root `/`) when context exists; an explicit context-less
// `/launch` entry remains on `/launch` and shows desktop guidance.
//
// Three outcomes:
//   • signed out                  → one entry point into Hosted AuthKit
//                                    (→ /auth/start on THIS host — the separate
//                                    auth.zeros.build sign-in page is retired)
//   • signed in + handoff context → "Launch Zeros" (mint a ticket, deep-link it,
//                                    opening the desktop-supplied `scheme` — one of
//                                    the per-channel schemes in lib/schemes.mjs)
//   • signed in, no context       → organization management dashboard
//
// scheme/nonce/challenge are validated (scheme allow-list + base64url/uuid
// charset) before being echoed into the page, so they can't inject markup/JS.

import { getVerifiedSessionWithId, type Env } from "./session";
import { TOKENISH } from "./handoff-security";
import { html, shell } from "./page";
import { appOrigin } from "./hosts";
// Per-channel deep-link allow-list — see lib/schemes.mjs. Imported, never
// re-declared: a local copy here is what dropped Alpha's sign-in handoff.
import { SCHEMES } from "./schemes.mjs";
import {
  accountAccessPage,
  accountRecoveryPage,
  dashboardPage,
  dashboardReturnUrl,
  parseAccountResolutionError,
  type DashboardMe,
} from "./dashboard.mjs";
import { proxyControlPlane } from "./control-plane-proxy";
import {
  browserAuthStartOptions,
  legacyDesktopHandoffEnabled,
} from "./workos-browser.mjs";

const HANDOFF_COOKIE = "zeros_handoff";
const HANDOFF_TTL_S = 600; // 10 min — matches the desktop's pending-nonce window.

interface Handoff {
  scheme: string;
  nonce: string;
  challenge: string;
}

function valid(h: Handoff | null | undefined): h is Handoff {
  return (
    !!h &&
    SCHEMES.has(h.scheme) &&
    TOKENISH.test(h.nonce) &&
    TOKENISH.test(h.challenge)
  );
}

function readHandoffCookie(request: Request): Handoff | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const seg = part.trim();
    if (!seg.startsWith(`${HANDOFF_COOKIE}=`)) continue;
    try {
      const v = JSON.parse(
        decodeURIComponent(seg.slice(HANDOFF_COOKIE.length + 1)),
      );
      const h: Handoff = {
        scheme: v?.scheme,
        nonce: v?.nonce,
        challenge: v?.challenge,
      };
      return valid(h) ? h : null;
    } catch {
      return null;
    }
  }
  return null;
}

function setHandoffCookie(headers: Headers, h: Handoff): void {
  const json = encodeURIComponent(JSON.stringify(h));
  // Host-only: the whole OAuth round-trip happens on this host now, so nothing
  // needs the old .zeros.build parent-domain scope.
  headers.append(
    "Set-Cookie",
    `${HANDOFF_COOKIE}=${json}; Path=/; Max-Age=${HANDOFF_TTL_S}; SameSite=Lax; Secure; HttpOnly`,
  );
}

// Sign-in starts on this host and then hands the complete ceremony to the
// hosted provider UI. Authentication-method selection, verification, MFA,
// recovery, and bot defenses stay outside application code.
function signedOut(env: Env, returnTo: string): string {
  const links = browserAuthStartOptions(env, returnTo)
    .map(
      ({ label, href }) =>
        `<a class="btn" href="${href.replaceAll("&", "&amp;")}">${label}</a>`,
    )
    .join("\n          ");
  return `<div class="title">Sign in to Zeros</div>
          <div class="sub">Sign in or create an account securely.</div>
          ${links}`;
}

// Sign-out is local too (functions/auth/logout.ts): deletes the KV session,
// clears the cookie (both scopes), and ends the Auth0 IdP session, returning
// the user to the hub afterwards.
function signOutUrl(env: Env): string {
  return `/auth/logout?return=${encodeURIComponent(`${appOrigin(env)}/`)}`;
}

function signOutLink(env: Env): string {
  return `<a class="msg" href="${signOutUrl(env)}" style="display:inline-block;margin-top:1rem;color:#a1a1aa;text-decoration:underline;">Sign out</a>`;
}

async function dashboard(
  request: Request,
  env: Env,
  verified: NonNullable<Awaited<ReturnType<typeof getVerifiedSessionWithId>>>,
): Promise<string> {
  const user = verified.data;
  let me: DashboardMe | null = null;
  let loadError: string | null = null;
  try {
    // Use the same server-only boundary as browser revalidation. In particular,
    // this rotates and retries an expired access token once instead of rendering
    // a false outage until the user presses Retry.
    const headers = new Headers({ accept: "application/json" });
    const cookie = request.headers.get("Cookie");
    if (cookie) headers.set("Cookie", cookie);
    const response = await proxyControlPlane(
      new Request(new URL("/api/v1/me", request.url), { headers }),
      env,
      verified,
    );
    const body: unknown = await response.json();
    if (!response.ok) {
      const resolution = parseAccountResolutionError(response.status, body);
      if (resolution?.kind === "recovery_required") {
        return accountRecoveryPage({
          session: user,
          recoveryCode: resolution.recoveryCode,
          signOutHref: signOutUrl(env),
        });
      }
      if (resolution) {
        return accountAccessPage({
          session: user,
          kind: resolution.kind,
          signOutHref: signOutUrl(env),
        });
      }
      throw new Error(`status ${response.status}`);
    }
    me = body as DashboardMe;
  } catch {
    loadError =
      "Couldn't reach the organization service. Your account is still signed in.";
  }
  return dashboardPage({
    session: user,
    me,
    requestUrl: request.url,
    signOutHref: signOutUrl(env),
    loadError,
  });
}

function signedInNoHandoff(env: Env): string {
  return `<div class="title">You're signed in</div>
          <div class="sub">Open the Zeros desktop app and choose “Sign in” to connect this account.</div>
          ${signOutLink(env)}`;
}

function launchInner(env: Env, h: Handoff): string {
  // h is validated; JSON.stringify into the script is safe.
  const script = `
    const SCHEME = ${JSON.stringify(h.scheme)};
    const NONCE = ${JSON.stringify(h.nonce)};
    const CHALLENGE = ${JSON.stringify(h.challenge)};
    const btn = document.getElementById("launch");
    const msg = document.getElementById("msg");
    function fail(t) { msg.textContent = t; }
    async function launch() {
      msg.textContent = "Opening Zeros…";
      try {
        const res = await fetch("/handoff/mint", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ challenge: CHALLENGE, nonce: NONCE }),
        });
        if (!res.ok) return fail("Couldn't prepare the handoff. Please try signing in again.");
        const data = await res.json();
        if (!data || !data.ticket) return fail("Couldn't prepare the handoff. Please try again.");
        const link = SCHEME + "://auth/callback#ticket=" + encodeURIComponent(data.ticket) + "&nonce=" + encodeURIComponent(NONCE);
        window.location.href = link;
        msg.textContent = "Opening Zeros… you can close this tab.";
      } catch (e) {
        fail("Something went wrong. Please try again.");
      }
    }
    btn.addEventListener("click", launch);
  `;
  return `<div class="title">You're signed in</div>
          <div class="sub">Launch the desktop app to finish signing in.</div>
          <button class="btn" id="launch" type="button">Launch Zeros</button>
          <div class="msg" id="msg"></div>
          ${signOutLink(env)}
          <script>${script}</script>`;
}

export async function renderHub(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const fromUrl: Handoff = {
    scheme: url.searchParams.get("scheme") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    challenge: url.searchParams.get("challenge") ?? "",
  };
  // Prefer fresh URL params; fall back to the cookie (rescues a Site-URL fallback
  // that dropped the query during the OAuth round-trip).
  const ctx = valid(fromUrl) ? fromUrl : readHandoffCookie(request);
  const hasHandoff = valid(ctx);

  // Verified read: re-proves a stale session against Auth0 and drops it if the
  // user was deleted/blocked, so we never render "signed in" for a dead account.
  const verified = await getVerifiedSessionWithId(env, request);
  const user = verified?.data ?? null;

  const finish = (body: string): Response => {
    const res = html(body);
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Pragma", "no-cache");
    // Persist the (fresh, URL-supplied) context so it survives OAuth.
    if (valid(fromUrl)) setHandoffCookie(res.headers, fromUrl);
    return res;
  };

  if (!user) {
    // Carry the context through the OAuth round-trip so the return comes back
    // to the hub with it (the cookie is the belt-and-suspenders fallback).
    const self = hasHandoff
      ? `${appOrigin(env)}/?scheme=${encodeURIComponent(ctx.scheme)}&nonce=${encodeURIComponent(ctx.nonce)}&challenge=${encodeURIComponent(ctx.challenge)}`
      : dashboardReturnUrl(appOrigin(env), request.url);
    return finish(shell("Sign in to Zeros", signedOut(env, self)));
  }
  if (!hasHandoff) {
    if (url.pathname === "/launch") {
      return finish(shell("Signed in", signedInNoHandoff(env)));
    }
    return finish(await dashboard(request, env, verified!));
  }
  // WorkOS desktop credentials must come from the independent public-client
  // flow in Phase 3. Never fall back to copying or refreshing this browser
  // session through the Auth0-era ticket broker.
  if (!legacyDesktopHandoffEnabled(env)) {
    return finish(shell("Signed in", signedInNoHandoff(env)));
  }
  return finish(shell("Launch Zeros", launchInner(env, ctx)));
}

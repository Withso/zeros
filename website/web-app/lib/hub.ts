// Shared session-aware hub for app.zeros.build — served at BOTH `/`
// (functions/index.ts) and `/launch` (functions/launch.ts).
//
// The desktop opens this with the handoff context (scheme/nonce/challenge) in the
// query. We ALSO persist that context in a short-lived host-only cookie so it
// SURVIVES the OAuth round-trip (/auth/callback's return always points back here
// explicitly, so there is no provider-level "Site URL" fallback to rescue
// anymore) — otherwise the user lands on a context-less page after sign-in
// instead of seeing "Launch Zeros". After sign-in everyone returns to the
// canonical hub (root `/`), which then reads the context from the URL or cookie.
//
// Three outcomes:
//   • signed out                  → "Continue with Google / GitHub" right here
//                                    (→ /auth/start on THIS host — the separate
//                                    auth.zeros.build sign-in page is retired)
//   • signed in + handoff context → "Launch Zeros" (mint a ticket, deep-link it,
//                                    opening the desktop-supplied `scheme` — one of
//                                    the per-channel schemes in lib/schemes.mjs)
//   • signed in, no context       → "open the desktop app"
//
// scheme/nonce/challenge are validated (scheme allow-list + base64url/uuid
// charset) before being echoed into the page, so they can't inject markup/JS.

import { getVerifiedSession, type Env } from "./session";
import { TOKENISH } from "./util";
import { html, shell } from "./page";
import { appOrigin } from "./hosts";
// Per-channel deep-link allow-list — see lib/schemes.mjs. Imported, never
// re-declared: a local copy here is what dropped Alpha's sign-in handoff.
import { SCHEMES } from "./schemes.mjs";

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

// Sign-in happens right here: the OAuth dance (/auth/start → Auth0 → the
// provider → /auth/callback) lives on this same host, so the signed-out state
// offers the providers directly — no interstitial page, one less redirect.
function signedOut(returnTo: string): string {
  const r = encodeURIComponent(returnTo);
  return `<div class="title">Sign in to Zeros</div>
          <div class="sub">Choose a provider. New here? Signing in creates your account.</div>
          <a class="btn" href="/auth/start?provider=google&amp;return=${r}">Continue with Google</a>
          <a class="btn" href="/auth/start?provider=github&amp;return=${r}">Continue with GitHub</a>`;
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
  const user = await getVerifiedSession(env, request);

  const finish = (body: string): Response => {
    const res = html(body);
    // Persist the (fresh, URL-supplied) context so it survives OAuth.
    if (valid(fromUrl)) setHandoffCookie(res.headers, fromUrl);
    return res;
  };

  if (!user) {
    // Carry the context through the OAuth round-trip so the return comes back
    // to the hub with it (the cookie is the belt-and-suspenders fallback).
    const q = hasHandoff
      ? `?scheme=${encodeURIComponent(ctx.scheme)}&nonce=${encodeURIComponent(ctx.nonce)}&challenge=${encodeURIComponent(ctx.challenge)}`
      : "";
    const self = `${appOrigin(env)}/${q}`;
    return finish(shell("Sign in to Zeros", signedOut(self)));
  }
  if (!hasHandoff) {
    return finish(shell("Signed in", signedInNoHandoff(env)));
  }
  return finish(shell("Launch Zeros", launchInner(env, ctx)));
}

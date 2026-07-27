// ──────────────────────────────────────────────────────────
// IPC commands: web sign-in handoff (begin + redeem)
// ──────────────────────────────────────────────────────────
//
// The WEBSITE owns OAuth now. The desktop opens the system browser at
// app.zeros.build/launch and receives back an opaque, single-use TICKET over a
// zeros:// deep link. These two commands are the desktop half of the
// handoff-PKCE exchange, and they keep the PKCE *verifier* entirely in the MAIN
// process (safeStorage) — a renderer compromise never sees it:
//
//   auth_begin_handoff({ nonce }) → { challenge }
//       Mints a high-entropy verifier, stores it in the OS keystore, and returns
//       ONLY challenge = base64url(SHA-256(verifier)). The renderer puts the
//       challenge in the /launch URL; the web binds the minted ticket to it.
//
//   auth_redeem_handoff({ ticket, nonce }) → { access_token, sub, email, name } | { error }
//       Loads the pending verifier, POSTs { ticket, verifier } to
//       app.zeros.build/handoff/redeem over HTTPS (NO CORS — this is main, not
//       the sandboxed renderer), clears the verifier, and persists the redeemed
//       Auth0 token pair straight into the keychain here (persistSession in
//       auth-session.ts). It returns ONLY the short-lived access token + identity
//       claims to the renderer — the REFRESH token never crosses into the
//       renderer's JS heap (H1), so an XSS active during sign-in can't capture it.
//       An intercepted ticket is useless: the attacker lacks the verifier, which
//       never left this process.
//
//   auth_peek_handoff() → { nonce, expiresAt } | { nonce: null }
//       Returns the pending handoff's NONCE + expiry — NEVER the verifier. Dev
//       worktrees share one login but each registers the SAME zeros-dev:// scheme,
//       so macOS delivers the returning callback to only ONE instance — not
//       necessarily the one that started the sign-in. The receiving instance's
//       renderer peeks here to recognise a handoff a SIBLING worktree began
//       (whose nonce lives only in that sibling's localStorage) and complete it.
//       The nonce is a non-secret single-use CSRF binding; without the (main-only)
//       verifier it can't redeem anything, so exposing it adds no attack surface.
//
// SECURITY:
//   • The redeem target is fixed here (env override for dev/preview only) —
//     NEVER taken from the renderer, so an XSS can't redirect the handoff to
//     exfiltrate it.
//   • Single-pending: begin OVERWRITES the stored verifier and redeem CLEARS it
//     (success or failure), so at most one verifier is ever at rest and it is
//     strictly single-use. Matches the renderer's single pendingNonce.
//   • SHA-256 is taken over the verifier's base64url STRING bytes on both sides
//     (here and the web /handoff/redeem) so the challenge comparison matches.
//   • Nothing here is logged — verifier, ticket, and tokens are all secrets.
// ──────────────────────────────────────────────────────────

import crypto from "node:crypto";
import type { CommandHandler } from "../router";
import { deleteSecret, getSecret, setSecret } from "../../secret-store";
import { persistSession } from "./auth-session";

// safeStorage account for the single pending handoff verifier. Distinct from the
// "supabase:" session namespace (auth-storage.ts) so the two never collide.
const PENDING_KEY = "handoff-verifier:pending";

/** Base URL of the web hub that hosts /handoff/redeem. Fixed to the deployed app
 *  in prod; overridable via env ONLY for local/preview iteration. NEVER
 *  renderer-supplied (that would let an XSS point the handoff at an attacker). */
function handoffBaseUrl(): string {
  const raw =
    process.env.ZEROS_APP_BASE_URL ||
    process.env.VITE_APP_BASE_URL ||
    "https://app.zeros.build";
  return raw.replace(/\/+$/, "");
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function requireNonce(raw: unknown): string {
  const n = typeof raw === "string" ? raw.trim() : "";
  if (!n) throw new Error("auth handoff: missing 'nonce'");
  return n;
}

/** Mint a PKCE verifier (kept in main's safeStorage), return its S256 challenge. */
export const authBeginHandoff: CommandHandler = (args) => {
  const nonce = requireNonce(args.nonce);
  // Expiry travels WITH the pending handoff (renderer-supplied, else a 10-min
  // default) so a SIBLING worktree that peeks this record — its own localStorage
  // has no nonce for a handoff another instance began — can still enforce the
  // same window before redeeming. Matches the initiator's localStorage expiry.
  const expiresAt =
    typeof args.expiresAt === "number" && Number.isFinite(args.expiresAt)
      ? args.expiresAt
      : Date.now() + 10 * 60_000;
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  // Persisted (encrypted) so a redeem after a renderer reload OR a cold launch
  // BY the zeros:// deep link still finds the verifier. Overwrites any prior
  // pending handoff — last initiated wins, mirroring the renderer's pendingNonce.
  setSecret(PENDING_KEY, JSON.stringify({ nonce, verifier, expiresAt }));
  return { challenge };
};

/** Return the pending handoff's nonce + expiry (NEVER the verifier) so any dev
 *  worktree instance can recognise + complete a sign-in a sibling instance began.
 *  See the header note on the shared zeros-dev:// scheme. */
export const authPeekHandoff: CommandHandler = () => {
  const raw = getSecret(PENDING_KEY);
  if (!raw) return { nonce: null, expiresAt: null };
  try {
    const p = JSON.parse(raw) as { nonce?: unknown; expiresAt?: unknown };
    return {
      nonce: typeof p.nonce === "string" ? p.nonce : null,
      expiresAt: typeof p.expiresAt === "number" ? p.expiresAt : null,
    };
  } catch {
    return { nonce: null, expiresAt: null };
  }
};

/** Redeem an opaque ticket for a freshly-minted Auth0 session, persist the token
 *  pair in the keychain, and return ONLY the access token + identity (never the
 *  refresh token) to the renderer. */
export const authRedeemHandoff: CommandHandler = async (args) => {
  const nonce = requireNonce(args.nonce);
  const ticket = typeof args.ticket === "string" ? args.ticket : "";
  if (!ticket) return { error: "missing_ticket" };

  const rawPending = getSecret(PENDING_KEY);
  // Single-use: clear the verifier regardless of what happens next.
  deleteSecret(PENDING_KEY);
  if (!rawPending) return { error: "no_pending_handoff" };

  let pending: { nonce?: unknown; verifier?: unknown };
  try {
    pending = JSON.parse(rawPending) as { nonce?: unknown; verifier?: unknown };
  } catch {
    return { error: "no_pending_handoff" };
  }
  const verifier = typeof pending.verifier === "string" ? pending.verifier : "";
  // The deep-link nonce must match the one this instance began the handoff with
  // (the renderer also enforces this; belt-and-suspenders against a stale verifier).
  if (!verifier || pending.nonce !== nonce) return { error: "nonce_mismatch" };

  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = await fetch(`${handoffBaseUrl()}/handoff/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket, verifier }),
    });
  } catch (err) {
    console.warn(`[auth] handoff redeem network error: ${(err as Error).message}`);
    return { error: "network" };
  }
  if (!res.ok) {
    console.warn(`[auth] handoff redeem rejected: HTTP ${res.status}`);
    return { error: `http_${res.status}` };
  }

  let body: {
    access_token?: unknown;
    refresh_token?: unknown;
    sub?: unknown;
    email?: unknown;
    name?: unknown;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { error: "bad_response" };
  }
  const access_token = typeof body.access_token === "string" ? body.access_token : "";
  const refresh_token = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const sub = typeof body.sub === "string" ? body.sub : "";
  const email = typeof body.email === "string" ? body.email : "";
  const name = typeof body.name === "string" ? body.name : null;
  if (!access_token || !refresh_token || !sub || !email) return { error: "incomplete_session" };
  // Write the FULL pair to the keychain here in main — the refresh token stops at
  // this process boundary and is never handed back over IPC (H1). Guarded: a
  // safeStorage/secrets-file failure must surface as a redeem error (the renderer
  // shows its "couldn't finish signing you in" UI), not reject the IPC invoke.
  try {
    persistSession({ accessToken: access_token, refreshToken: refresh_token, sub, email, name });
  } catch (err) {
    console.warn(`[auth] handoff persistSession failed: ${(err as Error).message}`);
    return { error: "persist_failed" };
  }
  return { access_token, sub, email, name };
};

// Shared session-aware hub for app.zeros.build, served at `/`
// (functions/index.ts).
//
// Two outcomes:
//   • signed out → one entry point into Hosted AuthKit (→ /auth/start on THIS
//                  host)
//   • signed in  → organization management dashboard
//
// The desktop signs in through its own WorkOS PKCE flow
// (/auth/desktop, lib/workos-desktop-authorization.mjs), not through this page.

import { getVerifiedSessionWithId, type Env } from "./session";
import { html, shell } from "./page";
import { appOrigin } from "./hosts";
import {
  accountAccessPage,
  accountDeletionPage,
  accountRecoveryPage,
  dashboardPage,
  dashboardReturnUrl,
  parseAccountResolutionError,
  type DashboardMe,
} from "./dashboard.mjs";
import { proxyControlPlane } from "./control-plane-proxy";
import { browserAuthStartOptions } from "./workos-browser.mjs";

// Sign-in starts on this host and then hands the complete ceremony to the
// hosted provider UI. Authentication-method selection, verification, MFA,
// recovery, and bot defenses stay outside application code.
function signedOut(env: Env, returnTo: string): string {
  const links = browserAuthStartOptions(returnTo)
    .map(
      ({ label, href }) =>
        `<a class="btn" href="${href.replaceAll("&", "&amp;")}">${label}</a>`,
    )
    .join("\n          ");
  return `<div class="title">Sign in to Zeros</div>
          <div class="sub">Sign in or create an account securely.</div>
          ${links}`;
}

// Sign-out (functions/auth/logout.ts) ends the WorkOS browser session and
// returns the user to the hub afterwards.
function signOutUrl(env: Env): string {
  return `/auth/logout?return=${encodeURIComponent(`${appOrigin(env)}/`)}`;
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
      if (resolution?.kind === "account_unavailable") {
        const deletionResponse = await proxyControlPlane(
          new Request(new URL("/api/v1/account/deletion", request.url), {
            headers,
          }),
          env,
          verified,
        );
        const deletionBody: unknown = await deletionResponse
          .json()
          .catch(() => null);
        const deletion =
          deletionBody &&
          typeof deletionBody === "object" &&
          "deletion" in deletionBody
            ? (deletionBody as { deletion?: Record<string, unknown> }).deletion
            : null;
        if (
          deletionResponse.ok &&
          deletion &&
          deletion.state === "scheduled"
        ) {
          return accountDeletionPage({
            session: user,
            deletion,
            signOutHref: signOutUrl(env),
          });
        }
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

export async function renderHub(request: Request, env: Env): Promise<Response> {
  // Verified read: re-proves a stale session and drops it if the user was
  // deleted or blocked, so we never render "signed in" for a dead account.
  const verified = await getVerifiedSessionWithId(env, request);
  const finish = (body: string): Response => {
    const res = html(body);
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Pragma", "no-cache");
    return res;
  };
  if (!verified?.data) {
    const self = dashboardReturnUrl(appOrigin(env), request.url);
    return finish(shell("Sign in to Zeros", signedOut(env, self)));
  }
  return finish(await dashboard(request, env, verified));
}

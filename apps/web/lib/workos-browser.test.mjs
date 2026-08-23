import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKOS_FLOW_COOKIE,
  WORKOS_SESSION_COOKIE,
  beginWorkOSBrowserAuth,
  finishWorkOSBrowserAuth,
  logoutWorkOSBrowserSession,
  legacyDesktopHandoffEnabled,
  safeWorkOSReturnPath,
  workosFlowCookie,
  workosProvider,
  workosSessionCookie,
} from "./workos-browser.mjs";

const FLOW_ID = "A".repeat(43);
const APP_ORIGIN = "https://app-alpha.zeros.build";

function setCookies(response) {
  return typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""];
}

function fakeNamespace(handler) {
  const calls = [];
  return {
    calls,
    idFromName(name) {
      calls.push({ kind: "id", name });
      return { name };
    },
    get(id) {
      return {
        async fetch(request) {
          const body = request.method === "POST" ? await request.json() : null;
          calls.push({ kind: "fetch", id: id.name, request, body });
          return handler({ id: id.name, request, body });
        },
      };
    },
  };
}

test("WorkOS providers map to the qualified social connection names", () => {
  assert.equal(workosProvider("google"), "GoogleOAuth");
  assert.equal(workosProvider("github"), "GitHubOAuth");
  assert.equal(workosProvider("unknown"), null);
});

test("the Auth0-era desktop ticket broker is disabled in WorkOS mode", () => {
  assert.equal(legacyDesktopHandoffEnabled({ AUTH_PROVIDER: "auth0" }), true);
  assert.equal(legacyDesktopHandoffEnabled({ AUTH_PROVIDER: "workos" }), false);
  assert.throws(
    () => legacyDesktopHandoffEnabled({ AUTH_PROVIDER: "invented" }),
    /AUTH_PROVIDER/,
  );
});

test("WorkOS returns are relative and bound to the exact application origin", () => {
  assert.equal(
    safeWorkOSReturnPath(
      `${APP_ORIGIN}/invite?token=safe#finish`,
      APP_ORIGIN,
    ),
    "/invite?token=safe#finish",
  );
  assert.equal(safeWorkOSReturnPath("/settings?tab=members", APP_ORIGIN), "/settings?tab=members");
  assert.equal(safeWorkOSReturnPath("https://evil.example/steal", APP_ORIGIN), "/");
  assert.equal(safeWorkOSReturnPath("//evil.example/steal", APP_ORIGIN), "/");
  assert.equal(safeWorkOSReturnPath("javascript:alert(1)", APP_ORIGIN), "/");
});

test("host-only WorkOS cookies carry only opaque ids with the required flags", () => {
  const flow = workosFlowCookie(FLOW_ID);
  const session = workosSessionCookie(FLOW_ID);

  for (const cookie of [flow, session]) {
    assert.match(cookie, /^__Host-/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.doesNotMatch(cookie, /; Domain=/i);
    assert.doesNotMatch(cookie, /access|refresh|verifier|state/i);
  }
  assert.match(flow, /Max-Age=600/);
  assert.match(session, /Max-Age=2592000/);
});

test("auth start stores PKCE state in the coordinator, not browser cookies", async () => {
  const namespace = fakeNamespace(({ request }) => {
    assert.equal(new URL(request.url).pathname, "/flow/start");
    return Response.json(
      {
        authorizationUrl:
          "https://api.workos.com/user_management/authorize?state=server-state&code_challenge=server-challenge",
      },
      { status: 201 },
    );
  });
  const response = await beginWorkOSBrowserAuth(
    new Request(
      `${APP_ORIGIN}/auth/start?provider=google&return=${encodeURIComponent(`${APP_ORIGIN}/invite?token=safe`)}`,
    ),
    { APP_ORIGIN, AUTH_SESSIONS: namespace },
    { randomId: () => FLOW_ID },
  );

  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /^https:\/\/api\.workos\.com\/user_management\/authorize\?/);
  const cookies = setCookies(response).join("\n");
  assert.match(cookies, new RegExp(`^${WORKOS_FLOW_COOKIE}=${FLOW_ID}`, "m"));
  assert.doesNotMatch(cookies, /server-state|server-challenge|safe/);
  const call = namespace.calls.find((entry) => entry.kind === "fetch");
  assert.deepEqual(call.body, {
    provider: "GoogleOAuth",
    returnPath: "/invite?token=safe",
  });
});

test("callback sets an opaque WorkOS session and clears one-time and legacy cookies", async () => {
  const namespace = fakeNamespace(({ request, body }) => {
    assert.equal(new URL(request.url).pathname, "/flow/complete");
    assert.deepEqual(body, { code: "authorization-code", state: "expected-state" });
    return Response.json({ ok: true, returnPath: "/dashboard" });
  });
  const response = await finishWorkOSBrowserAuth(
    new Request(
      `${APP_ORIGIN}/auth/callback?code=authorization-code&state=expected-state`,
      { headers: { cookie: `${WORKOS_FLOW_COOKIE}=${FLOW_ID}` } },
    ),
    { APP_ORIGIN, AUTH_SESSIONS: namespace },
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${APP_ORIGIN}/dashboard`);
  const cookies = setCookies(response).join("\n");
  assert.match(cookies, new RegExp(`${WORKOS_SESSION_COOKIE}=${FLOW_ID}`));
  assert.match(cookies, new RegExp(`${WORKOS_FLOW_COOKIE}=;`));
  assert.match(cookies, /zeros_session=;/);
  assert.doesNotMatch(cookies, /authorization-code|expected-state|access_token|refresh_token/);
});

test("callback failure never creates a browser session", async () => {
  const namespace = fakeNamespace(() =>
    Response.json({ ok: false, reason: "invalid_flow" }, { status: 401 }),
  );
  const response = await finishWorkOSBrowserAuth(
    new Request(`${APP_ORIGIN}/auth/callback?code=code&state=wrong`, {
      headers: { cookie: `${WORKOS_FLOW_COOKIE}=${FLOW_ID}` },
    }),
    { APP_ORIGIN, AUTH_SESSIONS: namespace },
  );

  assert.equal(response.status, 400);
  assert.equal(
    setCookies(response).some((cookie) => cookie.startsWith(`${WORKOS_SESSION_COOKIE}=`)),
    false,
  );
});

test("logout clears the browser cookie even when the coordinator is unavailable", async () => {
  const namespace = fakeNamespace(() => {
    throw new Error("coordinator unavailable");
  });
  const response = await logoutWorkOSBrowserSession(
    new Request(`${APP_ORIGIN}/auth/logout`, {
      headers: { cookie: `${WORKOS_SESSION_COOKIE}=${FLOW_ID}` },
    }),
    { APP_ORIGIN, AUTH_SESSIONS: namespace },
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${APP_ORIGIN}/`);
  assert.ok(
    setCookies(response).some((cookie) =>
      cookie.startsWith(`${WORKOS_SESSION_COOKIE}=;`),
    ),
  );
});

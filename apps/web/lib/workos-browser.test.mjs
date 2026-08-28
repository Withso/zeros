import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKOS_FLOW_COOKIE,
  WORKOS_SESSION_COOKIE,
  beginWorkOSBrowserAuth,
  browserAuthStartOptions,
  finishWorkOSBrowserAuth,
  legacyDesktopHandoffEnabled,
  logoutWorkOSBrowserSession,
  readWorkOSBrowserSession,
  refreshWorkOSBrowserSession,
} from "./workos-browser.mjs";

const SESSION_ID = "A".repeat(43);
const APP_ORIGIN = "https://app-alpha.zeros.build";
const CONTROL_PLANE_URL = "https://api-alpha.zeros.build";
const ENV = { APP_ORIGIN, CONTROL_PLANE_URL };

test("the Auth0-era desktop ticket broker is disabled in WorkOS mode", () => {
  assert.equal(legacyDesktopHandoffEnabled({ AUTH_PROVIDER: "auth0" }), true);
  assert.equal(legacyDesktopHandoffEnabled({ AUTH_PROVIDER: "workos" }), false);
  assert.throws(
    () => legacyDesktopHandoffEnabled({ AUTH_PROVIDER: "invented" }),
    /AUTH_PROVIDER/,
  );
});

test("the signed-out hub preserves Auth0 rollback links but gives WorkOS one Hosted AuthKit entry", () => {
  const returnTo = `${APP_ORIGIN}/after`;
  assert.deepEqual(
    browserAuthStartOptions({ AUTH_PROVIDER: "workos" }, returnTo),
    [
      {
        label: "Continue",
        href: `/auth/start?return=${encodeURIComponent(returnTo)}`,
      },
    ],
  );
  assert.deepEqual(
    browserAuthStartOptions({ AUTH_PROVIDER: "auth0" }, returnTo),
    [
      {
        label: "Continue with Google",
        href: `/auth/start?provider=google&return=${encodeURIComponent(returnTo)}`,
      },
      {
        label: "Continue with GitHub",
        href: `/auth/start?provider=github&return=${encodeURIComponent(returnTo)}`,
      },
    ],
  );
});

test("auth start is a stateless facade for the matching Railway service", async () => {
  const calls = [];
  const response = await beginWorkOSBrowserAuth(
    new Request(
      `${APP_ORIGIN}/auth/start?provider=github&connection=conn_attacker&return=${encodeURIComponent(`${APP_ORIGIN}/after`)}`,
      { headers: { cookie: "unrelated=value" } },
    ),
    ENV,
    {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, {
          status: 303,
          headers: {
            location: "https://api.workos.com/user_management/authorize",
            "set-cookie": `${WORKOS_FLOW_COOKIE}=${SESSION_ID}; Secure; HttpOnly`,
          },
        });
      },
    },
  );

  assert.equal(response.status, 303);
  assert.equal(
    calls[0].url,
    `${CONTROL_PLANE_URL}/auth/start?return=${encodeURIComponent(`${APP_ORIGIN}/after`)}`,
  );
  assert.equal(calls[0].init.headers.get("cookie"), null);
  assert.equal(calls[0].init.redirect, "manual");
  assert.match(response.headers.get("set-cookie"), new RegExp(SESSION_ID));
});

test("callback and logout forward only their required opaque cookie", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, {
      status: 303,
      headers: { location: `${APP_ORIGIN}/` },
    });
  };
  await finishWorkOSBrowserAuth(
    new Request(`${APP_ORIGIN}/auth/callback?code=code&state=state`, {
      headers: {
        cookie: `${WORKOS_FLOW_COOKIE}=${SESSION_ID}; unrelated=private`,
      },
    }),
    ENV,
    { fetch },
  );
  await logoutWorkOSBrowserSession(
    new Request(`${APP_ORIGIN}/auth/logout?return=%2Fafter`, {
      headers: {
        cookie: `${WORKOS_SESSION_COOKIE}=${SESSION_ID}; unrelated=private`,
      },
    }),
    ENV,
    { fetch },
  );

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      `${CONTROL_PLANE_URL}/auth/callback?code=code&state=state`,
      `${CONTROL_PLANE_URL}/auth/logout?return=%2Fafter`,
    ],
  );
  assert.deepEqual(
    calls.map((call) => call.init.headers.get("cookie")),
    [
      `${WORKOS_FLOW_COOKIE}=${SESSION_ID}`,
      `${WORKOS_SESSION_COOKIE}=${SESSION_ID}`,
    ],
  );
});

test("session lookup forwards only the opaque cookie and validates Railway data", async () => {
  let forwarded;
  const result = await readWorkOSBrowserSession(
    ENV,
    new Request(`${APP_ORIGIN}/`, {
      headers: {
        cookie: `${WORKOS_SESSION_COOKIE}=${SESSION_ID}; unrelated=private`,
      },
    }),
    {
      fetch: async (url, init) => {
        forwarded = { url, init };
        return Response.json({
          status: "active",
          revision: 7,
          data: {
            sub: "user_01TEST",
            email: "user@example.com",
            name: "User",
            accessToken: "signed-access-token",
            refreshToken: null,
            verifiedAt: 1_800_000_000_000,
          },
        });
      },
    },
  );

  assert.equal(forwarded.url, `${CONTROL_PLANE_URL}/auth/browser/session`);
  assert.equal(
    forwarded.init.headers.cookie,
    `${WORKOS_SESSION_COOKIE}=${SESSION_ID}`,
  );
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.revision, 7);
  assert.equal(result.data.accessToken, "signed-access-token");
});

test("session lookup rejects an oversized Railway response", async () => {
  let cancelled = false;
  await assert.rejects(
    readWorkOSBrowserSession(
      ENV,
      new Request(`${APP_ORIGIN}/`, {
        headers: { cookie: `${WORKOS_SESSION_COOKIE}=${SESSION_ID}` },
      }),
      {
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(200 * 1024));
                controller.enqueue(new Uint8Array(100 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      },
    ),
    /invalid response/,
  );
  assert.equal(cancelled, true);
});

test("forced refresh carries the revision observed with the rejected bearer", async () => {
  let forwarded;
  const result = await refreshWorkOSBrowserSession(ENV, SESSION_ID, 7, {
    fetch: async (url, init) => {
      forwarded = { url, init };
      return Response.json({
        status: "active",
        revision: 8,
        data: {
          sub: "user_01TEST",
          email: "user@example.com",
          name: null,
          accessToken: "signed-access-token-2",
          refreshToken: null,
          verifiedAt: 1_800_000_000_000,
        },
      });
    },
  });

  assert.equal(forwarded.url, `${CONTROL_PLANE_URL}/auth/browser/refresh`);
  assert.equal(forwarded.init.headers.get("x-zeros-session-revision"), "7");
  assert.equal(result.status, "active");
});

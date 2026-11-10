import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKOS_FLOW_COOKIE,
  WORKOS_HANDOFF_COOKIE,
  WORKOS_SESSION_COOKIE,
  beginWorkOSBrowserAuth,
  browserAuthStartOptions,
  finishWorkOSBrowserAuth,
  logoutWorkOSBrowserSession,
  readWorkOSBrowserSession,
  refreshWorkOSBrowserSession,
  signInPage,
} from "./workos-browser.mjs";

const SESSION_ID = "A".repeat(43);
const APP_ORIGIN = "https://app-alpha.zeros.build";
const CONTROL_PLANE_URL = "https://api-alpha.zeros.build";
const ENV = { APP_ORIGIN, CONTROL_PLANE_URL };

test("the signed-out hub offers Google and GitHub", () => {
  const returnTo = `${APP_ORIGIN}/after`;
  assert.deepEqual(browserAuthStartOptions(returnTo), [
    {
      label: "Continue with Google",
      provider: "google",
      href: `/auth/start?return=${encodeURIComponent(returnTo)}&provider=google`,
    },
    {
      label: "Continue with GitHub",
      provider: "github",
      href: `/auth/start?return=${encodeURIComponent(returnTo)}&provider=github`,
    },
  ]);
});

test("the sign-in page stacks Continue with Google and Continue with GitHub", () => {
  const page = signInPage(`${APP_ORIGIN}/after?a=1&b=2`);
  const returnTo = encodeURIComponent(`${APP_ORIGIN}/after?a=1&b=2`);

  assert.match(page, /<title>Sign in to Zeros<\/title>/);
  assert.match(page, /<div class="title">Sign in to Zeros<\/div>/);
  assert.match(page, /<div class="sub">Sign in or create an account to continue\.<\/div>/);
  const actions = /<div class="acts stack">([\s\S]*?)<\/div>/.exec(page)?.[1] ?? "";
  const buttons = [...actions.matchAll(/<a class="btn" href="([^"]+)"><svg[^>]*>[\s\S]*?<\/svg>([^<]+)<\/a>/g)];
  assert.deepEqual(
    buttons.map(([, href, label]) => [href, label]),
    [
      [`/auth/start?return=${returnTo}&amp;provider=google`, "Continue with Google"],
      [`/auth/start?return=${returnTo}&amp;provider=github`, "Continue with GitHub"],
    ],
  );
  assert.doesNotMatch(page, />Continue<\/a>/);
});

test("auth start is a stateless facade for the matching Railway service", async () => {
  const calls = [];
  const response = await beginWorkOSBrowserAuth(
    new Request(
      `${APP_ORIGIN}/auth/start?provider=github&connection=conn_attacker&organization=org_attacker&return=${encodeURIComponent(`${APP_ORIGIN}/after`)}`,
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
    `${CONTROL_PLANE_URL}/auth/start?return=${encodeURIComponent(`${APP_ORIGIN}/after`)}&provider=github`,
  );
  assert.equal(calls[0].init.headers.get("cookie"), null);
  assert.equal(calls[0].init.redirect, "manual");
  assert.match(response.headers.get("set-cookie"), new RegExp(SESSION_ID));
});

test("the isolated Ops project uses its separate Railway browser namespace", async () => {
  let forwarded;
  await beginWorkOSBrowserAuth(
    new Request("https://ops-alpha.zeros.build/auth/start"),
    {
      ...ENV,
      APP_ORIGIN: "https://ops-alpha.zeros.build",
      WORKOS_BROWSER_ROUTE_PREFIX: "/ops",
    },
    {
      fetch: async (url, init) => {
        forwarded = { url, init };
        return new Response(null, {
          status: 303,
          headers: {
            location: "https://api.workos.com/user_management/authorize",
          },
        });
      },
    },
  );
  assert.equal(forwarded.url, `${CONTROL_PLANE_URL}/ops/auth/start`);
});

test("auth start forwards only an exact Google or GitHub choice, never on Ops", async () => {
  const forwarded = [];
  const fetch = async (url) => {
    forwarded.push(new URL(url));
    return new Response(null, {
      status: 303,
      headers: { location: "https://api.workos.com/user_management/authorize" },
    });
  };
  for (const provider of ["google", "github"]) {
    await beginWorkOSBrowserAuth(new Request(`${APP_ORIGIN}/auth/start?provider=${provider}`), ENV, { fetch });
  }
  for (const provider of ["GitHubOAuth", "GoogleOAuth", "authkit", "Google", "sso", ""]) {
    await beginWorkOSBrowserAuth(new Request(`${APP_ORIGIN}/auth/start?provider=${provider}`), ENV, { fetch });
  }
  await beginWorkOSBrowserAuth(new Request(`${APP_ORIGIN}/auth/start?provider=google&provider=github`), ENV, { fetch });
  await beginWorkOSBrowserAuth(
    new Request("https://ops-alpha.zeros.build/auth/start?provider=github&max_age=300"),
    { ...ENV, APP_ORIGIN: "https://ops-alpha.zeros.build", WORKOS_BROWSER_ROUTE_PREFIX: "/ops" },
    { fetch },
  );

  assert.deepEqual(
    forwarded.map((url) => url.searchParams.get("provider")),
    ["google", "github", null, null, null, null, null, null, null, null],
  );
  assert.equal(forwarded.at(-1).pathname, "/ops/auth/start");
  assert.equal(forwarded.at(-1).searchParams.get("max_age"), "300");
});

test("an unreachable sign-in service ends on the shared page with Try again", async () => {
  const response = await beginWorkOSBrowserAuth(
    new Request(`${APP_ORIGIN}/auth/start?provider=google`),
    ENV,
    {
      fetch: async () => {
        throw new Error("offline");
      },
    },
  );
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body, /<div class="title">Sign-in didn’t finish<\/div>/);
  assert.match(body, /<div class="sub">Sign-in is unavailable right now\. Try again shortly\.<\/div>/);
  assert.match(body, /<a class="btn" href="\/">Try again<\/a>/);
});

test("auth start preserves only the fixed step-up max_age", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, {
      status: 303,
      headers: { location: "https://api.workos.com/user_management/authorize" },
    });
  };
  await beginWorkOSBrowserAuth(
    new Request(`${APP_ORIGIN}/auth/start?max_age=300`),
    ENV,
    { fetch },
  );
  await beginWorkOSBrowserAuth(
    new Request(`${APP_ORIGIN}/auth/start?max_age=99999`),
    ENV,
    { fetch },
  );
  assert.equal(new URL(calls[0].url).searchParams.get("max_age"), "300");
  assert.equal(new URL(calls[1].url).searchParams.has("max_age"), false);
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

test("callback forwards the exact Hosted AuthKit hand-off marker so Railway hands off once", async () => {
  const forwarded = [];
  const fetch = async (_url, init) => {
    forwarded.push(init.headers.get("cookie"));
    return new Response(null, { status: 400 });
  };
  for (const marker of ["1", "yes"]) {
    await finishWorkOSBrowserAuth(
      new Request(`${APP_ORIGIN}/auth/callback?code=code&state=state`, {
        headers: {
          cookie: `${WORKOS_FLOW_COOKIE}=${SESSION_ID}; ${WORKOS_HANDOFF_COOKIE}=${marker}`,
        },
      }),
      ENV,
      { fetch },
    );
  }
  await beginWorkOSBrowserAuth(
    new Request(`${APP_ORIGIN}/auth/start?provider=github`, {
      headers: { cookie: `${WORKOS_HANDOFF_COOKIE}=1` },
    }),
    ENV,
    { fetch },
  );

  assert.deepEqual(forwarded, [
    `${WORKOS_FLOW_COOKIE}=${SESSION_ID}; ${WORKOS_HANDOFF_COOKIE}=1`,
    `${WORKOS_FLOW_COOKIE}=${SESSION_ID}`,
    null,
  ]);
});

test("callback rehomes the completion document and every Set-Cookie header", async () => {
  const upstreamHeaders = new Headers({
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  const completionDocument =
    '<!doctype html><meta http-equiv="refresh" content="0;url=https://app-alpha.zeros.build/">';
  const expectedCookies = [
    `${WORKOS_SESSION_COOKIE}=${SESSION_ID}; Path=/; Secure; HttpOnly; SameSite=Strict`,
    `${WORKOS_FLOW_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    "zeros_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
  ];
  for (const cookie of expectedCookies) {
    upstreamHeaders.append("set-cookie", cookie);
  }
  const upstream = new Response(completionDocument, {
    status: 200,
    headers: upstreamHeaders,
  });
  // Exercise the Cloudflare Workers branch rather than Node's getSetCookie()
  // compatibility branch.
  Object.defineProperty(upstream.headers, "getAll", {
    value(name) {
      assert.equal(name, "Set-Cookie");
      return expectedCookies;
    },
  });

  const response = await finishWorkOSBrowserAuth(
    new Request(`${APP_ORIGIN}/auth/callback?code=code&state=state`, {
      headers: { cookie: `${WORKOS_FLOW_COOKIE}=${SESSION_ID}` },
    }),
    ENV,
    { fetch: async () => upstream },
  );

  // A cross-origin fetch response is not the browser-facing response. Pages
  // must construct a fresh response and re-append Set-Cookie values one by one;
  // otherwise the multi-cookie callback can be folded or dropped at the facade.
  assert.notEqual(response, upstream);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(response.headers.getSetCookie(), expectedCookies);
  assert.equal(await response.text(), completionDocument);
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

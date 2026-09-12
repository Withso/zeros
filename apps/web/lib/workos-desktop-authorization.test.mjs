import assert from "node:assert/strict";
import test from "node:test";

import {
  beginWorkOSDesktopAuthorization,
  renderWorkOSDesktopAuthorizationPage,
  renderWorkOSDesktopCallback,
} from "./workos-desktop-authorization.mjs";

const STATE = `zeros-alpha.${"s".repeat(43)}`;
const DEV_STATE = `zeros-dev.${"d".repeat(43)}`;
const CHALLENGE = "c".repeat(43);
const ENV = {
  AUTH_PROVIDER: "workos",
  CONTROL_PLANE_URL: "https://api-alpha.zeros.build",
  ZEROS_DEPLOY_ENV: "alpha",
};

test("desktop sign-in redirects straight from the branded app host to Hosted AuthKit", async () => {
  const calls = [];
  const response = await renderWorkOSDesktopAuthorizationPage(
    new Request(
      `https://app-alpha.zeros.build/auth/desktop?state=${STATE}&code_challenge=${CHALLENGE}`,
    ),
    ENV,
    {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, {
          status: 303,
          headers: {
            location:
              "https://api.workos.com/user_management/authorize?provider=authkit",
          },
        });
      },
    },
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "https://api.workos.com/user_management/authorize?provider=authkit",
  );
  assert.equal(
    calls[0].url,
    `https://api-alpha.zeros.build/auth/desktop/start?state=${STATE}&code_challenge=${CHALLENGE}`,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("hosted desktop callback returns to the exact Alpha app without rendering the code", async () => {
  const response = renderWorkOSDesktopCallback(
    new Request(
      `https://app-alpha.zeros.build/auth/desktop/callback?code=authorization-code&state=${STATE}`,
    ),
    ENV,
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Opening Zeros/);
  assert.match(body, /zeros-alpha/);
  assert.doesNotMatch(body, /authorization-code/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /default-src 'none'/,
  );
});

test("hosted desktop callback reduces provider errors to one fixed app value", async () => {
  const response = renderWorkOSDesktopCallback(
    new Request(
      `https://app-alpha.zeros.build/auth/desktop/callback?error=access_denied&error_description=private-provider-detail&state=${STATE}`,
    ),
    ENV,
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /error=provider_error/);
  assert.doesNotMatch(body, /access_denied|private-provider-detail/);
});

test("legacy provider selectors are dropped before bounded PKCE inputs reach Railway", async () => {
  const fetchMock = async (url, init) => {
    assert.equal(
      url,
      `https://api-alpha.zeros.build/auth/desktop/start?state=${STATE}&code_challenge=${CHALLENGE}`,
    );
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    return new Response(null, {
      status: 303,
      headers: { location: "https://api.workos.com/user_management/authorize" },
    });
  };
  const response = await beginWorkOSDesktopAuthorization(
    new Request(
      `https://app-alpha.zeros.build/auth/desktop/start?provider=github&state=${STATE}&code_challenge=${CHALLENGE}`,
    ),
    ENV,
    { fetch: fetchMock },
  );

  assert.equal(response.status, 303);
});

test("hosted desktop routes reject a callback intended for another release channel", async () => {
  const response = await renderWorkOSDesktopAuthorizationPage(
    new Request(
      `https://app-alpha.zeros.build/auth/desktop?state=zeros.${"s".repeat(43)}&code_challenge=${CHALLENGE}`,
    ),
    ENV,
  );

  assert.equal(response.status, 400);
});

test("Alpha alone permits the local Dev scheme through the WorkOS desktop boundary", async () => {
  const calls = [];
  const start = await renderWorkOSDesktopAuthorizationPage(
    new Request(
      `https://app-alpha.zeros.build/auth/desktop?state=${DEV_STATE}&code_challenge=${CHALLENGE}`,
    ),
    ENV,
    {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, {
          status: 303,
          headers: {
            location: "https://api.workos.com/user_management/authorize",
          },
        });
      },
    },
  );
  const callback = renderWorkOSDesktopCallback(
    new Request(
      `https://app-alpha.zeros.build/auth/desktop/callback?code=authorization-code&state=${DEV_STATE}`,
    ),
    ENV,
  );
  const callbackBody = await callback.text();

  assert.equal(start.status, 303);
  assert.equal(
    calls[0].url,
    `https://api-alpha.zeros.build/auth/desktop/start?state=${DEV_STATE}&code_challenge=${CHALLENGE}`,
  );
  assert.equal(callback.status, 200);
  assert.match(callbackBody, /zeros-dev/);
});

test("Beta and Production reject the local Dev scheme", async () => {
  for (const [deployment, origin, api] of [
    ["beta", "https://app-beta.zeros.build", "https://api-beta.zeros.build"],
    ["production", "https://app.zeros.build", "https://api.zeros.build"],
  ]) {
    const response = await renderWorkOSDesktopAuthorizationPage(
      new Request(
        `${origin}/auth/desktop?state=${DEV_STATE}&code_challenge=${CHALLENGE}`,
      ),
      {
        AUTH_PROVIDER: "workos",
        CONTROL_PLANE_URL: api,
        ZEROS_DEPLOY_ENV: deployment,
      },
    );
    assert.equal(response.status, 400);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  beginWorkOSDesktopAuthorization,
  renderWorkOSDesktopAuthorizationPage,
  renderWorkOSDesktopCallback,
} from "./workos-desktop-authorization.mjs";

const STATE = `zeros-alpha.${"s".repeat(43)}`;
const CHALLENGE = "c".repeat(43);
const ENV = {
  AUTH_PROVIDER: "workos",
  CONTROL_PLANE_URL: "https://api-alpha.zeros.build",
  ZEROS_DEPLOY_ENV: "alpha",
};

test("desktop sign-in starts on the branded app host with direct providers", async () => {
  const response = renderWorkOSDesktopAuthorizationPage(
    new Request(
      `https://app-alpha.zeros.build/auth/desktop?state=${STATE}&code_challenge=${CHALLENGE}`,
    ),
    ENV,
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Sign in to Zeros/);
  assert.match(body, /Continue with Google/);
  assert.match(body, /Continue with GitHub/);
  assert.match(body, /\/auth\/desktop\/start\?provider=google/);
  assert.equal(body.toLowerCase().includes("workos"), false);
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

test("provider choice forwards only bounded PKCE inputs to Railway", async () => {
  const fetchMock = async (url, init) => {
    assert.equal(
      url,
      `https://api-alpha.zeros.build/auth/desktop/start?provider=github&state=${STATE}&code_challenge=${CHALLENGE}`,
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

test("hosted desktop routes reject a callback intended for another release channel", () => {
  const response = renderWorkOSDesktopAuthorizationPage(
    new Request(
      `https://app-alpha.zeros.build/auth/desktop?state=zeros.${"s".repeat(43)}&code_challenge=${CHALLENGE}`,
    ),
    ENV,
  );

  assert.equal(response.status, 400);
});

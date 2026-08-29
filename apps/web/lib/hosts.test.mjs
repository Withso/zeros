/** Unit tests for the actual host-routing implementation. Node 22+ strips the
 * erasable TypeScript syntax in hosts.ts, so no mirrored test implementation is
 * needed. Run from apps/web with `npm test`. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APP_CSP,
  applyHostHeaders,
  appOrigin,
  classifyHost,
  isAppOnlyPath,
  marketingOrigin,
  normalizeMarketingPath,
  redirectUri,
} from "./hosts.ts";

describe("applyHostHeaders", () => {
  it("preserves a route-specific Content-Security-Policy", async () => {
    const strictCsp = "default-src 'none'; script-src 'nonce-desktop-auth'";
    const response = applyHostHeaders(
      new Response("desktop callback", {
        headers: { "content-security-policy": strictCsp },
      }),
      "app",
    );

    assert.equal(response.headers.get("content-security-policy"), strictCsp);
    assert.equal(await response.text(), "desktop callback");
  });

  it("adds the default app policy when a route does not provide one", () => {
    const response = applyHostHeaders(new Response("hub"), "app");
    assert.equal(response.headers.get("content-security-policy"), APP_CSP);
  });
});

describe("classifyHost", () => {
  const env = {};

  it("treats zeros.build / www / zeros.design as marketing", () => {
    assert.equal(classifyHost("zeros.build", env), "marketing");
    assert.equal(classifyHost("www.zeros.build", env), "marketing");
    assert.equal(classifyHost("zeros.design", env), "marketing");
  });

  it("treats app.zeros.build as app", () => {
    assert.equal(classifyHost("app.zeros.build", env), "app");
  });

  it("defaults unknown hosts (pages.dev, localhost) to app", () => {
    assert.equal(classifyHost("abc.pages.dev", env), "app");
    assert.equal(classifyHost("127.0.0.1", env), "app");
    assert.equal(classifyHost("localhost", env), "app");
  });

  it("honors MARKETING_HOSTS override for local marketing preview", () => {
    const e = { MARKETING_HOSTS: "127.0.0.1,localhost" };
    assert.equal(classifyHost("127.0.0.1", e), "marketing");
    assert.equal(classifyHost("localhost", e), "marketing");
    assert.equal(classifyHost("zeros.build", e), "app"); // not in override list
  });
});

describe("isAppOnlyPath", () => {
  it("flags auth/handoff/API/launch/invite/GitHub completion", () => {
    assert.equal(isAppOnlyPath("/auth/start"), true);
    assert.equal(isAppOnlyPath("/handoff/mint"), true);
    assert.equal(isAppOnlyPath("/api"), true);
    assert.equal(isAppOnlyPath("/api/v1/me"), true);
    assert.equal(isAppOnlyPath("/launch"), true);
    assert.equal(isAppOnlyPath("/invite"), true);
    assert.equal(isAppOnlyPath("/github/connected"), true);
  });

  it("does not flag marketing paths", () => {
    assert.equal(isAppOnlyPath("/"), false);
    assert.equal(isAppOnlyPath("/changelog"), false);
    assert.equal(isAppOnlyPath("/schemas/settings.schema.json"), false);
  });
});

describe("origins", () => {
  it("defaults and strips trailing slash", () => {
    assert.equal(appOrigin({}), "https://app.zeros.build");
    assert.equal(
      appOrigin({ APP_ORIGIN: "https://app.zeros.build/" }),
      "https://app.zeros.build",
    );
    assert.equal(marketingOrigin({}), "https://zeros.build");
    assert.equal(redirectUri({}), "https://app.zeros.build/auth/callback");
  });
});

describe("normalizeMarketingPath", () => {
  it("matches the marketing router's case and trailing-slash behavior", () => {
    assert.equal(normalizeMarketingPath("/CHANGELOG/"), "/changelog");
    assert.equal(normalizeMarketingPath("/privacy///"), "/privacy");
    assert.equal(normalizeMarketingPath("/"), "/");
  });
});

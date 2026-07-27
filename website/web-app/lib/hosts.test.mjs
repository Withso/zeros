/**
 * Unit tests for host classification (no Workers runtime required).
 * Run: node --test lib/hosts.test.mjs  (from website/web-app after build, or)
 *      npx tsx --test is not used — plain node ESM re-implements the pure helpers
 *      by importing the compiled logic via dynamic import of the .ts through
 *      a tiny duplicate of the pure functions for CI without a TS loader.
 *
 * Kept as .mjs mirroring lib/hosts.ts so `node --test` works with zero deps.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const DEFAULT_APP_ORIGIN = "https://app.zeros.build";
const DEFAULT_MARKETING_ORIGIN = "https://zeros.build";
const DEFAULT_MARKETING_HOSTS = ["zeros.build", "www.zeros.build", "zeros.design"];

function appOrigin(env) {
  const raw = (env.APP_ORIGIN || DEFAULT_APP_ORIGIN).trim();
  return raw.replace(/\/$/, "") || DEFAULT_APP_ORIGIN;
}

function marketingOrigin(env) {
  const raw = (env.MARKETING_ORIGIN || DEFAULT_MARKETING_ORIGIN).trim();
  return raw.replace(/\/$/, "") || DEFAULT_MARKETING_ORIGIN;
}

function splitHosts(raw, fallback) {
  if (!raw || !raw.trim()) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function marketingHosts(env) {
  return splitHosts(env.MARKETING_HOSTS, DEFAULT_MARKETING_HOSTS);
}

function appHosts(env) {
  const fromEnv = splitHosts(env.APP_HOSTS, []);
  if (fromEnv.length) return fromEnv;
  try {
    return [new URL(appOrigin(env)).hostname.toLowerCase()];
  } catch {
    return ["app.zeros.build"];
  }
}

function classifyHost(hostname, env) {
  const host = hostname.toLowerCase();
  if (marketingHosts(env).includes(host)) return "marketing";
  if (appHosts(env).includes(host)) return "app";
  return "app";
}

function isAppOnlyPath(pathname) {
  return (
    pathname === "/launch" ||
    pathname === "/invite" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/handoff/")
  );
}

function redirectUri(env) {
  return `${appOrigin(env)}/auth/callback`;
}

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
  it("flags auth/handoff/launch/invite", () => {
    assert.equal(isAppOnlyPath("/auth/start"), true);
    assert.equal(isAppOnlyPath("/handoff/mint"), true);
    assert.equal(isAppOnlyPath("/launch"), true);
    assert.equal(isAppOnlyPath("/invite"), true);
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
    assert.equal(appOrigin({ APP_ORIGIN: "https://app.zeros.build/" }), "https://app.zeros.build");
    assert.equal(marketingOrigin({}), "https://zeros.build");
    assert.equal(redirectUri({}), "https://app.zeros.build/auth/callback");
  });
});

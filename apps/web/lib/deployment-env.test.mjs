import assert from "node:assert/strict";
import test from "node:test";

import { deploymentEnvironmentErrors } from "./deployment-env.mjs";

function cloudflareEnv(channel) {
  const suffix = channel === "production" ? "" : `-${channel}`;
  return {
    CF_PAGES: "1",
    CF_PAGES_BRANCH: channel === "alpha" ? "main" : "release/1.2.3",
    ZEROS_DEPLOY_ENV: channel,
    AUTH_PROVIDER: "auth0",
    AUTH0_DOMAIN: "login.zeros.build",
    AUTH0_CLIENT_ID: "public-client-id",
    AUTH0_CLIENT_SECRET: "test-secret",
    AUTH0_AUDIENCE: `https://api${suffix}.zeros.build`,
    APP_ORIGIN: `https://app${suffix}.zeros.build`,
    CONTROL_PLANE_URL: `https://api${suffix}.zeros.build`,
  };
}

test("local builds do not require hosted environment credentials", () => {
  assert.deepEqual(deploymentEnvironmentErrors({}), []);
});

test("accepts the exact Alpha, Beta, and Production channel wiring", () => {
  for (const channel of ["alpha", "beta", "production"]) {
    assert.deepEqual(deploymentEnvironmentErrors(cloudflareEnv(channel)), []);
  }
});

test("accepts stateless WorkOS Pages wiring with Railway as the authority", () => {
  for (const channel of ["alpha", "beta", "production"]) {
    const env = cloudflareEnv(channel);
    env.AUTH_PROVIDER = "workos";
    delete env.AUTH0_DOMAIN;
    delete env.AUTH0_CLIENT_ID;
    delete env.AUTH0_CLIENT_SECRET;
    delete env.AUTH0_AUDIENCE;
    assert.deepEqual(deploymentEnvironmentErrors(env), []);
  }
});

test("WorkOS Pages rejects retired bindings and misplaced Railway secrets", () => {
  const env = cloudflareEnv("alpha");
  env.AUTH_PROVIDER = "workos";
  env.WORKOS_SESSION_WORKER = "zeros-auth-sessions-production";
  env.WORKOS_API_KEY = "must-not-be-reported";
  env.WORKOS_COOKIE_PASSWORD = "also-must-not-be-reported";
  env.WORKOS_WEBHOOK_SECRET = "webhook-must-not-be-reported";
  env.AUTH_SESSIONS = {};
  delete env.AUTH0_DOMAIN;
  delete env.AUTH0_CLIENT_ID;
  delete env.AUTH0_CLIENT_SECRET;
  delete env.AUTH0_AUDIENCE;

  const errors = deploymentEnvironmentErrors(env);
  assert.ok(errors.some((error) => error.includes("WORKOS_SESSION_WORKER")));
  assert.ok(errors.some((error) => error.includes("WORKOS_API_KEY")));
  assert.ok(errors.some((error) => error.includes("WORKOS_COOKIE_PASSWORD")));
  assert.ok(errors.some((error) => error.includes("WORKOS_WEBHOOK_SECRET")));
  assert.ok(errors.some((error) => error.includes("AUTH_SESSIONS")));
  assert.ok(errors.every((error) => !error.includes("must-not-be-reported")));
});

test("hosted builds require an explicit auth provider selector", () => {
  const env = cloudflareEnv("alpha");
  delete env.AUTH_PROVIDER;
  assert.ok(
    deploymentEnvironmentErrors(env).includes(
      "AUTH_PROVIDER must be auth0 or workos",
    ),
  );
});

test("rejects a Pages build with no named deployment environment", () => {
  assert.deepEqual(deploymentEnvironmentErrors({ CF_PAGES: "1" }), [
    "ZEROS_DEPLOY_ENV must be alpha, beta, or production",
  ]);
});

test("rejects cross-environment frontend, backend, audience, and branch wiring", () => {
  const env = {
    ...cloudflareEnv("alpha"),
    APP_ORIGIN: "https://app.zeros.build",
    CONTROL_PLANE_URL: "https://api.zeros.build",
    AUTH0_AUDIENCE: "https://api.zeros.build",
    CF_PAGES_BRANCH: "release/1.2.3",
  };
  const errors = deploymentEnvironmentErrors(env);
  assert.equal(errors.length, 4);
  assert.ok(errors.every((error) => !error.includes("test-secret")));
});

test("requires every hosted auth and routing variable", () => {
  const env = cloudflareEnv("production");
  delete env.AUTH0_CLIENT_SECRET;
  delete env.CONTROL_PLANE_URL;
  delete env.CF_PAGES_BRANCH;
  const errors = deploymentEnvironmentErrors(env);
  assert.ok(errors.includes("AUTH0_CLIENT_SECRET is required"));
  assert.ok(errors.includes("CONTROL_PLANE_URL is required"));
  assert.ok(errors.includes("CF_PAGES_BRANCH is required"));
});

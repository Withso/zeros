import assert from "node:assert/strict";
import test from "node:test";

import { deploymentEnvironmentErrors } from "./deployment-env.mjs";

function cloudflareEnv(channel) {
  const suffix = channel === "production" ? "" : `-${channel}`;
  return {
    CF_PAGES: "1",
    CF_PAGES_BRANCH: channel === "alpha" ? "main" : "release/1.2.3",
    ZEROS_DEPLOY_ENV: channel,
    AUTH_PROVIDER: "workos",
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

test("accepts WorkOS Pages wiring whether or not AUTH_PROVIDER is set, and only WorkOS", () => {
  for (const channel of ["alpha", "beta", "production"]) {
    const env = cloudflareEnv(channel);
    delete env.AUTH_PROVIDER;
    assert.deepEqual(deploymentEnvironmentErrors(env), []);
  }
  for (const provider of ["auth0", "invented"]) {
    assert.ok(
      deploymentEnvironmentErrors({ ...cloudflareEnv("alpha"), AUTH_PROVIDER: provider }).includes(
        "AUTH_PROVIDER must be workos or unset",
      ),
    );
  }
});

test("accepts isolated Alpha and Production Ops projects and rejects Beta Ops", () => {
  for (const channel of ["alpha", "production"]) {
    const env = cloudflareEnv(channel);
    env.ZEROS_SURFACE = "ops";
    env.WORKOS_BROWSER_ROUTE_PREFIX = "/ops";
    env.APP_ORIGIN =
      channel === "alpha"
        ? "https://ops-alpha.zeros.build"
        : "https://ops.zeros.build";
    assert.deepEqual(deploymentEnvironmentErrors(env), []);
  }

  const beta = cloudflareEnv("beta");
  beta.ZEROS_SURFACE = "ops";
  beta.WORKOS_BROWSER_ROUTE_PREFIX = "/ops";
  assert.ok(
    deploymentEnvironmentErrors(beta).some((error) =>
      error.includes("not deployed to Beta"),
    ),
  );
});

test("rejects noncanonical surface values instead of normalizing deployment drift", () => {
  const env = cloudflareEnv("alpha");
  env.ZEROS_SURFACE = " OPS ";
  assert.ok(
    deploymentEnvironmentErrors(env).some((error) =>
      error.includes("ZEROS_SURFACE must be app or ops"),
    ),
  );
});

test("Pages rejects retired bindings and misplaced Railway secrets", () => {
  const env = cloudflareEnv("alpha");
  env.WORKOS_SESSION_WORKER = "zeros-auth-sessions-production";
  env.WORKOS_API_KEY = "must-not-be-reported";
  env.WORKOS_COOKIE_PASSWORD = "also-must-not-be-reported";
  env.WORKOS_WEBHOOK_SECRET = "webhook-must-not-be-reported";
  env.AUTH_SESSIONS = {};

  const errors = deploymentEnvironmentErrors(env);
  assert.ok(errors.some((error) => error.includes("WORKOS_SESSION_WORKER")));
  assert.ok(errors.some((error) => error.includes("WORKOS_API_KEY")));
  assert.ok(errors.some((error) => error.includes("WORKOS_COOKIE_PASSWORD")));
  assert.ok(errors.some((error) => error.includes("WORKOS_WEBHOOK_SECRET")));
  assert.ok(errors.some((error) => error.includes("AUTH_SESSIONS")));
  assert.ok(errors.every((error) => !error.includes("must-not-be-reported")));
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
    CF_PAGES_BRANCH: "release/1.2.3",
  };
  const errors = deploymentEnvironmentErrors(env);
  assert.equal(errors.length, 3);
});

test("requires every hosted routing variable", () => {
  const env = cloudflareEnv("production");
  delete env.CONTROL_PLANE_URL;
  delete env.CF_PAGES_BRANCH;
  const errors = deploymentEnvironmentErrors(env);
  assert.ok(errors.includes("CONTROL_PLANE_URL is required"));
  assert.ok(errors.includes("CF_PAGES_BRANCH is required"));
});
test("hosted Dev names the exact checkout and cannot target Alpha or Ops", () => {
  const owner = "a".repeat(24), generation = "11111111-1111-4111-8111-111111111111";
  const env = { CF_PAGES: "1", CF_PAGES_BRANCH: "dev", ZEROS_DEPLOY_ENV: "dev", AUTH_PROVIDER: "workos",
    ZEROS_DEV_OWNER: owner, ZEROS_DEV_GENERATION: generation, ZEROS_DEV_DOMAIN: "example.com",
    APP_ORIGIN: `https://app-dev-${owner}.example.com`, CONTROL_PLANE_URL: `https://api-dev-${owner}.example.com` };
  assert.deepEqual(deploymentEnvironmentErrors(env), []);
  assert.ok(deploymentEnvironmentErrors({ ...env, CONTROL_PLANE_URL: "https://api-alpha.zeros.build" }).length);
  assert.ok(deploymentEnvironmentErrors({ ...env, ZEROS_SURFACE: "ops" }).length);
  assert.ok(deploymentEnvironmentErrors({ ...env, AUTH_PROVIDER: "auth0" }).length);
  assert.ok(deploymentEnvironmentErrors({ ...env, CF_PAGES_BRANCH: "main" }).length);
  assert.ok(deploymentEnvironmentErrors({ ...env, ZEROS_DEV_GENERATION: "" }).length);
});

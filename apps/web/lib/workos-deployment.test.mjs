import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const webRoot = new URL("../", import.meta.url);
const controlPlaneRoot = new URL("../../control-plane/", import.meta.url);

test("the retired Durable Object worker is absent from the web deployment", async () => {
  await assert.rejects(access(new URL("session-worker/worker.ts", webRoot)));
  const manifest = JSON.parse(
    await readFile(new URL("package.json", webRoot), "utf8"),
  );
  assert.equal(manifest.scripts["check:session-worker"], undefined);
  assert.equal(manifest.dependencies?.["@workos-inc/node"], undefined);
  assert.equal(manifest.dependencies?.jose, undefined);
});

test("the WorkOS SDK is an exact Railway control-plane dependency", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("package.json", controlPlaneRoot), "utf8"),
  );
  assert.match(manifest.dependencies["@workos-inc/node"], /^\d+\.\d+\.\d+$/);
  const migration = await readFile(
    new URL("migrations/0012_workos_browser_sessions.sql", controlPlaneRoot),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE workos_browser_sessions/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(migration, /access_token\s+text/i);
});

test("stable hosted UI assets cannot remain fresh across deployments", async () => {
  const headers = await readFile(new URL("public/_headers", webRoot), "utf8");
  for (const asset of [
    "/account-deletion.js",
    "/dashboard.js",
    "/dashboard.css",
    "/dashboard-tokens.css",
    "/ops.js",
    "/ops.css",
  ]) {
    assert.match(
      headers,
      new RegExp(
        `^${asset.replace(".", "\\.")}\\n\\s+Cache-Control: no-cache$`,
        "m",
      ),
      asset,
    );
  }

  for (const sourceName of ["lib/dashboard.mjs", "lib/ops.ts"]) {
    const source = await readFile(new URL(sourceName, webRoot), "utf8");
    assert.doesNotMatch(
      source,
      /(?:href|src)="\/(?:account-deletion|dashboard|ops)\.(?:css|js)"/,
    );
  }

  const dashboardStyles = await readFile(
    new URL("public/dashboard.css", webRoot),
    "utf8",
  );
  assert.doesNotMatch(
    dashboardStyles,
    /@import\s+url\(["']?\/dashboard-tokens\.css["']?\)/,
  );
});

test("Pages Functions invokes host middleware for every stable hosted UI asset", async () => {
  const { pagesFunctionRoutes } = await import("./pages-routes.mjs");
  const routes = pagesFunctionRoutes("app");
  assert.deepEqual(routes.include, ["/*"]);
  assert.equal(routes.version, 1);
  const assembly = await readFile(
    new URL("scripts/assemble-marketing.mjs", webRoot),
    "utf8",
  );
  assert.match(assembly, /pagesFunctionRoutes\(surface\)/);

  const matches = (pattern, pathname) => {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`).test(pathname);
  };
  const invokesFunction = (pathname) =>
    routes.include.some((pattern) => matches(pattern, pathname)) &&
    !routes.exclude.some((pattern) => matches(pattern, pathname));

  for (const pathname of [
    "/account-deletion.js",
    "/dashboard.js",
    "/dashboard.css",
    "/dashboard-tokens.css",
    "/ops.js",
    "/ops.css",
  ]) {
    assert.equal(invokesFunction(pathname), true, pathname);
  }

  for (const pathname of [
    "/assets/index-content-hash.js",
    "/agents/codex.svg",
    "/schemas/settings.schema.json",
    "/zeros-logo.svg",
    "/LICENSE.txt",
  ]) {
    assert.equal(invokesFunction(pathname), false, pathname);
  }
});

test("the isolated Ops build cannot bypass its static-path allowlist", async () => {
  const { pagesFunctionRoutes } = await import("./pages-routes.mjs");
  const routes = pagesFunctionRoutes("ops");
  assert.deepEqual(routes, {
    version: 1,
    include: ["/*"],
    exclude: [],
  });
  assert.throws(() => pagesFunctionRoutes("OPS"), /must be app or ops/);
});

test("every Pages build publishes an authoritative deployment manifest", async () => {
  const { createDeploymentManifest, DEPLOYMENT_MANIFEST_PATH } =
    await import("./deployment-manifest.mjs");
  const commitSha = "548b6c3c4fc53a46ac24cc98193aa4279eddcc82";

  assert.equal(DEPLOYMENT_MANIFEST_PATH, "/zeros-deployment.json");
  assert.deepEqual(createDeploymentManifest(commitSha, "app"), {
    version: 1,
    commitSha,
    surface: "app",
  });
  assert.deepEqual(createDeploymentManifest(commitSha, "ops"), {
    version: 1,
    commitSha,
    surface: "ops",
  });
  assert.throws(
    () => createDeploymentManifest("not-a-commit", "app"),
    /40-character Git commit SHA/,
  );
  assert.throws(
    () => createDeploymentManifest(commitSha, "OPS"),
    /surface must be app or ops/,
  );

  const assembly = await readFile(
    new URL("scripts/assemble-marketing.mjs", webRoot),
    "utf8",
  );
  assert.match(assembly, /CF_PAGES_COMMIT_SHA/);
  assert.match(assembly, /DEPLOYMENT_MANIFEST_PATH/);

  const middleware = await readFile(
    new URL("functions/_middleware.ts", webRoot),
    "utf8",
  );
  assert.match(middleware, /DEPLOYMENT_MANIFEST_PATH/);
});

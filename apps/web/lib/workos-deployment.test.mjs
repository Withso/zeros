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

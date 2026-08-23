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

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the Durable Object worker is isolated per channel and has no public preview", async () => {
  const config = JSON.parse(
    await readFile(new URL("session-worker/wrangler.jsonc", root), "utf8"),
  );
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);

  const origins = {
    alpha: "https://app-alpha.zeros.build",
    beta: "https://app-beta.zeros.build",
    production: "https://app.zeros.build",
  };
  for (const [channel, origin] of Object.entries(origins)) {
    const environment = config.env[channel];
    assert.equal(environment.name, `zeros-auth-sessions-${channel}`);
    assert.equal(environment.vars.APP_ORIGIN, origin);
    assert.deepEqual(environment.durable_objects.bindings, [
      { name: "AUTH_SESSIONS", class_name: "AuthSession" },
    ]);
    assert.deepEqual(environment.migrations, [
      { tag: "v1", new_sqlite_classes: ["AuthSession"] },
    ]);
    const serialized = JSON.stringify(environment);
    assert.doesNotMatch(serialized, /WORKOS_API_KEY|WORKOS_COOKIE_PASSWORD|client_/);
  }
});

test("the Worker SDK and deployment CLI are exact lockfile pins", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("package.json", root), "utf8"),
  );
  assert.match(manifest.dependencies["@workos-inc/node"], /^\d+\.\d+\.\d+$/);
  assert.match(manifest.devDependencies.wrangler, /^\d+\.\d+\.\d+$/);
  const check = manifest.scripts["check:session-worker"];
  assert.equal(check.includes("--dry-run"), true);
  for (const channel of ["alpha", "beta", "production"]) {
    assert.match(check, new RegExp(`--env ${channel}(?:\\s|$)`));
  }
});

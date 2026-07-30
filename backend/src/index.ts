// ──────────────────────────────────────────────────────────
// Zeros control plane — entrypoint.
// Boot order: config → pool → migrations (idempotent) → HTTP server.
// The HTTP surface itself lives in app.ts so it stays importable (and its
// middleware ORDER assertable) without booting a server.
// ──────────────────────────────────────────────────────────

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { runMigrations } from "./migrate.js";
import { loadEmailConfig } from "./email.js";
import { startGithubOauthCleanup } from "./github.js";
import { createApp } from "./app.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const emailConfig = loadEmailConfig();

const app = createApp(config, pool, emailConfig);

await runMigrations(pool);
if (config.github) startGithubOauthCleanup(pool);
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[control-plane] listening on :${info.port}`);
});

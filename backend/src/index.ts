// ──────────────────────────────────────────────────────────
// Zeros control plane — entrypoint.
// Boot order: config → pool → migrations (idempotent) → HTTP server.
// ──────────────────────────────────────────────────────────

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { runMigrations } from "./migrate.js";
import { createAuthMiddleware } from "./auth.js";
import { rateLimit } from "./ratelimit.js";
import { createRoutes } from "./routes.js";
import { HttpError } from "./authz.js";
import { loadEmailConfig } from "./email.js";
import {
  createGithubPublicRoutes,
  createGithubRoutes,
  createGithubUnconfiguredRoutes,
  startGithubOauthCleanup,
} from "./github.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const emailConfig = loadEmailConfig();

const app = new Hono();

// Health: no auth (Railway healthcheck), proves DB reachability.
app.get("/healthz", async (c) => {
  try {
    await pool.query("SELECT 1");
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

// GitHub calls this route from the system browser, so it cannot carry the
// desktop user's Auth0 bearer token. Its one-time state is the authorization.
// Register it before the /v1 middleware chain; every other GitHub route stays
// behind the normal Auth0, body-limit, CORS, and per-user rate limits.
if (config.github) {
  app.route("/", createGithubPublicRoutes(pool, config.github));
} else {
  console.warn(
    "[control-plane] GitHub App sign-in is not configured — " +
      "/v1/github/* answers 503 github_not_configured.",
  );
}

// CORS: the callers are the Electron renderer (localhost dev origin /
// packaged origin) and later app.zeros.build. Auth is a bearer token —
// no cookies, nothing ambient — so a wildcard origin with credentials
// OFF is safe (the token only goes where our own client sends it).
app.use(
  "/v1/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
    maxAge: 86400,
  }),
);

// Cap request bodies BEFORE the handlers buffer + JSON-parse them —
// otherwise a giant payload is fully in memory before Zod's per-field
// limits can help. 256 KB comfortably covers a settings doc + a 200 KB
// team-logo data URL; anything larger is abuse.
app.use("/v1/*", bodyLimit({ maxSize: 256 * 1024 }));

// Everything under /v1 requires a verified Auth0-issued JWT.
app.use("/v1/*", createAuthMiddleware(config, pool));

// Per-user ceiling across ALL /v1 routes. The sensitive endpoints keep their
// own tighter limits (invite send/accept); this is the blanket abuse cap for
// the rest (create-team, role changes) so an authenticated user can't
// spam mutations or flood the audit log. Runs AFTER auth so it keys on the
// verified user id, not the IP.
app.use("/v1/*", rateLimit("global", 240, 60_000));

app.route("/", createRoutes(pool, emailConfig));
app.route(
  "/",
  config.github
    ? createGithubRoutes(pool, config.github)
    : createGithubUnconfiguredRoutes(),
);

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json(
      { error: { code: err.code, message: err.message } },
      err.status,
    );
  }
  console.error("[error]", err);
  return c.json(
    {
      error: {
        code: "internal",
        message: config.isProduction ? "Internal error" : String(err),
      },
    },
    500,
  );
});

app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "Not found" } }, 404),
);

await runMigrations(pool);
if (config.github) startGithubOauthCleanup(pool);
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[control-plane] listening on :${info.port}`);
});

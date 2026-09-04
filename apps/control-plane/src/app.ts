// ──────────────────────────────────────────────────────────
// HTTP surface assembly — pure, no side effects.
//
// Split out of index.ts so a test can assert the ORDER of the middleware
// chain. Every router here already has isolated unit tests; what none of them
// could see is where each one sits relative to `createAuthMiddleware`, and
// that position is the whole contract for the two routes that must answer
// without a bearer token. A 401 where a 503 belongs is invisible to a
// per-router test and indistinguishable, from the desktop, from an expired
// authentication session.
// ──────────────────────────────────────────────────────────

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { isIP } from "node:net";
import type pg from "pg";

import type { Config } from "./config.js";
import { createAuthMiddleware } from "./auth.js";
import { rateLimit } from "./ratelimit.js";
import { createRoutes } from "./routes.js";
import { HttpError } from "./authz.js";
import type { EmailConfig } from "./email.js";
import {
  createGithubPublicRoutes,
  createGithubRoutes,
  createGithubUnconfiguredRoutes,
} from "./github.js";
import { createFeedbackRoutes } from "./feedback.js";
import {
  PostgresWorkOSBrowserSessionRepository,
  WorkOSBrowserSessions,
  createWorkOSBrowserSessionRoutes,
} from "./workos-browser-sessions.js";
import {
  createWorkOSDesktopRevocationRoutes,
  enqueueSessionsRevokedNotification,
} from "./workos-desktop-revocation.js";
import { createWorkOSDesktopAuthorizationRoutes } from "./workos-desktop-authorization.js";
import { RailwayWorkOSProvider } from "./workos-provider.js";
import {
  createCloudWorkspaceInternalRoutes,
  type CloudWorkspaceInternalSetupService,
} from "./cloud-workspaces/internal-routes.js";
import type { CloudWorkspaceAccessService } from "./cloud-workspaces/access.js";
import type { CloudWorkspaceRepositoryResolver } from "./cloud-workspaces/github-repositories.js";
import type { DatabaseCloudWorkspaceForkService } from "./cloud-workspaces/forks.js";
import type { DatabaseCloudWorkspaceReplicaService } from "./cloud-workspaces/replicas.js";
import type { DatabaseCloudWorkspaceEngineClientAdmissionService } from "./cloud-workspaces/engine-client-admission.js";
import { createAccountRecoveryRoutes } from "./account-recovery.js";
import { createDeletionLifecycleRoutes } from "./deletion-lifecycle.js";
import { createOpsRoutes } from "./ops.js";
import {
  PostgresSecurityEventBroker,
  createSecurityEventRoutes,
} from "./security-events.js";
import { createWorkOSManagementEventRoutes } from "./workos-sync-events.js";
import type { CloudWorkspaceHealth } from "./cloud-workspaces/health.js";
import type { MigrationStatus } from "./migrate.js";

export type CreateAppDependencies = {
  cloudWorkspaceInternalSetupService?: CloudWorkspaceInternalSetupService;
  cloudWorkspaceAccessService?: CloudWorkspaceAccessService;
  cloudWorkspaceRepositoryResolver?: CloudWorkspaceRepositoryResolver;
  cloudWorkspaceForkService?: DatabaseCloudWorkspaceForkService;
  cloudWorkspaceReplicaService?: DatabaseCloudWorkspaceReplicaService;
  cloudWorkspaceEngineClientAdmissionService?: DatabaseCloudWorkspaceEngineClientAdmissionService;
  cloudWorkspaceHealthService?: { read(): Promise<CloudWorkspaceHealth> };
  securityEventBroker?: PostgresSecurityEventBroker;
  workosProvider?: RailwayWorkOSProvider;
  migrationStatus?: MigrationStatus;
};

function isCloudWorkspaceApiPath(requestPath: string): boolean {
  return (
    requestPath === "/v1/devices" ||
    requestPath.startsWith("/v1/devices/") ||
    requestPath === "/internal/v1/cloud-workspaces" ||
    requestPath.startsWith("/internal/v1/cloud-workspaces/") ||
    /^\/v1\/organizations\/[^/]+\/(?:cloud-workspaces|cloud-workspace-management)(?:\/|$)/u.test(
      requestPath,
    )
  );
}

export function createApp(
  config: Config,
  pool: pg.Pool,
  emailConfig: EmailConfig,
  dependencies: CreateAppDependencies = {},
): Hono {
  const app = new Hono();
  const pendingMigration =
    dependencies.migrationStatus?.state === "controlled_migration_pending"
      ? dependencies.migrationStatus
      : null;

  // A deferred 0025 means later cloud columns (starting in 0026) do not exist.
  // Keep the complete public and internal cloud surface behind one first-in-
  // chain barrier so neither auth nor a router can touch that partial schema.
  // Unrelated control-plane APIs remain available for the safe boot mode.
  if (pendingMigration) {
    app.use("*", async (c, next) => {
      if (!isCloudWorkspaceApiPath(c.req.path)) {
        await next();
        return;
      }
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      return c.json(
        {
          error: {
            code: "controlled_migration_pending",
            message:
              "Cloud workspaces are disabled until the pending controlled migration is applied",
            migration: pendingMigration.migration,
          },
        },
        503,
      );
    });
  }
  const workosProvider =
    config.auth.provider === "workos" && config.workos
      ? (dependencies.workosProvider ??
        new RailwayWorkOSProvider(config.auth, config.workos))
      : undefined;

  // Preview capabilities use an isolated wildcard origin and a dedicated
  // header, not an interactive account JWT. Let the access service recognize
  // only its exact host before ordinary API middleware runs; every non-preview
  // request falls through unchanged.
  if (dependencies.cloudWorkspaceAccessService) {
    const previewPreAuthLimit = rateLimit(
      "cloud-preview-preauth",
      600,
      60_000,
      (c) => {
        // Railway supplies X-Real-IP. A direct Cloudflare Tunnel strips that
        // header and supplies CF-Connecting-IP instead, so do not collapse all
        // protected preview clients into the shared anonymous bucket.
        const clientIp =
          c.req.header("X-Real-IP")?.trim() ??
          c.req.header("CF-Connecting-IP")?.trim() ??
          "";
        return isIP(clientIp) ? clientIp : "unknown";
      },
    );
    app.use("*", async (c, next) => {
      const access = dependencies.cloudWorkspaceAccessService!;
      if (!access.recognizesPreviewRequest(c.req.raw)) {
        await next();
        return;
      }
      // Run a no-op continuation through the shared limiter before capability
      // parsing, PostgreSQL, provider lookup, or upstream body buffering.
      await previewPreAuthLimit(c, async () => undefined);
      const proxied = await access.handlePreviewRequest(c.req.raw);
      if (proxied) return proxied;
      await next();
    });
  }

  // Health: no auth (Railway healthcheck), proves DB reachability.
  app.get("/healthz", async (c) => {
    try {
      await pool.query("SELECT 1");
      const migrationState =
        dependencies.migrationStatus?.state === "controlled_migration_pending"
          ? { migrations: dependencies.migrationStatus }
          : {};
      if (!dependencies.cloudWorkspaceHealthService) {
        return c.json({ ok: true, ...migrationState });
      }
      try {
        return c.json({
          ok: true,
          ...migrationState,
          cloudWorkspaces:
            await dependencies.cloudWorkspaceHealthService.read(),
        });
      } catch {
        // Cloud workspaces are an independently gated subsystem. A failed
        // aggregate query must be visible without crash-looping unrelated
        // WorkOS, team, invitation, GitHub, and settings APIs.
        return c.json({
          ok: true,
          ...migrationState,
          cloudWorkspaces: {
            enabled: true,
            operationalState: "unknown",
            reasons: ["health_query_failed"],
          },
        });
      }
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  // Railway owns the complete WorkOS browser/desktop authentication boundary:
  // Hosted AuthKit authorization, authorization-code exchange, encrypted
  // session state, serialized refresh, provider-signed lifecycle events, and
  // desktop session revocation. These
  // endpoints are intentionally mounted before /v1 bearer authentication;
  // each carries its own stronger credential (PKCE state, opaque HttpOnly
  // cookie, webhook signature, or a verified Desktop Application bearer).
  if (config.auth.provider === "workos" && config.workos && workosProvider) {
    const sessions = new WorkOSBrowserSessions(
      new PostgresWorkOSBrowserSessionRepository(pool),
      workosProvider,
      config.workos.appOrigin,
    );
    app.route(
      "/",
      createWorkOSBrowserSessionRoutes(sessions, config.workos.appOrigin),
    );
    if (config.workos.opsOrigin && config.deploymentChannel !== "beta") {
      const opsSessions = new WorkOSBrowserSessions(
        new PostgresWorkOSBrowserSessionRepository(pool),
        workosProvider,
        config.workos.opsOrigin,
      );
      // The external callback remains /auth/callback on the isolated Ops host;
      // its Pages facade forwards only to this separate upstream namespace.
      app.route(
        "/ops",
        createWorkOSBrowserSessionRoutes(opsSessions, config.workos.opsOrigin),
      );
    }
    app.route(
      "/",
      createWorkOSDesktopAuthorizationRoutes(
        workosProvider,
        config.workos.appOrigin,
      ),
    );
    app.route(
      "/",
      createWorkOSDesktopRevocationRoutes(workosProvider, {
        onAllSessionsRevoked: async ({ providerSubject }) => {
          const queued = await enqueueSessionsRevokedNotification(
            pool,
            providerSubject,
          );
          if (!queued) {
            console.warn(
              "[auth] sessions-revoked notification has no linked recipient",
            );
          }
        },
      }),
    );
    app.route(
      "/",
      createWorkOSManagementEventRoutes(
        pool,
        workosProvider,
        config.workos.webhookSecret,
      ),
    );
  }

  // The sandbox helper and cloud engine authenticate with narrow one-use or
  // heartbeat capabilities, not an interactive account JWT. Mount this
  // non-browser surface before `/v1/*` middleware and only when the guarded
  // setup worker has been configured at boot.
  if (dependencies.cloudWorkspaceInternalSetupService) {
    // Reject anonymous capability guessing before JSON buffering, token
    // parsing, or PostgreSQL work. Railway supplies X-Real-IP; the protected
    // qualification tunnel supplies CF-Connecting-IP. Prefer Railway's header
    // when both are present, validate either value, and collapse missing or
    // attacker-controlled garbage into one bounded bucket.
    const internalPreAuthLimit = rateLimit(
      "cloud-workspace-internal-preauth",
      600,
      60_000,
      (c) => {
        const clientIp =
          c.req.header("X-Real-IP")?.trim() ??
          c.req.header("CF-Connecting-IP")?.trim() ??
          "";
        return isIP(clientIp) ? clientIp : "unknown";
      },
    );
    app.use("/internal/v1/cloud-workspaces/*", internalPreAuthLimit);
    app.route(
      "/",
      createCloudWorkspaceInternalRoutes(
        dependencies.cloudWorkspaceInternalSetupService,
      ),
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
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [
        "authorization",
        "content-type",
        "idempotency-key",
        "x-zeros-access-credential",
        "x-zeros-device-id",
        "x-zeros-device-key-version",
        "x-zeros-device-timestamp",
        "x-zeros-device-nonce",
        "x-zeros-device-signature",
        "x-zeros-export-grant",
        "x-zeros-replica-grant",
      ],
      maxAge: 86400,
    }),
  );

  // Every GitHub response is authentication state, an OAuth redirect, or a
  // token-bearing exchange. Keep it out of browser, CDN, and intermediary
  // caches even if a future Cloudflare rule becomes broader than today's
  // dynamic pass-through. Set these before routing/auth so error responses
  // (including 401/503) inherit the same boundary.
  app.use("/v1/github/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    await next();
  });

  // GitHub calls the callback from the system browser, so it cannot carry the
  // desktop user's bearer token. Its one-time state is the
  // authorization. Register it before the auth middleware; every other GitHub
  // route stays behind the normal authentication, body-limit, and per-user
  // rate limits.
  //
  // The unconfigured stand-in mounts in the SAME pre-auth position on purpose.
  // Behind the middleware it was unreachable without a token, so the one
  // caller that never has one — GitHub's browser callback — got `401 Missing
  // bearer token` where `503 github_not_configured` belongs, and a desktop
  // whose authentication session had merely lapsed could not tell "GitHub App
  // sign-in is off on this control plane" from "sign in again".
  if (config.github) {
    app.route("/", createGithubPublicRoutes(pool, config.github));
  } else {
    console.warn(
      "[control-plane] GitHub App sign-in is not configured — " +
        "/v1/github/* answers 503 github_not_configured.",
    );
    app.route("/", createGithubUnconfiguredRoutes());
  }

  // Railway's edge supplies X-Real-IP for the original client. Mirror the
  // retired feedback Worker's pre-auth abuse boundary so anonymous callers
  // cannot fan out body buffering or JWT/JWKS work. Invalid/missing values
  // share one bounded fallback bucket instead of creating attacker-chosen keys.
  const feedbackPreAuthLimit = rateLimit("feedback-preauth", 5, 60_000, (c) => {
    const clientIp = c.req.header("X-Real-IP")?.trim() ?? "";
    return isIP(clientIp) ? clientIp : "unknown";
  });
  app.use("/v1/feedback", (c, next) =>
    c.req.method === "POST" ? feedbackPreAuthLimit(c, next) : next(),
  );

  // Cap ordinary request bodies BEFORE auth or handlers can inspect them.
  // Feedback's larger ceiling is installed only after authentication below:
  // an anonymous caller must not make the service buffer a multi-MiB body.
  const defaultBodyLimit = bodyLimit({ maxSize: 256 * 1024 });
  const feedbackBodyLimit = bodyLimit({ maxSize: 2 * 1024 * 1024 });
  const forkImportBodyLimits = {
    blob: 64 * 1024 * 1024,
    entries: 8 * 1024 * 1024,
    records: 16 * 1024 * 1024,
  } as const;
  const forkBlobUploadPath =
    /^\/v1\/organizations\/[0-9a-f-]{36}\/cloud-workspaces\/[0-9a-f-]{36}\/forks\/[0-9a-f-]{36}\/import\/blobs$/i;
  const forkEntryImportPath =
    /^\/v1\/organizations\/[0-9a-f-]{36}\/cloud-workspaces\/[0-9a-f-]{36}\/forks\/[0-9a-f-]{36}\/import\/entries$/i;
  const forkRecordImportPath =
    /^\/v1\/organizations\/[0-9a-f-]{36}\/cloud-workspaces\/[0-9a-f-]{36}\/forks\/[0-9a-f-]{36}\/import\/records$/i;
  const forkImportBodyMaximum = (
    method: string,
    path: string,
  ): number | null =>
    method === "POST" && forkBlobUploadPath.test(path)
      ? forkImportBodyLimits.blob
      : method === "PUT" && forkEntryImportPath.test(path)
        ? forkImportBodyLimits.entries
        : method === "PUT" && forkRecordImportPath.test(path)
          ? forkImportBodyLimits.records
          : null;
  app.use("/v1/*", async (c, next) => {
    const forkImportMaximum = forkImportBodyMaximum(c.req.method, c.req.path);
    if (forkImportMaximum !== null) {
      // Do not grant an anonymous chunked request a multi-MiB buffering budget.
      // Desktop callers know the exact body size and bind it in a canonical
      // Content-Length before authentication or body consumption.
      const rawLength = c.req.header("content-length") ?? "";
      if (!/^(?:0|[1-9][0-9]{0,8})$/.test(rawLength)) {
        throw new HttpError(
          411,
          "content_length_required",
          "Fork imports require an exact Content-Length",
        );
      }
      if (Number(rawLength) > forkImportMaximum) {
        throw new HttpError(413, "body_too_large", "Request body is too large");
      }
      await next();
      return;
    }
    if (c.req.path === "/v1/feedback") {
      await next();
      return;
    }
    await defaultBodyLimit(c, next);
  });

  // Everything under /v1 requires a verified JWT from the selected provider.
  app.use("/v1/*", createAuthMiddleware(config, pool));

  // Per-user ceiling across ALL /v1 routes. The sensitive endpoints keep their
  // own tighter limits (invite send/accept); this is the blanket abuse cap for
  // the rest (create-team, role changes) so an authenticated user can't
  // spam mutations or flood the audit log. Runs AFTER auth so it keys on the
  // verified user id, not the IP.
  app.use("/v1/*", rateLimit("global", 240, 60_000));

  // The larger fork-blob budget is available only after bearer verification
  // and the global per-user rate limit. The route rechecks exact fork
  // authority before durable publication.
  app.use("/v1/*", (c, next) => {
    const maximum = forkImportBodyMaximum(c.req.method, c.req.path);
    return maximum === null ? next() : bodyLimit({ maxSize: maximum })(c, next);
  });

  // Feedback can fan out to two paid third-party APIs and accept a larger
  // body, so keep a much tighter per-user ceiling in addition to the blanket
  // rate limit. Authentication has already populated the user key.
  app.use("/v1/feedback", rateLimit("feedback", 5, 60_000));

  // Only an authenticated, rate-limited sender may attach the deliberate
  // 500k-character, secret-scrubbed log tail. Two MiB covers worst-case UTF-8
  // plus JSON framing without granting that buffer to anonymous traffic.
  app.use("/v1/feedback", feedbackBodyLimit);

  app.route("/", createFeedbackRoutes(config.feedback));
  app.route("/", createAccountRecoveryRoutes(pool));
  app.route("/", createDeletionLifecycleRoutes(pool));
  if (config.workos?.opsOrigin && config.deploymentChannel !== "beta") {
    app.route(
      "/",
      createOpsRoutes(
        pool,
        config.deploymentChannel === "development"
          ? "development"
          : config.deploymentChannel,
      ),
    );
  }
  app.route(
    "/",
    createSecurityEventRoutes(
      pool,
      dependencies.securityEventBroker ?? new PostgresSecurityEventBroker(pool),
    ),
  );
  app.route(
    "/",
    createRoutes(pool, emailConfig, config.cloudWorkspaces, {
      cloudWorkspaceAccessService:
        dependencies.cloudWorkspaceAccessService ?? null,
      cloudWorkspaceRepositoryResolver:
        dependencies.cloudWorkspaceRepositoryResolver ?? null,
      cloudWorkspaceForkService: dependencies.cloudWorkspaceForkService ?? null,
      cloudWorkspaceReplicaService:
        dependencies.cloudWorkspaceReplicaService ?? null,
      cloudWorkspaceEngineClientAdmissionService:
        dependencies.cloudWorkspaceEngineClientAdmissionService ?? null,
      workosEnabled: config.auth.provider === "workos",
      ...(workosProvider ? { workosProvider } : {}),
      inviteLinkBase: config.inviteLinkBase,
    }),
  );
  if (config.github) app.route("/", createGithubRoutes(pool, config.github));

  app.onError((err, c) => {
    // Preserve deliberate framework responses such as bodyLimit's 413. Turning
    // them into a generic 500 both hides the real client error and defeats the
    // middleware contract.
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof HttpError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          },
        },
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

  return app;
}

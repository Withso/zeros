
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { isIP } from "node:net";
import type pg from "pg";

import type { Config } from "./config.js";
import { DatabaseAcquireTimeoutError } from "./db.js";
import { createReleaseIdentityRoutes } from "./release-identity.js";
import { ClientCompatibility, createClientCompatibilityMiddleware } from "./client-compatibility.js";
import { createAuthMiddleware } from "./auth.js";
import { createCloudV2ProxyRoutes, CLOUD_V2_PROXY_PREFIX, type CloudV2ProxyDeps } from "./cloud/proxy.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./cloud/routes.js";
import { createMcpServices } from "./mcp/composition.js";
import { createMcpPublicRoutes, createMcpRoutes } from "./mcp/routes.js";
import { createCloudV2WorkerRoutes, CLOUD_V2_WORKER_API, type CloudV2WorkerRouteDeps } from "./cloud/worker-routes.js";
import { createPrivateRateLimitKey, rateLimit } from "./ratelimit.js";
import { clientAddress } from "./client-address.js";
import { createChatTitleRoutes } from "./chat-titles.js";
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
import { createDevAuthConfigurationRoutes } from "./dev-auth-configuration.js";
import { createZerosDevAuthRoutes, zerosDevAuthEnabled, ZEROS_DEV_AUTH_PATHS, type ZerosDevAuthDependencies } from "./zeros-dev-auth.js";
import { DatabaseZerosDevAuthRepository } from "./zeros-dev-auth-repository.js";
import { ZerosDevWorkOSPasswordProvider } from "./zeros-dev-auth-workos.js";
import { RailwayWorkOSProvider } from "./workos-provider.js";
import { createAccountRecoveryRoutes } from "./account-recovery.js";
import { createDeletionLifecycleRoutes } from "./deletion-lifecycle.js";
import { createOpsRoutes } from "./ops.js";
import {
  PostgresSecurityEventBroker,
  createSecurityEventRoutes,
} from "./security-events.js";
import { createWorkOSManagementEventRoutes } from "./workos-sync-events.js";
import type { MigrationStatus } from "./migrate.js";
import { DEFAULT_SLOW_REQUEST_LOG_MS, requestTiming, type RequestCostObserverStatus, type RequestDatabaseCost } from "./request-timing.js";
import { createDatabaseTimingReporter } from "./database-timing.js";
import { observeDatabaseTiming, tracingMiddleware } from "./tracing.js";
import { cloudAgentCredentialKeys } from "./agent-credentials/agent-credentials.js";

export type CreateAppDependencies = {
  /** Cloud workspace v2: creator routes under /v1 and the worker model proxy. */
  cloudV2?: { routes: CloudV2RouteDeps; proxy: CloudV2ProxyDeps; workers: CloudV2WorkerRouteDeps };
  zerosDevAuth?: ZerosDevAuthDependencies;
  requestCostObserver?: (cost: RequestDatabaseCost) => void | Promise<void>;
  clientCompatibility?: ClientCompatibility;
  securityEventBroker?: PostgresSecurityEventBroker;
  workosProvider?: RailwayWorkOSProvider;
  migrationStatus?: MigrationStatus;
};

export type ControlPlaneApp = Hono & {
  readonly requestCostObserverStatus?: () => RequestCostObserverStatus;
};

const cloudTokenBucket = createPrivateRateLimitKey();

function isCloudWorkspaceApiPath(path: string): boolean {
  return path === "/v1/auth/snapshot" || path === "/v1/auth/events" || path.startsWith("/v1/cloud-v2/") || path.startsWith("/v2/cloud/") ||
    path === "/v1/cloud-agent-credentials" || path.startsWith("/v1/cloud-agent-credentials/") ||
    /^\/v1\/organizations\/[^/]+\/agent-connections(?:\/|$)/.test(path);
}

export function createApp(
  config: Config,
  pool: pg.Pool,
  emailConfig: EmailConfig,
  dependencies: CreateAppDependencies = {},
): ControlPlaneApp {
  const app: ControlPlaneApp = new Hono();
  const databaseTimingReporter = createDatabaseTimingReporter();
  const timing = requestTiming({ slowMs: config.slowRequestLogMs ?? DEFAULT_SLOW_REQUEST_LOG_MS,
    timingObserver: summary => { databaseTimingReporter.observe(summary); observeDatabaseTiming(summary); },
    ...(dependencies.requestCostObserver ? { costObserver: dependencies.requestCostObserver, databasePool: pool } : {}) });
  // Tracing wraps request timing so database spans join the request's trace.
  app.use("*", tracingMiddleware);
  app.use("*", timing);
  if (dependencies.requestCostObserver) {
    Object.defineProperty(app, "requestCostObserverStatus", { value: timing.costObserverStatus });
  }
  // A disabled test-only endpoint stays absent, including during maintenance.
  // Stale settings on another channel must not reveal an authentication path.
  if (!zerosDevAuthEnabled(config)) {
    for (const path of Object.values(ZEROS_DEV_AUTH_PATHS)) app.all(path, c => c.notFound());
  }
  // Readiness stays public even during maintenance; /healthz remains liveness.
  app.route("/", createReleaseIdentityRoutes(config, pool, dependencies));
  if (config.databaseMaintenanceMode) {
    // A restored database may contain deliverable outboxes and live sessions.
    // Do not even assemble provider/auth routers while fencing its writers.
    app.use("*", async c => {
      c.header("Cache-Control", "no-store");
      if ((c.req.method === "GET" || c.req.method === "HEAD") && c.req.path === "/healthz") {
        try {
          await pool.query("SELECT 1");
          return c.json({ ok: true, maintenance: true });
        } catch (error) {
          if (error instanceof DatabaseAcquireTimeoutError) c.header("Retry-After", "1");
          return c.json({ ok: false, maintenance: true }, 503);
        }
      }
      c.header("Retry-After", "30");
      return c.json({ error: "maintenance", message: "Service is temporarily unavailable" }, 503);
    });
    return app;
  }
  if (config.processRole === "worker" || config.processRole === "realtime") {
    // Worker replicas publish health/readiness but never serve user or engine
    // requests. Their two query slots remain available to the queues they own.
    // Realtime replicas serve only WebSocket upgrades (index.ts) besides this.
    app.get("/healthz", async c => {
      c.header("Cache-Control", "no-store");
      try { await pool.query("SELECT 1"); return c.json({ ok: true }); }
      catch (error) {
        if (error instanceof DatabaseAcquireTimeoutError) c.header("Retry-After", "1");
        return c.json({ ok: false }, 503);
      }
    });
    return app;
  }
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
              "This service is temporarily unavailable until the pending controlled migration is applied",
            migration: pendingMigration.migration,
          },
        },
        503,
      );
    });
  }
  if (dependencies.cloudV2) {
    app.use(`${CLOUD_V2_WORKER_API}/*`, rateLimit("cloud-v2-worker", 600, 60_000,
      c => cloudTokenBucket(c.req.header("authorization") ?? "")));
    app.route("/", createCloudV2WorkerRoutes(dependencies.cloudV2.workers));
    // Workspace proxy tokens, not user sessions, authenticate the model proxy.
    // Keyed per workspace token: many VMs can share one provider egress address.
    app.use(`${CLOUD_V2_PROXY_PREFIX}/*`, rateLimit("cloud-v2-proxy", 600, 60_000,
      c => cloudTokenBucket(c.req.header("authorization") ?? c.req.header("x-api-key") ?? "")));
    app.route("/", createCloudV2ProxyRoutes(dependencies.cloudV2.proxy));
  }
  const workosProvider = config.workos
    ? (dependencies.workosProvider ??
      new RailwayWorkOSProvider(config.auth, config.workos))
    : undefined;

  // Health: no auth (Railway healthcheck), proves DB reachability.
  app.get("/healthz", async (c) => {
    try {
      await pool.query("SELECT 1");
      const development = config.development ? { development: config.development } : {};
      const migrationState =
        dependencies.migrationStatus?.state === "controlled_migration_pending"
          ? { migrations: dependencies.migrationStatus }
          : {};
      return c.json({ ok: true, ...migrationState, ...development });
    } catch (error) {
      c.header("Cache-Control", "no-store");
      if (error instanceof DatabaseAcquireTimeoutError) c.header("Retry-After", "1");
      return c.json({ ok: false }, 503);
    }
  });

  // Dev discovery exposes only the anonymous public-client configuration.
  app.route("/", createDevAuthConfigurationRoutes(config));
  if (!pendingMigration && zerosDevAuthEnabled(config) && config.workos) {
    app.route("/", createZerosDevAuthRoutes(config, dependencies.zerosDevAuth ?? {
      repository: new DatabaseZerosDevAuthRepository(pool),
      provider: new ZerosDevWorkOSPasswordProvider(config.auth, config.workos),
    }));
  }

  // WorkOS browser/desktop auth precedes /v1 bearer middleware: these routes
  // authenticate with PKCE state, opaque HttpOnly cookies, webhook signatures
  // or a verified Desktop Application bearer.
  if (config.workos && workosProvider) {
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

  // /v1 uses explicit bearer tokens, with credentialed CORS disabled;
  // wildcard origins grant no ambient cookie authentication.
  app.use(
    "/v1/*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [
        "authorization",
        "content-type",
        "x-zeros-client",
        "idempotency-key",
        "traceparent",

      ],
      maxAge: 86400,
    }),
  );

  app.use("/v1/*", createClientCompatibilityMiddleware(
    dependencies.clientCompatibility ?? new ClientCompatibility({
      deploymentChannel: config.deploymentChannel,
      ledgerUrl: config.desktopReleaseLedgerUrl ?? null,
    }),
  ));

  // GitHub responses carry authentication state or credentials. Set no-store
  // before routing and auth so failures inherit the same cache boundary.
  for (const path of ["/v1/github/*", "/v1/cloud-v2/github/*"]) {
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      await next();
    });
  }

  // GitHub's browser callback authenticates by single-use state, not the desktop
  // bearer. Mount it before auth, including the unconfigured 503 response;
  // remaining GitHub routes keep normal auth, body limits and per-user limits.
  const cloudGithub = dependencies.cloudV2?.routes.githubConnections;
  if (config.github) {
    app.route("/", createGithubPublicRoutes(pool, config.github, cloudGithub
      ? { cloudCallback: (state,code,denied) => cloudGithub.callback(state,code,denied) } : {}));
  } else {
    console.warn(
      "[control-plane] GitHub App sign-in is not configured — " +
        "/v1/github/* answers 503 github_not_configured.",
    );
    app.route("/", createGithubUnconfiguredRoutes());
  }

  const mcp = createMcpServices(pool, config, cloudGithub?.authorizeRepositoryConfiguration.bind(cloudGithub));
  if (mcp) app.route("/", createMcpPublicRoutes(mcp.oauth));

  // Bound anonymous work by Railway's X-Real-IP before body buffering or JWT
  // verification. Invalid/missing IPs share one bucket rather than arbitrary keys.
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
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/feedback") {
      await next();
      return;
    }
    await defaultBodyLimit(c, next);
  });

  // Everything under /v1 requires a verified WorkOS access token.
  app.use("/v1/*", createAuthMiddleware(config, pool));

  // Key the blanket mutation limit by verified user identity, after auth.
  // Sensitive routes retain tighter limits.
  app.use("/v1/*", rateLimit("global", 240, 60_000));
  // Feedback reaches paid APIs and accepts larger bodies, so tighten its per-user limit.
  app.use("/v1/feedback", rateLimit("feedback", 5, 60_000));

  // Only an authenticated, rate-limited sender may attach the deliberate
  // 500k-character, secret-scrubbed log tail. Two MiB covers worst-case UTF-8
  // plus JSON framing without granting that buffer to anonymous traffic.
  app.use("/v1/feedback", feedbackBodyLimit);

  app.route("/", createFeedbackRoutes(config.feedback));
  app.route("/", createChatTitleRoutes(config.chatTitleApiKey));
  if (mcp) app.route("/", createMcpRoutes(mcp.store, mcp.oauth));
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
  if (dependencies.cloudV2) app.route("/", createCloudV2Routes(dependencies.cloudV2.routes));
  app.route(
    "/",
    createRoutes(pool, emailConfig, {
      cloudAgentCredentialKeys: cloudAgentCredentialKeys(config.cloudAgentCredentials ?? null),
      workosEnabled: config.workos !== null,
      ...(workosProvider ? { workosProvider } : {}),
      inviteLinkBase: config.inviteLinkBase,
    }),
  );
  if (config.github) app.route("/", createGithubRoutes(pool, config.github));

  app.onError((err, c) => {
    if (err instanceof DatabaseAcquireTimeoutError) {
      c.header("Cache-Control", "no-store");
      c.header("Retry-After", "1");
      return c.json({ error: { code: "service_busy", message: "Service is temporarily busy" } }, 503);
    }
    // Preserve framework statuses such as bodyLimit's 413 instead of masking them as 500.
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof HttpError) {
      if (c.req.path.startsWith("/v1/cloud-v2/") && err.status >= 500) {
        return c.json({ error: { code: "cloud_workspace_unavailable", message: "The cloud workspace is temporarily unavailable" } }, err.status);
      }
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
    // Driver errors may contain SQL, identity data and bound values. Retain
    // only a bounded SQLSTATE for diagnosis; unknown errors stay private in
    // every deployment channel, including development and qualification.
    const sqlState = "code" in err && typeof err.code === "string" &&
      /^[A-Z0-9]{5}$/.test(err.code) ? err.code : undefined;
    console.error("[error]", { code: "internal", ...(sqlState ? { sqlState } : {}) });
    return c.json(
      {
        error: {
          code: "internal",
          message: "Internal error",
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

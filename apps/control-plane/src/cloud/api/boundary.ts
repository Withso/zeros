import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HttpError } from "../../authz.js";
import { isDatabaseUnavailable } from "../../db.js";
import { rateLimit } from "../../ratelimit.js";
import { CLOUD_V2_MAX_PROMPT_BYTES } from "../prompt-contract.js";
import type { CloudApiCredential, CloudApiCredentials } from "./credentials.js";
import type { CloudApiService } from "./service.js";
import { cloudApiPreAuthLimit, resolveCloudApiCredential } from "./preauth.js";

export type CloudApiDependencies = { credentials: CloudApiCredentials; service: CloudApiService };
export type CloudApiEnv = { Variables: { cloudApiCredential: CloudApiCredential } };

export function cloudApiFailure(error: unknown) {
  if (isDatabaseUnavailable(error)) return { status: 503 as const, retryAfter: 1,
    error: { code: "service_busy", message: "Service is temporarily busy" } };
  if (error instanceof HttpError) return { status: error.status === 403 ? 404 as const : error.status,
    retryAfter: error.status === 429 && typeof error.details?.retryAfterSeconds === "number" ? error.details.retryAfterSeconds : undefined,
    error: { code: error.status === 403 ? "not_found" : error.code, message: error.status === 403 ? "Not found" : error.message,
      ...(error.code === "agent_login_required" && "agent" in error ? { agent: error.agent } : {}) } };
  return { status: 500 as const, error: { code: "internal", message: "Internal error" } };
}

/** HTTP and MCP share limiter buckets as well as request-time authority. */
export function createCloudApiBoundary(credentials: CloudApiCredentials): Hono<CloudApiEnv> {
  const app = new Hono<CloudApiEnv>();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("*", cloudApiPreAuthLimit());
  app.use("*", bodyLimit({ maxSize: CLOUD_V2_MAX_PROMPT_BYTES,
    onError: c => c.json({ error: { code: "payload_too_large", message: "Request is too large" } }, 413) }));
  app.use("*", async (c, next) => {
    c.set("cloudApiCredential", await resolveCloudApiCredential(c, credentials));
    await next();
  });
  app.use("*", rateLimit("cloud-api", 240, 60_000, c => c.get("cloudApiCredential").credentialId));
  app.use("*", async (c, next) => {
    if (["POST", "PUT", "PATCH"].includes(c.req.method) && c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      && (await c.req.arrayBuffer()).byteLength > 0)
      throw new HttpError(415, "unsupported_media_type", "Use application/json");
    await next();
  });
  app.onError((error, c) => {
    const failure = cloudApiFailure(error);
    if (failure.retryAfter !== undefined) c.header("Retry-After", String(failure.retryAfter));
    return c.json({ error: failure.error }, failure.status);
  });
  return app;
}

export function cloudApiCreateLimit(): MiddlewareHandler<CloudApiEnv> {
  const user = rateLimit("cloud-api-create-key", 60, 60 * 60_000, c => c.get("cloudApiCredential").credentialId);
  const workspace = rateLimit("cloud-api-create-workspace", 10, 60 * 60_000, c => c.get("cloudApiCredential").credentialId);
  return (c, next) => (c.get("cloudApiCredential").kind === "api_key" ? user : workspace)(c, next);
}

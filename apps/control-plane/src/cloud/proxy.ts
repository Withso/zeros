// The Zeros model proxy. Agents on a cloud v2 VM talk to these routes with a
// short-lived workspace proxy token; the proxy swaps in the creator's real
// login from the vault, so native tokens never reach the VM. Upstream hosts
// are fixed, so a caller can choose only the path.
import { Hono } from "hono";
import type { CloudV2AgentLogins } from "./agent-logins.js";
import type { CloudV2Store } from "./store.js";
import { isCloudV2Token } from "./tokens.js";

export const CLOUD_V2_PROXY_PREFIX = "/v2/cloud/proxy";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const OAUTH_BETA = "oauth-2025-04-20";
/** Hop-by-hop and identity headers that must not cross the proxy. */
const DROP = new Set([
  "authorization", "x-api-key", "host", "connection", "keep-alive", "content-length", "transfer-encoding", "te", "trailer",
  "upgrade", "cookie", "proxy-authorization", "proxy-connection", "chatgpt-account-id", "forwarded", "via",
]);

export type CloudV2ProxyDeps = {
  store: Pick<CloudV2Store, "verifyProxyToken">;
  logins: CloudV2AgentLogins;
  fetch?: typeof fetch;
  now?: () => number;
};

function failure(status: 400 | 401 | 404 | 413, code: string, message: string): Response {
  return Response.json({ error: { type: "zeros_proxy_error", code, message } }, { status });
}

function forwardHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    const key = name.toLowerCase();
    if (!DROP.has(key) && !key.startsWith("x-forwarded-") && !key.startsWith("cf-")) headers.set(name, value);
  });
  return headers;
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : request.headers.get("x-api-key") ?? "";
}

export function createCloudV2ProxyRoutes(deps: CloudV2ProxyDeps): Hono {
  const app = new Hono();
  const upstreamFetch = deps.fetch ?? fetch;

  app.all(`${CLOUD_V2_PROXY_PREFIX}/:provider/*`, async c => {
    const provider = c.req.param("provider");
    if (provider !== "openai" && provider !== "anthropic") return failure(404, "not_found", "Unknown proxy");
    const token = bearer(c.req.raw);
    if (!isCloudV2Token(token, "proxy")) return failure(401, "proxy_token_invalid", "Invalid workspace proxy token");
    const workspace = await deps.store.verifyProxyToken(token);
    if (!workspace) return failure(401, "proxy_token_invalid", "The workspace proxy token expired or was revoked");
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_REQUEST_BYTES) return failure(413, "payload_too_large", "Request is too large");

    const url = new URL(c.req.url);
    const rest = url.pathname.slice(`${CLOUD_V2_PROXY_PREFIX}/${provider}`.length) || "/";
    if (rest.split("/").some(part => part === ".." || part === ".")) return failure(400, "invalid_path", "Invalid proxy path");
    const headers = forwardHeaders(c.req.raw.headers);
    let target: string;

    if (provider === "openai") {
      const login = await deps.logins(workspace.creatorUserId, workspace.organizationId, "codex");
      if (!login) return failure(401, "agent_login_required", "Connect Codex in Settings → Agents for this organization");
      if (login.kind === "codex-chatgpt") {
        if (login.expiresAt * 1000 <= (deps.now?.() ?? Date.now()) + 30_000)
          return failure(401, "agent_login_expired", "Reconnect Codex in Settings → Agents");
        target = `https://chatgpt.com/backend-api/codex${rest}`;
        headers.set("authorization", `Bearer ${login.accessToken}`);
        headers.set("chatgpt-account-id", login.accountId);
      } else if (login.kind === "codex-api-key") {
        target = `https://api.openai.com/v1${rest}`;
        headers.set("authorization", `Bearer ${login.apiKey}`);
      } else return failure(401, "agent_login_required", "Connect Codex in Settings → Agents for this organization");
    } else {
      const login = await deps.logins(workspace.creatorUserId, workspace.organizationId, "claude");
      if (!login) return failure(401, "agent_login_required", "Connect Claude in Settings → Agents for this organization");
      target = `https://api.anthropic.com${rest}`;
      if (login.kind === "claude-setup-token") {
        headers.set("authorization", `Bearer ${login.accessToken}`);
        const betas = (headers.get("anthropic-beta") ?? "").split(",").map(value => value.trim()).filter(Boolean);
        if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
        headers.set("anthropic-beta", betas.join(","));
      } else if (login.kind === "claude-api-key") {
        headers.set("x-api-key", login.apiKey);
      } else return failure(401, "agent_login_required", "Connect Claude in Settings → Agents for this organization");
    }

    const method = c.req.method;
    const upstream = await upstreamFetch(target + url.search, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: c.req.raw.body, duplex: "half" }),
      redirect: "manual",
      signal: c.req.raw.signal,
    } as RequestInit);
    const response = new Headers();
    upstream.headers.forEach((value, name) => {
      const key = name.toLowerCase();
      if (!["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"].includes(key)) response.set(name, value);
    });
    return new Response(upstream.body, { status: upstream.status, headers: response });
  });

  return app;
}

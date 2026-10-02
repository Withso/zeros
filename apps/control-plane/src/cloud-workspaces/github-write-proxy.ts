import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { githubGitDownload } from "./github-git-stream.js";
import { assertGithubReviewTarget, authorizeGithubReviewRequest, githubReviewPreflight } from "./github-review-policy.js";
import type { DatabaseCloudGithubWriteGrants, GithubProxyAuthority } from "./github-write-grants.js";

export const CLOUD_GITHUB_PROXY_PATH = "/internal/v1/cloud-workspaces/github-proxy";
const denied = () => new Error("GitHub write request is not authorized");
const readyQuery = "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}";
class GitPacketPolicyError extends Error {
  constructor(readonly reason: "invalid-length" | "empty-update" | "multiple-updates" | "invalid-command" | "delete" | "reference" | "options") { super("Git update is not authorized"); }
}

/** Exact operation/body binding. No general GitHub/GraphQL forwarding surface. */
export function authorizeGithubApiRequest(scope: GithubProxyAuthority, method: string, path: string, body: unknown, nodeId?: string): "api" | null {
  const review = authorizeGithubReviewRequest(scope, method, path, body);
  if (review !== undefined) return review;
  const repo = `/repos/${scope.owner}/${scope.repository}`;
  if (method === "GET" && path === `${repo}/pulls/${scope.prNumber}` && scope.operation === "gh.prMarkReady") return null;
  if (method === "POST" && path === "/graphql" && scope.operation === "gh.prMarkReady") {
    const parsed = z.object({ query: z.string(), variables: z.object({ id: z.string() }).strict() }).strict().safeParse(body);
    if (parsed.success && parsed.data.query.replace(/\s/g, "") === readyQuery && nodeId && parsed.data.variables.id === nodeId) return "api";
    throw denied();
  }
  const allowed = (scope.operation === "gh.prCreate" && method === "POST" && path === `${repo}/pulls`) ||
    (scope.operation === "gh.prUpdate" && method === "PATCH" && path === `${repo}/pulls/${scope.prNumber}`) ||
    (scope.operation === "gh.prMerge" && method === "PUT" && path === `${repo}/pulls/${scope.prNumber}/merge`) ||
    (scope.operation === "gh.prComment" && method === "POST" && path === `${repo}/issues/${scope.prNumber}/comments`);
  if (!allowed || !scope.expectedBody || !isDeepStrictEqual(body, scope.expectedBody)) throw denied();
  return "api";
}

/** Parse only receive-pack's command header, before forwarding any bytes.
 * GitHub itself enforces the user's branch protections and object validity. */
export function validateGitReceivePackHeader(bytes: Buffer, reference: string): boolean {
  let offset = 0, commands = 0, shallowCount = 0, objectLength = 0;
  while (bytes.length >= offset + 4) {
    const hex = bytes.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new GitPacketPolicyError("invalid-length");
    const length = Number.parseInt(hex, 16);
    if (length === 0) { if (commands !== 1) throw new GitPacketPolicyError("empty-update"); return true; }
    if (length < 4 || length > 8192) throw new GitPacketPolicyError("invalid-length");
    if (commands > 0) throw new GitPacketPolicyError("multiple-updates");
    if (bytes.length < offset + length) return false;
    const command = bytes.subarray(offset + 4, offset + length).toString("utf8").replace(/\n$/, "");
    // gitprotocol-pack allows shallow boundaries before the update list.
    // They describe history, not additional write targets. Bound their count
    // and object format; the one-reference and non-delete rules still apply.
    const shallow = /^shallow ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(command);
    if (shallow) {
      if (++shallowCount > 128 || (objectLength && objectLength !== shallow[1]!.length))
        throw new GitPacketPolicyError("invalid-command");
      objectLength = shallow[1]!.length;
      offset += length;
      continue;
    }
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([^\s\0]+)(?:\0([^\r\n]*))?$/.exec(command);
    if (!match || match[1]!.length !== match[2]!.length || (objectLength && objectLength !== match[1]!.length)) throw new GitPacketPolicyError("invalid-command");
    if (/^0+$/.test(match[2]!)) throw new GitPacketPolicyError("delete");
    if (match[3] !== reference) throw new GitPacketPolicyError("reference");
    if ((match[4] ?? "").split(" ").some(value => ["push-options", "push-cert"].includes(value))) throw new GitPacketPolicyError("options");
    commands++; offset += length;
  }
  return false;
}
async function receivePackBody(body: ReadableStream<Uint8Array>, reference: string): Promise<ReadableStream<Uint8Array> | null> {
  const reader = body.getReader(); let size = 0, prefix = Buffer.alloc(0);
  try {
    while (!validateGitReceivePackHeader(prefix, reference)) {
      if (prefix.length > 16384) throw denied();
      const chunk = await reader.read(); if (chunk.done) throw denied();
      size += chunk.value.length; if (size > 128 * 1024 * 1024) throw denied();
      prefix = Buffer.concat([prefix, chunk.value]);
      // Git probes authentication before a chunked RPC with a flush-only
      // request. It contains no update and must not spend the one-write grant.
      // Require EOF: a flush followed by hidden commands is not this probe.
      if (prefix.length === 4 && prefix.toString("ascii") === "0000") {
        const tail = await reader.read();
        if (tail.done) { reader.releaseLock(); return null; }
        size += tail.value.length; if (size > 128 * 1024 * 1024) throw denied();
        prefix = Buffer.concat([prefix, tail.value]);
      }
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  let first = true;
  return new ReadableStream({
    async pull(controller) {
      try {
        if (first) { first = false; controller.enqueue(prefix); prefix = Buffer.alloc(0); return; }
        const chunk = await reader.read(); if (chunk.done) { controller.close(); reader.releaseLock(); return; }
        size += chunk.value.length; if (size > 128 * 1024 * 1024) throw denied();
        controller.enqueue(chunk.value);
      } catch (error) { await reader.cancel().catch(() => undefined); controller.error(error); }
    },
    cancel: reason => reader.cancel(reason),
  });
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length")) > 2 * 1024 * 1024) { await response.body?.cancel(); throw denied(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2 * 1024 * 1024) throw denied(); chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}
function capability(header: string | undefined): string | null {
  let token = /^(?:Bearer|token) (zgp_[A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1];
  if (!token && header?.startsWith("Basic ") && header.length < 256)
    token = /^x-access-token:(zgp_[A-Za-z0-9_-]{43})$/.exec(Buffer.from(header.slice(6), "base64").toString("utf8"))?.[1];
  return token ?? null;
}
export function createCloudGithubProxyRoutes(service: DatabaseCloudGithubWriteGrants, requestFetch: typeof fetch = fetch): Hono {
  const app = new Hono();
  app.use(`${CLOUD_GITHUB_PROXY_PATH}/api/*`, bodyLimit({ maxSize: 256 * 1024 }));
  app.all(`${CLOUD_GITHUB_PROXY_PATH}/*`, async c => {
    c.header("Cache-Control", "no-store");
    const proxy = capability(c.req.header("authorization"));
    if (!proxy) {
      c.header("WWW-Authenticate", 'Basic realm="Zeros GitHub write"');
      return c.json({ message: "GitHub write authorization required" }, 401);
    }
    // Fixed stages/status only. URLs, bodies, credentials and exception text
    // may contain user data and must never enter operational logs.
    let stage = "admission", upstreamStatus: number | null = null;
    try {
      const scope = await service.authorizeProxy(proxy), url = new URL(c.req.url);
      const headers = { authorization: `Bearer ${scope.userToken}`, accept: "application/vnd.github+json", "user-agent": "zeros-control-plane", "x-github-api-version": "2026-03-10" };
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(Math.max(1, Math.min(120000, scope.expiresAtMs - Date.now())))]);
      const json = async (path: string, init: RequestInit = {}) => {
        const response = await requestFetch(`https://api.github.com${path}`, { ...init, redirect: "error", signal, headers: { ...headers, ...init.headers } });
        upstreamStatus = response.status;
        return { response, data: await boundedJson(response) };
      };
      // The immutable identity matters when a repository is renamed/transferred
      // and a different repository appears at its old URL.
      stage = "repository";
      const identity = await json(`/repos/${scope.owner}/${scope.repository}`);
      if (!identity.response.ok || String((identity.data as { id?: unknown })?.id) !== scope.repositoryId) throw denied();
      if (url.pathname.startsWith(`${CLOUD_GITHUB_PROXY_PATH}/api/`)) {
        stage = "api-policy";
        const path = url.pathname.slice(`${CLOUD_GITHUB_PROXY_PATH}/api`.length) + url.search;
        const body: unknown = c.req.method === "GET" ? undefined : await c.req.json();
        let nodeId: string | undefined;
        const reviewPreflight = githubReviewPreflight(scope);
        if (reviewPreflight) {
          const target = await json(reviewPreflight.path, reviewPreflight.body ? {
            method: "POST", body: JSON.stringify(reviewPreflight.body), headers: { "content-type": "application/json" },
          } : {});
          if (!target.response.ok) throw denied();
          assertGithubReviewTarget(scope, target.data);
        }
        if (path === "/graphql" && scope.operation === "gh.prMarkReady") {
          const pr = await json(`/repos/${scope.owner}/${scope.repository}/pulls/${scope.prNumber}`);
          if (!pr.response.ok) throw denied();
          nodeId = z.object({ node_id: z.string().min(1).max(256) }).parse(pr.data).node_id;
        }
        const write = authorizeGithubApiRequest(scope, c.req.method, path, body, nodeId);
        // Network identity checks must not outlive the current actor/engine.
        const current = await service.authorizeProxy(proxy, write);
        authorizeGithubApiRequest(current, c.req.method, path, body, nodeId);
        stage = "api-upstream";
        const { response, data } = await json(path, { method: c.req.method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
        if (!response.ok) {
          const message = (data as { message?: unknown })?.message;
          if (response.status === 422 && scope.operation === "gh.prCreate" && typeof message === "string" && /draft/i.test(message) && /(not|cannot|unsupported|isn't)/i.test(message)) {
            await service.allowDraftFallback(proxy);
            return c.json({ message: "Draft pull requests are not supported for this repository." }, 422);
          }
          // Do not echo provider diagnostics/headers that may contain credentials.
          return new Response(JSON.stringify({ message: `GitHub rejected this operation (${response.status}).` }), { status: response.status >= 400 && response.status < 500 ? response.status : 502, headers: { "content-type": "application/json", "cache-control": "no-store" } });
        }
        return new Response(JSON.stringify(data), { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      const repoPath = `${CLOUD_GITHUB_PROXY_PATH}/git/${scope.owner}/${scope.repository}.git`;
      stage = "git-operation";
      if (!["git.fetch", "git.push", "gh.prCreate"].includes(scope.operation)) throw denied();
      stage = "git-route";
      const rpc = scope.operation === "git.fetch" ? "git-upload-pack" : "git-receive-pack";
      const discovery = c.req.method === "GET" && url.pathname === `${repoPath}/info/refs` && url.search === `?service=${rpc}`;
      const post = c.req.method === "POST" && url.pathname === `${repoPath}/${rpc}` && !url.search;
      const write = post && rpc === "git-receive-pack";
      if (!discovery && !post) throw denied();
      const encoding = c.req.header("content-encoding"), protocol = c.req.header("git-protocol");
      if ((encoding && (!post || write || encoding !== "gzip")) || (protocol && !/^version=[012]$/.test(protocol))) throw denied();
      let body: ReadableStream<Uint8Array> | undefined;
      if (post && !write) {
        if (c.req.header("content-type") !== "application/x-git-upload-pack-request" || !c.req.raw.body) throw denied();
        let received = 0;
        body = c.req.raw.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
          received += chunk.length; if (received > 128 * 1024 * 1024) throw denied(); controller.enqueue(chunk);
        } }), { signal });
      }
      if (write) {
        stage = "git-headers";
        if (c.req.header("content-type") !== "application/x-git-receive-pack-request" || c.req.header("content-encoding") || !c.req.raw.body || !scope.gitReference) throw denied();
        stage = "git-packets";
        const parsed = await receivePackBody(c.req.raw.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }), scope.gitReference);
        if (parsed === null) {
          await service.authorizeProxy(proxy);
          return new Response(null, { headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-store" } });
        }
        body = parsed;
      }
      try {
        stage = "git-authority";
        await service.authorizeProxy(proxy, write ? "git" : null);
        stage = write ? "git-write" : "git-discovery";
        const response = await requestFetch(`https://github.com/${scope.owner}/${scope.repository}.git/${discovery ? `info/refs?service=${rpc}` : rpc}`, {
          method: c.req.method, redirect: "error", signal,
          headers: { authorization: `Basic ${Buffer.from(`x-access-token:${scope.userToken}`).toString("base64")}`, "user-agent": "zeros-control-plane", ...(post ? { "content-type": `application/x-${rpc}-request` } : {}), ...(encoding ? { "content-encoding": encoding } : {}), ...(protocol ? { "git-protocol": protocol } : {}) },
          ...(body ? { body, duplex: "half" } : {}),
        } as RequestInit);
        upstreamStatus = response.status;
        const type = `application/x-${rpc}-${discovery ? "advertisement" : "result"}`;
        if (!response.ok || response.headers.get("content-type") !== type || !response.body) { await response.body?.cancel(); throw denied(); }
        const stream = githubGitDownload(response.body, [scope.userToken, proxy,
          Buffer.from(`x-access-token:${scope.userToken}`).toString("base64")]);
        return new Response(stream, { headers: { "content-type": type, "cache-control": "no-store" } });
      } catch (error) { await body?.cancel().catch(() => undefined); throw error; }
    } catch (error) {
      console.warn("[github-write-proxy] request rejected", { stage, upstreamStatus,
        ...(stage === "git-packets" ? { packet: error instanceof GitPacketPolicyError ? error.reason : "unreadable-stream" } : {}) });
      return c.json({ message: "GitHub write authorization expired or this operation is unavailable. Try again." }, 403);
    }
  });
  return app;
}

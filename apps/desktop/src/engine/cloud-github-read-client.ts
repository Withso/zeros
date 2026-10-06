import type { CloudRuntimeAuthority } from "./cloud-runtime-registration";

const unavailable = () => new Error("GitHub read authorization is unavailable. Reconnect the workspace and try again.");
const MAX_BYTES = 8 * 1024 * 1024;

/** Octokit fetch transport: only read shapes and actor identity cross this
 * boundary. The installation credential never enters the engine. */
export async function requestCloudGithubRead(authority: CloudRuntimeAuthority, actorSessionId: string, signal: AbortSignal,
  input: Parameters<typeof fetch>[0], init?: RequestInit, requestFetch: typeof fetch = fetch): Promise<Response> {
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash) throw unavailable();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method !== "GET" && method !== "POST") throw unavailable();
    const accept = new Headers(init?.headers).get("accept") ?? "";
    const request = { method, path: `${url.pathname}${url.search}`, format: accept.includes(".diff") ? "diff" : "json",
      ...(new Headers(init?.headers).get("cache-control") === "no-cache" ? { fresh: true } : {}),
      ...(method === "POST" ? { body: JSON.parse(String(init?.body)) } : {}) };
    const { heartbeatEndpoint, heartbeatToken, ...scope } = authority;
    const endpoint = new URL("/internal/v1/cloud-workspaces/engine/github-read", heartbeatEndpoint);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) throw unavailable();
    const response = await requestFetch(endpoint, { method: "POST", redirect: "error",
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(45_000)]),
      headers: { "content-type": "application/json", authorization: `Bearer ${heartbeatToken}` },
      body: JSON.stringify({ ...scope, actorSessionId, request }) });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined); throw unavailable();
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length; if (size > MAX_BYTES) throw unavailable();
        chunks.push(chunk.value);
      }
      return new Response(Buffer.concat(chunks), { status: 200, headers: {
        "content-type": request.format === "diff" ? "text/plain" : "application/json",
      } });
    } catch { await reader.cancel().catch(() => undefined); throw unavailable(); }
    finally { reader.releaseLock(); }
  } catch { throw unavailable(); }
}

import { z } from "zod";
import { CloudGitAuthorSchema, type CloudGitAuthor } from "@zeros/protocol/cloud-agent-execution";
import type { CloudRuntimeAuthority } from "./cloud-runtime-registration";
import type { GithubWriteCredential } from "./git/github-write-context";

export type CloudGithubWriteRequest =
  | { kind: "redeem"; actorSessionId: string; grant: string; operation: string; paramsSha256: string; params: Record<string, unknown>; branch: string; baseBranch: string }
  | { kind: "release"; grant: string };
const credentialSchema = z.object({ token: z.string().regex(/^zgp_[A-Za-z0-9_-]{43}$/),
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  expiresAtMs: z.number().int().positive().safe() }).strict();
const unavailable = () => new Error("GitHub write authorization is unavailable. Reconnect GitHub and try again.");
type AuthorRequest = { kind: "author"; actorSessionId: string };
export function requestCloudGithubWrite(authority: CloudRuntimeAuthority, request: AuthorRequest,
  signal: AbortSignal, requestFetch?: typeof fetch): Promise<CloudGitAuthor | null>;
export function requestCloudGithubWrite(authority: CloudRuntimeAuthority, request: CloudGithubWriteRequest,
  signal: AbortSignal, requestFetch?: typeof fetch): Promise<GithubWriteCredential | null>;
export async function requestCloudGithubWrite(authority: CloudRuntimeAuthority, request: CloudGithubWriteRequest | AuthorRequest,
  signal: AbortSignal, requestFetch: typeof fetch = fetch): Promise<GithubWriteCredential | CloudGitAuthor | null> {
  const { heartbeatEndpoint, heartbeatToken, ...scope } = authority;
  let response: Response;
  try {
    const endpoint = new URL("/internal/v1/cloud-workspaces/engine/github-write", heartbeatEndpoint);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) throw unavailable();
    response = await requestFetch(endpoint, { method: "POST", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), headers: { "content-type": "application/json", authorization: `Bearer ${heartbeatToken}` },
      body: JSON.stringify({ ...scope, request }) });
  } catch { throw unavailable(); }
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 8192) {
    await response.body?.cancel().catch(() => undefined); throw unavailable();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length; if (size > 8192) throw unavailable();
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (request.kind === "author") return z.object({ author: CloudGitAuthorSchema.nullable() }).strict().parse(value).author;
    if (request.kind === "release") {
      z.object({ released: z.literal(true) }).strict().parse(value); return null;
    }
    const credential = credentialSchema.parse(value);
    if (credential.expiresAtMs <= Date.now() || credential.expiresAtMs > Date.now() + 3 * 60_000) throw unavailable();
    return { ...credential, apiBaseUrl: new URL("/internal/v1/cloud-workspaces/github-proxy/api", heartbeatEndpoint).toString(),
      gitBaseUrl: new URL("/internal/v1/cloud-workspaces/github-proxy/git/", heartbeatEndpoint).toString() };
  } catch { await reader.cancel().catch(() => undefined); throw unavailable(); }
  finally { reader.releaseLock(); }
}

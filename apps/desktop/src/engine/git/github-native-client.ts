import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CLOUD_GITHUB_DESKTOP_REQUIRED, cloudGithubNativeContextSchema,
  type CloudGithubNativeSource,
} from "@zeros/protocol/github-auth";
import type { CloudRuntimeAuthority } from "../cloud-runtime-registration";
import { requestNativeGithubDesktop } from "./github-native-desktop";

let authority: (() => CloudRuntimeAuthority | null) | undefined;
let requestFetch: typeof fetch = fetch;
let capability: Promise<boolean> | undefined;
export function configureNativeGithubTransport(read: () => CloudRuntimeAuthority | null, fetchImpl: typeof fetch = fetch): void {
  authority = read; requestFetch = fetchImpl; capability = undefined;
}
const denied = () => new Error(CLOUD_GITHUB_DESKTOP_REQUIRED);
function endpoint(path: string) {
  const scope = authority?.();
  if (!scope) throw denied();
  const url = new URL(path, scope.heartbeatEndpoint);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw denied();
  return { scope, url };
}
async function post(request: unknown, signal: AbortSignal): Promise<unknown> {
  const { url, scope: { heartbeatEndpoint: _endpoint, heartbeatToken, ...scope } } = endpoint("/internal/v1/cloud-workspaces/engine/github-write");
  const response = await requestFetch(url, { method: "POST", redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    headers: { "content-type": "application/json", authorization: `Bearer ${heartbeatToken}` },
    body: JSON.stringify({ ...scope, request }) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw denied(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
      if (size > 8192) throw denied(); chunks.push(chunk.value); }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } catch { await reader.cancel().catch(() => undefined); throw denied(); }
  finally { reader.releaseLock(); }
}
/** Old control planes have no connected-account native path. Fail closed;
 * never fall back to an installation credential for native Git. */
export function nativeGithubSupported(): Promise<boolean> {
  capability ??= post({ kind: "native-capabilities" }, AbortSignal.timeout(5000))
    .then(value => z.object({ nativeGit: z.literal(1) }).strict().safeParse(value).success).catch(() => false);
  const current = capability;
  void current.then(supported => { if (!supported && capability === current) capability = undefined; });
  return current;
}
export type NativeGitOperation = { source: CloudGithubNativeSource; operation: "git.push" | "git.fetch"; branch: string | null };
export type NativeGitCredential = { token: string; owner: string; repository: string; expiresAtMs: number; release(): Promise<void> };
export async function requestNativeGithub(request: NativeGitOperation, signal: AbortSignal): Promise<NativeGitCredential> {
  let grant: string | undefined;
  const release = async () => { if (grant) await post({ kind: "release", grant }, AbortSignal.timeout(5000)).catch(() => undefined); };
  try {
    if (!await nativeGithubSupported() || signal.aborted) throw denied();
    const context = cloudGithubNativeContextSchema.parse(await post({ kind: "native-context", source: request.source }, signal));
    const current = authority?.();
    if (!current || context.workspaceId !== current.workspaceId || context.organizationId !== current.organizationId ||
        context.generation !== current.generation || context.engineInstanceId !== current.engineInstanceId) throw denied();
    const native = { requestId: randomUUID(), generation: context.generation, engineInstanceId: context.engineInstanceId,
      source: request.source, branch: request.branch };
    const params = { nativeRequestId: native.requestId };
    const paramsSha256 = createHash("sha256").update(JSON.stringify([request.operation, params])).digest("hex");
    const prepared = await requestNativeGithubDesktop({ ...context, operation: request.operation, paramsSha256, native }, signal);
    grant = prepared.grant;
    if (signal.aborted) throw denied();
    const result = z.object({ token: z.string().regex(/^zgp_[A-Za-z0-9_-]{43}$/), owner: z.string(), repository: z.string(),
      expiresAtMs: z.number().int().safe() }).strict().parse(await post({ kind: "redeem", grant,
      actorSessionId: prepared.actorSessionId, operation: request.operation, params, paramsSha256,
      branch: request.branch ?? "HEAD", baseBranch: request.branch ?? "HEAD" }, signal));
    if (signal.aborted || result.owner !== context.owner || result.repository !== context.repository ||
        result.expiresAtMs <= Date.now() || result.expiresAtMs > Date.now() + 60000) throw denied();
    return { ...result, release };
  } catch { await release(); throw denied(); }
}
export async function forwardNativeGithub(path: string, token: string, init: RequestInit): Promise<Response> {
  try {
    const { url } = endpoint(`/internal/v1/cloud-workspaces/github-proxy/git${path}`);
    return await requestFetch(url, { ...init, redirect: "error", headers: { ...init.headers, authorization: `Bearer ${token}` } });
  } catch { throw denied(); }
}

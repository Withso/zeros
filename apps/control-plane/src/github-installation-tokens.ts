import { z } from "zod";
import type { GithubBackendConfig } from "./config.js";
import { HttpError } from "./authz.js";
import { createGithubAppJwt } from "./github-app-jwt.js";
import { GithubTemporaryError, githubRateLimit, githubRetryAfter } from "./github-availability.js";

export type GithubRepositoryPermissions = {
  metadata: "read";
  contents?: "read" | "write";
  pull_requests?: "read" | "write";
};
export const githubHeaders = (token: string) => ({
  accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
  "content-type": "application/json", "user-agent": "zeros-control-plane", "x-github-api-version": "2026-03-10",
});

export async function githubJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch { throw new GithubTemporaryError("github_unavailable"); }
  if (!response.ok) {
    const limited = await githubRateLimit(response);
    void response.body?.cancel().catch(() => {});
    if (limited) throw limited;
    if (response.status >= 500) throw new GithubTemporaryError("github_unavailable", githubRetryAfter(response));
    throw new HttpError(response.status === 403 || response.status === 404 ? 403 : 503,
      "github_repository_unavailable", "GitHub could not verify repository access. Reconnect GitHub or try again.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(503, "github_unavailable", "GitHub returned an incomplete response.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 128 * 1024) { await reader.cancel(); throw new Error("response limit"); }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(503, "github_unavailable", "GitHub returned an incomplete response.");
  } finally { reader.releaseLock(); }
}

export async function revokeGithubInstallationToken(fetchImpl: typeof fetch, config: GithubBackendConfig, token: string): Promise<void> {
  const response = await fetchImpl(`${config.apiBaseUrl}/installation/token`, {
    method: "DELETE", headers: githubHeaders(token), redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
}

/** No unscoped overload: omitting names or permissions inherits the entire installation. */
export async function mintGithubInstallationToken(fetchImpl: typeof fetch, config: GithubBackendConfig, input: {
  installationId: number; repositories: readonly string[]; repositoryIds?: readonly string[]; permissions: GithubRepositoryPermissions; nowMs: number;
}): Promise<{ token: string; expiresAtMs: number }> {
  const names = z.array(z.string().max(100).regex(/^[A-Za-z0-9_.-]+$/)).min(1).max(10).safeParse(input.repositories);
  const ids = input.repositoryIds?.map(Number);
  if (!names.success || !Number.isSafeInteger(input.installationId) || input.installationId < 1 || !input.permissions ||
    ids && (ids.length !== input.repositories.length || input.repositoryIds!.some(id => !/^[1-9][0-9]{0,15}$/.test(id)) || ids.some(id => !Number.isSafeInteger(id) || id < 1)))
    throw new HttpError(422, "invalid_input", "An exact repository and permission scope is required.");
  const body = z.object({ token: z.string().min(1).max(4096), expires_at: z.string(), permissions: z.record(z.string(), z.string()) }).safeParse(
    await githubJson(fetchImpl, `${config.apiBaseUrl}/app/installations/${input.installationId}/access_tokens`, {
      method: "POST", headers: githubHeaders(createGithubAppJwt(config, input.nowMs)),
      body: JSON.stringify({ ...(ids ? { repository_ids: ids } : { repositories: names.data }), permissions: input.permissions }),
    }),
  );
  if (!body.success) throw new HttpError(503, "github_unavailable", "GitHub returned an incomplete credential.");
  const expiresAtMs = Date.parse(body.data.expires_at);
  // Never release a broader token even if the provider's response is malformed.
  if (!Number.isFinite(expiresAtMs) || expiresAtMs - input.nowMs < 5 * 60_000 || expiresAtMs - input.nowMs > 70 * 60_000 ||
    Object.entries(body.data.permissions).some(([key, value]) => value !== input.permissions[key as keyof GithubRepositoryPermissions]) ||
    Object.entries(input.permissions).some(([key, value]) => value !== body.data.permissions[key])) {
    await revokeGithubInstallationToken(fetchImpl, config, body.data.token).catch(() => {});
    throw new HttpError(503, "github_unavailable", "GitHub returned an unexpected credential scope.");
  }
  return { token: body.data.token, expiresAtMs };
}

import { z } from "zod";
import { boundedJson } from "./http.js";
import type { CredentialRenewer } from "../cloud-workspaces/codex-auth-keeper.js";
import {
  denied,
  parse,
  reconnect,
  type GithubMaterial,
  type GrantScope,
} from "./types.js";
export type GithubConfig = {
  appId: string;
  clientId: string;
  clientSecret: string;
};
const API = "https://api.github.com";
/** Provider error bodies never escape. All targets are fixed or path-encoded. */
async function json(response: Response): Promise<unknown> {
  try {
    return await boundedJson(response, 1048576);
  } catch {
    reconnect();
  }
}
export function githubPorts(
  config: GithubConfig,
  fetchImpl: typeof fetch = fetch,
) {
  const api = async (path: string, token: string) =>
    json(
      await fetchImpl(`${API}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      }),
    );
  const assertApp = (m: GithubMaterial) => {
    if (m.appId !== config.appId || m.clientId !== config.clientId) denied();
  };
  const identity = async (m: GithubMaterial) => {
    assertApp(m);
    const checked = parse(
      z.object({
        app: z.object({ client_id: z.string() }),
        user: z.object({ id: z.number().int().positive().safe() }),
      }),
      await json(
        await fetchImpl(
          `${API}/applications/${encodeURIComponent(config.clientId)}/token`,
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            headers: {
              accept: "application/vnd.github+json",
              "content-type": "application/json",
              "x-github-api-version": "2022-11-28",
              authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
            },
            body: JSON.stringify({ access_token: m.accessToken }),
          },
        ),
      ),
    );
    if (
      checked.app.client_id !== config.clientId ||
      String(checked.user.id) !== m.accountId
    )
      denied();
  };
  const renew: CredentialRenewer<GithubMaterial> = async (
    material,
    dispatch,
  ) => {
    assertApp(material);
    if (material.refreshExpiresAt * 1000 <= Date.now()) reconnect();
    await dispatch();
    const result = parse(
      z.object({
        access_token: z.string().min(16),
        refresh_token: z.string().min(16),
        expires_in: z.number().int().positive().max(86400),
        refresh_token_expires_in: z
          .number()
          .int()
          .positive()
          .max(366 * 86400),
      }),
      await json(
        await fetchImpl("https://github.com/login/oauth/access_token", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: "refresh_token",
            refresh_token: material.refreshToken,
          }),
        }),
      ),
    );
    const now = Math.floor(Date.now() / 1000);
    const updated = {
      ...material,
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: now + result.expires_in,
      refreshExpiresAt: now + result.refresh_token_expires_in,
    };
    await identity(updated);
    return updated;
  };
  const access = async (
    material: GithubMaterial,
    scope: Exclude<GrantScope, { action: "agent" }>,
  ) => {
    await identity(material);
    if(scope.action==='github:catalog')return;
    let found = false;
    for (let page = 1; page <= 100; page++) {
      const body = parse(
        z.object({
          installations: z.array(
            z.object({
              id: z.number(),
              app_id: z.number(),
              suspended_at: z.string().nullable(),
            }),
          ),
        }),
        await api(
          `/user/installations?per_page=100&page=${page}`,
          material.accessToken,
        ),
      );
      found = body.installations.some(
        (i) =>
          i.id === scope.installationId &&
          String(i.app_id) === config.appId &&
          i.suspended_at === null,
      );
      if (found || body.installations.length < 100) break;
    }
    if (!found) denied();
    found = false;
    for (let page = 1; page <= 100; page++) {
      const body = parse(
        z.object({
          repositories: z.array(z.object({ full_name: z.string() })),
        }),
        await api(
          `/user/installations/${scope.installationId}/repositories?per_page=100&page=${page}`,
          material.accessToken,
        ),
      );
      found = body.repositories.some(
        (r) => r.full_name.toLowerCase() === scope.repository,
      );
      if (found || body.repositories.length < 100) break;
    }
    if (!found) denied();
    const segments = scope.repository
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const repo = parse(
      z.object({
        full_name: z.string(),
        permissions: z.object({ pull: z.boolean(), push: z.boolean() }),
      }),
      await api(`/repos/${segments}`, material.accessToken),
    );
    if (
      repo.full_name.toLowerCase() !== scope.repository ||
      !repo.permissions.pull ||
      (scope.action === "github:write" && !repo.permissions.push)
    )
      denied();
  };
  return { renew, access, identity };
}

import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import {
  GithubRepositoryAuthority,
  type GithubRepositoryActor,
} from "../github-repository-authority.js";
import { revokeGithubInstallationToken } from "../github-installation-tokens.js";
import type { CloudGithubConnections } from "./github-connections.js";
import type { CloudGithubConnectionScope } from "./github-connections-store.js";
import {
  githubId,
  githubName,
  type CloudGithubRepositoryTarget,
} from "./github-http.js";

const installations = z.object({
  installations: z
    .array(
      z.object({
        id: githubId,
        app_id: githubId,
        account: z.object({ login: githubName }),
        suspended_at: z.string().nullable(),
      }),
    )
    .max(100),
});

const syncAccessRequired = () => new HttpError(403, "github_access_required", "Your GitHub account needs access to this repository.");

/** VM credentials keep the selected human's scope. Computer builds and Mac
 * sync use installation credentials scoped to the exact repository. */
export function createSelectedCloudGithubTokens(
  pool: pg.Pool,
  connections: CloudGithubConnections,
  fetchImpl: typeof fetch = fetch,
) {
  return async (
    scope: CloudGithubConnectionScope,
    target: CloudGithubRepositoryTarget,
    access: "read" | "write" | "user" = "read",
    purpose: "git" | "gh" | "computer" | "sync" = "git",
    beforeRelease: () => Promise<void> = async () => {},
    failedTokenSha256?: string,
    prepared?: Awaited<ReturnType<CloudGithubConnections["access"]>>,
  ) => {
    if (purpose === "sync" && (access !== "read" || !target.repositoryId)) throw syncAccessRequired();
    const grant = prepared ?? await connections.access(scope, failedTokenSha256),
      repository = await grant.api.repository(target);
    if (access === "write" && !repository.canPush)
      throw new HttpError(
        403,
        "github_cloud_write_denied",
        "Your GitHub account needs write access to this repository.",
      );
    const [owner, name] = repository.repository.split("/") as [string, string];
    await grant.api.http.json(
      `/repositories/${repository.repositoryId}/branches?per_page=1`,
      z.array(z.unknown()).max(1),
    );
    if (purpose === "sync" && (grant.material.method === "pat" || !connections.config)) throw syncAccessRequired();
    if (grant.material.method === "pat" || purpose !== "computer" && purpose !== "sync") {
      await beforeRelease();
      await grant.assertCurrent();
      // This is a broker cache deadline, not a claimed GitHub token lifetime.
      return {
        token: grant.material.accessToken,
        expiresAt: Math.min(
          grant.material.expiresAt ?? Infinity,
          Date.now() + 120_000,
        ),
      };
    }
    const config = connections.config;
    if (!config)
      throw new HttpError(
        503,
        "github_not_configured",
        "GitHub App sign-in is unavailable.",
      );
    const visibleInstallation = async () => {
      const deadline = Date.now() + 30_000;
      for (let page = 1; page <= 10 && Date.now() < deadline; page++) {
        const rows = await grant.api.http.json(
          `/user/installations?per_page=100&page=${page}`,
          installations,
        );
        const installation = rows.installations.find(
          (row) =>
            row.app_id === config.appId &&
            row.account.login.toLowerCase() === owner.toLowerCase() &&
            row.suspended_at === null,
        );
        if (installation) return installation;
        if (rows.installations.length < 100) break;
      }
      throw new HttpError(
        403,
        "github_app_access_required",
        "Grant Zeros access to this repository in GitHub.",
      );
    };
    const installation = await visibleInstallation();
    const actor: GithubRepositoryActor = {
      id: String(installation.id),
      installation: String(installation.id),
      owner,
      login: grant.identity.login,
      user: grant.identity.id,
      generation: grant.generation,
      connection: grant.generation,
      account: grant.generation,
      organization: grant.generation,
      membership: grant.generation,
    };
    const authority = new GithubRepositoryAuthority(
      pool,
      config,
      fetchImpl,
      async () => {
        await grant.assertCurrent();
        // A remotely revoked OAuth grant must not be converted to a fresh App
        // credential just because its durable local row still exists.
        const human = await grant.api.http.json(
          "/user",
          z.object({ id: githubId }),
        );
        if (String(human.id) !== actor.user)
          throw new HttpError(
            403,
            "github_cloud_access_denied",
            "Your GitHub connection changed.",
          );
        const current = await grant.api.repository({
          repository: repository.repository,
          repositoryId: repository.repositoryId,
        });
        if (
          current.repository.toLowerCase() !==
          repository.repository.toLowerCase()
        )
          throw new HttpError(
            409,
            "github_repository_changed",
            "The repository moved while access was being checked. Try again.",
          );
        if ((await visibleInstallation()).id !== installation.id)
          throw new HttpError(
            409,
            "github_authorization_changed",
            "The GitHub installation changed. Try again.",
          );
        return actor;
      },
    );
    const request = {
      ...scope,
      owner,
      repositories: [name],
      repositoryIds: [repository.repositoryId],
      access,
    };
    const minted = purpose === "sync" ? await authority.mintContentsRead(request) : await authority.mint(request);
    try {
      if (purpose === "sync") {
        if (minted.expiresAtMs <= Date.now() || minted.expiresAtMs > Date.now() + 3_600_000)
          throw new HttpError(503, "github_unavailable", "GitHub returned an unexpected credential lifetime.");
        await grant.assertCurrent();
        // The caller's device/session/source snapshot is the final admission;
        // no provider call or credential cleanup may follow it.
        await beforeRelease();
        if (minted.expiresAtMs <= Date.now() || minted.expiresAtMs > Date.now() + 3_600_000)
          throw new HttpError(503, "github_unavailable", "GitHub credential expired while access was being checked.");
        return { token: minted.token, expiresAt: minted.expiresAtMs, repository: repository.repository };
      }
      await beforeRelease();
      await grant.assertCurrent();
      return {
        token: minted.token,
        expiresAt: Math.min(minted.expiresAtMs, Date.now() + 120_000),
      };
    } catch (error) {
      await revokeGithubInstallationToken(
        fetchImpl,
        config,
        minted.token,
      ).catch(() => {});
      throw error;
    }
  };
}

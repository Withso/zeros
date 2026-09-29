import { z } from "zod";
import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import type { GithubBackendConfig } from "../config.js";

const name = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);
const repository = z.object({
  id: z.number().int().positive().safe(),
  name,
  owner: z.object({ login: name }),
  default_branch: z.string().min(1).max(512),
  private: z.boolean(),
  archived: z.boolean(),
  disabled: z.boolean().optional(),
  permissions: z.object({ push: z.boolean().optional() }).optional(),
});
export type CloudGithubRepository = {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
};
export type CloudGithubInstallation = {
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  suspendedAt: string | null;
};
const projection = (
  row: z.infer<typeof repository>,
): CloudGithubRepository => ({
  id: String(row.id),
  owner: row.owner.login,
  name: row.name,
  defaultBranch: row.default_branch,
  private: row.private,
});

/** User-token requests deliberately preserve the intersection of the GitHub
 * App installation and the connecting person's repository permissions. */
export class GithubCloudUserAccess {
  constructor(
    private readonly config: GithubBackendConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private async request(token: string, path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2026-03-10",
          "user-agent": "zeros-control-plane",
        },
      });
    } catch {
      throw new HttpError(
        503,
        "github_unavailable",
        "GitHub could not be reached. Try again.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 || response.status === 403)
        throw new HttpError(
          403,
          "github_cloud_access_denied",
          "GitHub could not verify access. Connect an account you own or an organization you belong to, and allow Members read access for the GitHub App.",
        );
      throw new HttpError(
        response.status === 401 ? 401 : 503,
        "github_unavailable",
        "Reconnect GitHub or try again shortly.",
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new HttpError(
        503,
        "github_unavailable",
        "GitHub returned an incomplete response.",
      );
    let text = "",
      size = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error();
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } catch {
      throw new HttpError(
        503,
        "github_unavailable",
        "GitHub returned an incomplete response.",
      );
    } finally {
      reader.releaseLock();
    }
  }
  async assertAccount(
    token: string,
    login: string,
    installation: CloudGithubInstallation,
  ): Promise<void> {
    if (installation.suspendedAt)
      throw new HttpError(
        403,
        "github_installation_suspended",
        "This GitHub installation is suspended.",
      );
    if (installation.accountType === "User") {
      if (installation.accountLogin.toLowerCase() !== login.toLowerCase())
        throw new HttpError(
          403,
          "github_cloud_account_not_owned",
          "Connect your own GitHub account or an organization you belong to.",
        );
      return;
    }
    const result = z
      .object({
        state: z.literal("active"),
        organization: z.object({ login: name }),
      })
      .safeParse(
        await this.request(
          token,
          `/user/memberships/orgs/${encodeURIComponent(installation.accountLogin)}`,
        ),
      );
    if (
      !result.success ||
      result.data.organization.login.toLowerCase() !==
        installation.accountLogin.toLowerCase()
    )
      throw new HttpError(
        403,
        "github_cloud_membership_required",
        "You must be an active member of this GitHub organization to connect it.",
      );
  }
  async repositories(
    token: string,
    installation: CloudGithubInstallation,
    page: number,
  ) {
    const result = z
      .object({ repositories: z.array(repository).max(100) })
      .safeParse(
        await this.request(
          token,
          `/user/installations/${installation.installationId}/repositories?per_page=100&page=${page}`,
        ),
      );
    if (!result.success)
      throw new HttpError(
        503,
        "github_unavailable",
        "GitHub returned an incomplete repository list.",
      );
    return {
      repositories: result.data.repositories
        .filter(
          (row) =>
            !row.archived &&
            !row.disabled &&
            row.owner.login.toLowerCase() ===
              installation.accountLogin.toLowerCase(),
        )
        .map(projection),
      nextPage:
        result.data.repositories.length === 100 && page < 100 ? page + 1 : null,
    };
  }
  async source(
    token: string,
    installation: CloudGithubInstallation,
    owner: string,
    repo: string,
    requireWrite = false,
  ): Promise<CloudGithubRepository> {
    if (owner.toLowerCase() !== installation.accountLogin.toLowerCase())
      throw new HttpError(
        403,
        "github_cloud_access_denied",
        "Select a repository from the connected GitHub account.",
      );
    const result = repository.safeParse(
      await this.request(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      ),
    );
    if (
      !result.success ||
      result.data.archived ||
      result.data.disabled ||
      result.data.owner.login.toLowerCase() !== owner.toLowerCase() ||
      result.data.name.toLowerCase() !== repo.toLowerCase()
    )
      throw new HttpError(
        403,
        "github_cloud_access_denied",
        "This repository is unavailable. Refresh your repository list.",
      );
    if (requireWrite && result.data.permissions?.push !== true)
      throw new HttpError(403, "github_cloud_write_denied", "Your GitHub account needs write access to this repository.");
    return projection(result.data);
  }
}

export async function assertCloudGithubSource(
  tx: Tx,
  input: {
    organizationId: string;
    actorUserId: string;
    installationRecordId: string;
    repositoryOwner: string;
    repositoryName: string;
    forgeRepositoryId?: string;
  },
) {
  const access = await tx.query(
    `SELECT 1 FROM cloud_github_source_access source
    WHERE source.org_id=$1 AND source.owner_user_id=$2 AND source.installation_id=$3
      AND source.repository_owner=lower($4) AND source.repository_name=lower($5) AND source.expires_at>clock_timestamp()
      AND source.actor_fingerprint=cloud_github_actor_fingerprint($1,$2)
      AND ($6::text IS NULL OR source.forge_repository_id=$6)`,
    [
      input.organizationId,
      input.actorUserId,
      input.installationRecordId,
      input.repositoryOwner,
      input.repositoryName,
      input.forgeRepositoryId ?? null,
    ],
  );
  if (!access.rowCount)
    throw new HttpError(
      409,
      "github_cloud_source_authorization_required",
      "Refresh your GitHub repository access before creating this cloud workspace.",
    );
}

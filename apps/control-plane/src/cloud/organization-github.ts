// Organization GitHub connections: a shared ready copy clones with a GitHub App
// installation token for exactly one repository, minted with the App's own key
// and never through an admin's personal sign-in. GitHub's answers set the
// connection's edge state, which settings and Create show with one fix each.
import { z } from "zod";
import type { GithubBackendConfig } from "../config.js";
import { HttpError } from "../authz.js";
import { createGithubAppJwt } from "../github-app-jwt.js";
import { githubHeaders, mintGithubInstallationToken } from "../github-installation-tokens.js";
import type { CloudSourceTarget } from "./source-authority.js";
import type { CloudRepositoryLevels } from "./repository-levels.js";
import { organizationConnectionRequired } from "./repository-levels.js";

/** Edge states, reusing the connection reasons the desktop already knows
 * (github-connection-contract.ts): installation-required (uninstalled),
 * installation-suspended, access-denied (the repository left the
 * installation's selection). No new reason is added. */
export const installationUninstalled = () =>
  new HttpError(409, "github_installation_required", "The Zeros GitHub App is no longer installed for this account. Install it again in GitHub.");
export const installationSuspended = () =>
  new HttpError(409, "github_installation_suspended", "The Zeros GitHub App is suspended for this account. Unsuspend it in GitHub.");
export const repositoryNotSelected = (repository: string) =>
  new HttpError(403, "github_app_access_required", `The Zeros GitHub App can't read ${repository}. Add it to the App's repositories in GitHub.`);

const Installation = z.object({ id: z.number().int().positive(), account: z.object({ login: z.string().max(100) }), suspended_at: z.string().nullable().optional() }).passthrough();

/** The installation GitHub reports for one repository, by the App's own key. */
export async function repositoryInstallation(fetchImpl: typeof fetch, config: GithubBackendConfig, repository: string, nowMs = Date.now()):
  Promise<{ installationId: number; accountLogin: string; suspended: boolean } | null> {
  const [owner, name] = repository.split("/");
  const response = await fetchImpl(`${config.apiBaseUrl}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/installation`, {
    headers: githubHeaders(createGithubAppJwt(config, nowMs)), redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(503, "github_unavailable", "GitHub could not be reached."); }
  const parsed = Installation.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new HttpError(503, "github_unavailable", "GitHub returned an incomplete response.");
  return { installationId: parsed.data.id, accountLogin: parsed.data.account.login, suspended: !!parsed.data.suspended_at };
}

export function organizationCloneToken(deps: { levels: Pick<CloudRepositoryLevels, "organizationInstallation" | "bindInstallation" | "installationState">;
  config: GithubBackendConfig | null; fetch?: typeof fetch; now?: () => number }) {
  const fetchImpl = deps.fetch ?? fetch, now = () => deps.now?.() ?? Date.now();
  return async (organizationId: string, target: CloudSourceTarget): Promise<string> => {
    const [owner, name] = target.repository.split("/") as [string, string];
    const connection = await deps.levels.organizationInstallation(organizationId, target.repository);
    if (!connection) throw organizationConnectionRequired(owner);
    if (!deps.config) throw new HttpError(503, "github_not_configured", "GitHub App sign-in is unavailable.");
    // A recorded edge state is what settings show; GitHub is asked every time, so a fix takes effect at once.
    let installationId = connection.installationId;
    // A migrated connection learns its installation from GitHub, for its own account only.
    const reported = await repositoryInstallation(fetchImpl, deps.config, target.repository, now());
    if (!reported) {
      if (installationId) await deps.levels.installationState(installationId, "uninstalled");
      throw installationId ? installationUninstalled() : organizationConnectionRequired(owner);
    }
    if (reported.accountLogin.toLowerCase() !== connection.accountLogin.toLowerCase()) throw organizationConnectionRequired(owner);
    if (installationId === null) { await deps.levels.bindInstallation(organizationId, connection.accountLogin, reported.installationId); installationId = reported.installationId; }
    else if (reported.installationId !== installationId) throw organizationConnectionRequired(owner);
    if (reported.suspended) { await deps.levels.installationState(installationId, "suspended"); throw installationSuspended(); }
    if (connection.state !== "active") await deps.levels.installationState(installationId, "active");
    try {
      return (await mintGithubInstallationToken(fetchImpl, deps.config, { installationId, repositories: [name], repositoryIds: [target.repositoryId],
        permissions: { metadata: "read", contents: "read" }, nowMs: now() })).token;
    } catch (error) {
      // GitHub refuses a token for a repository outside the installation's selection.
      if (error instanceof HttpError && error.status === 403) throw repositoryNotSelected(target.repository);
      throw error;
    }
  };
}

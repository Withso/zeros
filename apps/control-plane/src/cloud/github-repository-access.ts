/** The caller's own access to a repository, from GitHub's user-token `permissions`.
 * Display only: GitHub still decides at push and pull-request time. */
export type GithubRepositoryAccess = "write" | "read" | "unavailable";

export function githubRepositoryAccess(permissions: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean } | undefined): GithubRepositoryAccess {
  if (!permissions) return "unavailable";
  if (permissions.admin || permissions.maintain || permissions.push) return "write";
  return permissions.pull ? "read" : "unavailable";
}

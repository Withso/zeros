import type {
  GithubAuthMethod,
  GithubAuthSnapshot,
  GithubCredentialSummary,
} from "@zeros/core/github-auth";

export function githubMethodLabel(method: GithubAuthMethod): string {
  if (method === "gh-cli") return "gh CLI auth";
  if (method === "github-app") return "GitHub App";
  return "Personal Access Token";
}

export function githubMethodDescription(method: GithubAuthMethod): string {
  if (method === "gh-cli") {
    return "Use the account already signed in with GitHub CLI.";
  }
  if (method === "github-app") {
    return "Authorize in your browser and choose repository access.";
  }
  return "Use a token you create and control on GitHub.";
}

export function githubMethodStatusCopy(
  summary: GithubCredentialSummary,
): string {
  if (summary.method === "gh-cli") {
    return "GitHub CLI is authenticated and ready.";
  }
  if (summary.method === "github-app") {
    if (summary.allRepositories) return "All repositories accessible.";
    if (summary.repositoryCount !== undefined) {
      return `${summary.repositoryCount} ${
        summary.repositoryCount === 1 ? "repository" : "repositories"
      } accessible.`;
    }
    return "Repository access is managed by GitHub App.";
  }
  return "Validated for API and Git operations.";
}

export function githubHealthNeedsAttention(
  summary: GithubCredentialSummary,
): boolean {
  return (
    summary.health !== "connected" &&
    summary.health !== "not-connected" &&
    summary.health !== "unavailable"
  );
}

export function shouldShowGithubTopRefresh(
  summary: GithubCredentialSummary,
  selected: boolean,
): boolean {
  return (
    summary.health === "unavailable" ||
    (summary.configured && (!selected || summary.health !== "connected"))
  );
}

/** Keep the product-default gh row selected on a cold mount without briefly
 * claiming that sign-in is required. Setup opens only after a real host
 * snapshot confirms the selected CLI source is disconnected. */
export function githubAutomaticSetup(
  snapshot: GithubAuthSnapshot,
  hasConfirmedSnapshot: boolean,
): GithubAuthMethod | null {
  const cli = snapshot.methods["gh-cli"];
  return hasConfirmedSnapshot &&
    snapshot.selectedMethod === "gh-cli" &&
    cli.health === "not-connected" &&
    !cli.configured
    ? "gh-cli"
    : null;
}

/** A failed user-triggered Refresh is durable row health, not a toast. Keep
 * every last-confirmed identity/access field and mark only the requested
 * method unavailable so the row never lies that its probe just succeeded. */
export function githubRefreshFailureSnapshot(
  snapshot: GithubAuthSnapshot,
  method: GithubAuthMethod,
): GithubAuthSnapshot {
  return {
    ...snapshot,
    methods: {
      ...snapshot.methods,
      [method]: {
        ...snapshot.methods[method],
        health: "unavailable",
        detail: "Couldn’t check this connection. You may be offline.",
      },
    },
  };
}

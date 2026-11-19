import type {
  GithubAuthMethod,
  GithubAuthSnapshot,
  GithubCredentialSummary,
} from "@zeros/protocol/github-auth";

export function githubMethodLabel(method: GithubAuthMethod): string {
  if (method === "gh-cli") return "gh CLI auth";
  if (method === "github-app") return "GitHub App";
  return "Personal Access Token";
}

export function githubMethodDescription(method: GithubAuthMethod): string {
  if (method === "gh-cli") {
    return "Uses your gh CLI sign-in.";
  }
  if (method === "github-app") {
    return "Authorize in your browser.";
  }
  return "A token you create on GitHub.";
}

// Only a complete, empty inventory may force reinstall; an unknown count on an existing setup uses direct OAuth.
export function githubAppConnectOptions(
  summary: GithubCredentialSummary,
  forceInstallRequested = false,
): { installFlow: boolean; forceInstall: boolean } {
  const confirmedEmpty = summary.configured && summary.installationCount === 0;
  return {
    installFlow: forceInstallRequested || !summary.configured || confirmedEmpty,
    forceInstall: forceInstallRequested || confirmedEmpty,
  };
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

export function githubHealthDetailCopy(
  summary: GithubCredentialSummary,
): string | null {
  if (summary.health === "connected") return null;
  if (summary.health === "rate-limited")
    return "GitHub is rate-limiting requests. This connection has not been removed.";
  if (summary.health === "sso-required")
    return "Your organization requires SAML authorization for this connection.";
  // Settings has no repository context, so this is a connection-wide diagnosis.
  if (summary.health === "not-installed")
    return summary.detail || "The GitHub App isn’t installed on any account yet.";
  if (summary.health === "suspended")
    return summary.detail || "This installation was suspended by the account owner.";
  if (summary.health === "invalid")
    return "GitHub revoked this connection. Reconnect to continue.";
  return summary.detail || "Couldn’t check this connection. You may be offline.";
}

export function githubConnectionAttentionCopy(
  summary: GithubCredentialSummary | undefined,
): string | undefined {
  if (!summary || summary.health === "connected") return undefined;
  if (!summary.configured && summary.health === "not-connected") return undefined;
  return githubHealthDetailCopy(summary) ?? undefined;
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

// Only offer cold-mount setup once the host confirms the selected CLI is disconnected.
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

// Show a failed explicit refresh as lasting row health rather than a transient toast.
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

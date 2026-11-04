import { CloudGithubUnavailableReasonSchema, type CloudGithubUnavailableReason } from "@zeros/protocol/cloud-github-connection";

export const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
export const GITHUB_HTTP_TIMEOUT_MS = 15_000;
export const GITHUB_SOCKET_TIMEOUT_MS = GITHUB_REQUEST_TIMEOUT_MS + 1000;

const messages: Record<CloudGithubUnavailableReason, string> = {
  "connection-required": "Reconnect GitHub in Zeros: connect an account for this organization.",
  "connection-expired": "Reconnect GitHub in Zeros: your connection has expired.",
  "connection-changed": "Reconnect GitHub in Zeros: your selected connection changed.",
  "installation-required": "Grant the Zeros GitHub App access to this repository, then try again.",
  "installation-suspended": "Restore the Zeros GitHub App installation in GitHub, then try again.",
  "access-denied": "Your GitHub account cannot access this repository. Check your repository permissions in GitHub.",
  "sso-required": "Authorize your GitHub connection for your organization's SSO, then try again.",
  "source-review-required": "Ask an organization admin to review this workspace's GitHub repositories in Zeros.",
  "rate-limited": "GitHub is rate limiting requests. Try again shortly.",
  unavailable: "GitHub authentication is unavailable. Try again shortly.",
};

export class GithubAuthenticationError extends Error {
  constructor(readonly reason: CloudGithubUnavailableReason) { super(messages[reason]); }
}

export function githubAuthenticationError(reason: unknown = "unavailable"): GithubAuthenticationError {
  const parsed = CloudGithubUnavailableReasonSchema.safeParse(reason);
  return new GithubAuthenticationError(parsed.success ? parsed.data : "unavailable");
}

export function githubAuthenticationMessage(error: unknown): string {
  return error instanceof GithubAuthenticationError ? messages[error.reason] : messages.unavailable;
}

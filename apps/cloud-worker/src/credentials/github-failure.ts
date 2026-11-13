// Type-only: the Git credential and askpass helpers bundle this module, and
// Git starts one helper process per request, so it must not load zod.
import type { CloudGithubUnavailableReason } from "@zeros/protocol/cloud-github-connection";

export const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
export const GITHUB_HTTP_TIMEOUT_MS = 15_000;
export const GITHUB_SOCKET_TIMEOUT_MS = GITHUB_REQUEST_TIMEOUT_MS + 1000;

const messages: Record<CloudGithubUnavailableReason, string> = {
  "connection-required": "Reconnect GitHub in Zeros: connect an account for this organization.",
  "connection-expired": "Reconnect GitHub in Zeros: your connection has expired.",
  "connection-changed": "Reconnect GitHub in Zeros: your selected connection changed.",
  "installation-required": "Grant the Zeros GitHub App access to this repository, then try again.",
  "installation-suspended": "Restore the Zeros GitHub App installation in GitHub, then try again.",
  // §16: a member without GitHub access still works in the workspace; only operations that talk to GitHub as them fail.
  "access-denied": "Your GitHub account cannot access this repository, so pushing, fetching and pull requests need someone with access. Everything else in this workspace keeps working.",
  "sso-required": "Authorize your GitHub connection for your organization's SSO, then try again.",
  "source-review-required": "Ask an organization admin to review this workspace's GitHub repositories in Zeros.",
  "rate-limited": "GitHub is rate limiting requests. Try again shortly.",
  unavailable: "GitHub authentication is unavailable. Try again shortly.",
};

// `messages` is typed by the protocol enum, so its keys are exactly the reasons.
function isReason(value: unknown): value is CloudGithubUnavailableReason {
  return typeof value === "string" && Object.hasOwn(messages, value);
}

export class GithubAuthenticationError extends Error {
  constructor(readonly reason: CloudGithubUnavailableReason) { super(messages[reason]); }
}

export function githubAuthenticationError(reason: unknown = "unavailable"): GithubAuthenticationError {
  return new GithubAuthenticationError(isReason(reason) ? reason : "unavailable");
}

/** Which of our own fixed refusal messages the credential helper printed (Git passes the helper's stderr through). */
export function githubFailureReasonIn(stderr: string): CloudGithubUnavailableReason | undefined {
  const lines = new Set(stderr.split(/\r?\n/).map(line => line.trim()));
  return (Object.keys(messages) as CloudGithubUnavailableReason[]).find(reason => lines.has(messages[reason]));
}

export function githubAuthenticationMessage(error: unknown): string {
  return error instanceof GithubAuthenticationError ? messages[error.reason] : messages.unavailable;
}

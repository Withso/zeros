import type { CloudGithubConnectionStatus } from "@zeros/protocol/cloud-github-connection";

export const cloudGithubHealthCopy: Record<
  CloudGithubConnectionStatus["methods"]["pat"]["health"],
  string
> = {
  connected: "Connected",
  "not-connected":
    "Connect GitHub in this organization’s cloud settings to choose a repository.",
  expired: "This authorization expired. Reconnect to continue.",
  invalid: "GitHub rejected this connection. Reconnect to continue.",
  "not-installed": "Grant Zeros access in GitHub to choose repositories.",
  "sso-required": "Authorize this connection for your organization in GitHub.",
  "rate-limited": "GitHub’s rate limit was reached. Try again shortly.",
  unavailable: "GitHub could not be checked. Refresh to try again.",
};

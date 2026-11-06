/** Advertised on hello and on the relay's inbound dial. The control plane gates
 * each configuration on the list it saw, so the two must be identical. */
export const CLOUD_WORKER_FEATURES = ["prompt-outbox-v1", "mcp-v1", "workspace-setup-v1", "checkout-v2", "agent-interactions-v1", "github-pr-v1",
  "git-identity-v1", "github-user-token-v1", "code-review-v1", "history-replace-v1", "workspace-environment-v1", "repository-setup-v1",
  "runtime-update-v1"].join(",");

import { ACTING_USER_FEATURE, BOOT_TIMINGS_FEATURE, CLOUD_RECOVERY_QUIESCE_FEATURE, HISTORY_DIGEST_DELETIONS_FEATURE, HISTORY_DIGEST_FEATURE, CREATOR_AGENT_LOGINS_FEATURE, CREATOR_AGENT_MODELS_FEATURE, CREATOR_COMMIT_IDENTITY_FEATURE, PUSH_SIGNALS_FEATURE } from "@zeros/protocol/cloud-v2-relay";

/** Advertised on hello and on the relay's inbound dial. The control plane gates
 * each configuration on the list it saw, so the two must be identical. */
export const CLOUD_WORKER_FEATURES = ["prompt-outbox-v1", "mcp-v1", "workspace-setup-v1", "checkout-v2", "agent-interactions-v1", "github-pr-v1",
  "git-identity-v1", "github-user-token-v1", "code-review-v1", "history-replace-v1", "workspace-environment-v1", "repository-setup-v1",
  "runtime-update-v1", "worker-push-v1", "workspace-api-v1", "session-name-v1", "chat-edit-v1", "local-commands-v1", "setup-status-v1", "notify-user-v1", "sync-v1", "local-commands-reason-v1",
  /** Team sharing slice B: runs each turn, terminal, client mutation and setup as its leased person, after a clean-boot attestation. */
  ACTING_USER_FEATURE,
  /** Team sharing 3A: an activated workspace's direct sync socket carries and renews its person's client handle. */
  "sync-context-v1",
  /** Creator pays: parses an activated config's agentLogins (the current Creator's agents; presentation only). */
  CREATOR_AGENT_LOGINS_FEATURE,
  /** Activated: serves agentModels (the current Creator's model ids) as every member's picker list. */
  CREATOR_AGENT_MODELS_FEATURE,
  /** Activated: commits are authored as the current Creator; open contexts follow a Creator change. */
  CREATOR_COMMIT_IDENTITY_FEATURE,
  /** R1: long-polls 60 s, reports on change + 5 min, pulses every 5 min and checks runtime updates on a hint, once accepted. */
  PUSH_SIGNALS_FEATURE,
  /** Fences, flushes and seals over the outbound path for a fresh-checkpoint replacement; holds a replacement's turns until its setup succeeds. */
  CLOUD_RECOVERY_QUIESCE_FEATURE,
  /** A reconnect reads each chat's stored digest once and re-sends only changed chats (with config.historyDigest). */
  HISTORY_DIGEST_FEATURE,
  HISTORY_DIGEST_DELETIONS_FEATURE,
  /** Reports listening, hello sent and acknowledged, and the first accepted relay as timing marks (with config.bootTimings). */
  BOOT_TIMINGS_FEATURE].join(",");

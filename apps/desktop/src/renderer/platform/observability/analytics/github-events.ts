// Metadata-only GitHub authentication funnel.
//
// Keep this vocabulary fixed: never pass usernames, repository names, branch
// names, URLs, token fragments, or raw error messages to analytics.

import type {
  GithubAuthMethod,
  GithubCredentialHealth,
} from "@zeros/protocol/github-auth";
import { capture } from "./posthog";

type GithubConnectEntryPoint = "settings" | "pr_composer" | "cloud_create";
type GithubConnectOutcome = "ok" | "error" | "cancelled";
type GithubInstallKind = "new" | "reconfigure";
const GITHUB_CONNECT_ERROR_KINDS = [
  "unknown",
  "NOT_AUTHENTICATED",
  "NETWORK_ERROR",
  "VALIDATION_FAILED",
  "GITHUB_API_ERROR",
  "GITHUB_RATE_LIMITED",
  "GITHUB_SSO_REQUIRED",
  "GITHUB_FORBIDDEN_SCOPE",
  "GITHUB_REPO_NOT_INSTALLED",
  "GITHUB_INSTALLATION_SUSPENDED",
  "access_denied",
  "authorization_expired",
  "github_unavailable",
  "handoff_expired",
  "invalid_callback",
  "nonce_mismatch",
  "not_configured",
  "oauth_failed",
  "signed_out",
  "storage_failed",
] as const;
type GithubConnectErrorKind = (typeof GITHUB_CONNECT_ERROR_KINDS)[number];
const GITHUB_CONNECT_ERROR_KIND_SET = new Set<string>(
  GITHUB_CONNECT_ERROR_KINDS,
);

const connectStartedAt = new Map<GithubAuthMethod, number>();

export function trackGithubMethodSelected(args: {
  method: GithubAuthMethod;
  previousMethod: GithubAuthMethod;
  hadOtherCredential: boolean;
}): void {
  capture("github_method_selected", {
    method: args.method,
    previous_method: args.previousMethod,
    had_other_credential: args.hadOtherCredential,
  });
}

export function trackGithubConnectStarted(args: {
  method: GithubAuthMethod;
  entryPoint: GithubConnectEntryPoint;
}): void {
  connectStartedAt.set(args.method, performance.now());
  capture("github_connect_started", {
    method: args.method,
    entry_point: args.entryPoint,
  });
}

export function trackGithubConnectCompleted(args: {
  method: GithubAuthMethod;
  outcome: GithubConnectOutcome;
  errorKind?: GithubConnectErrorKind;
}): void {
  const startedAt = connectStartedAt.get(args.method);
  connectStartedAt.delete(args.method);
  capture("github_connect_completed", {
    method: args.method,
    outcome: args.outcome,
    error_kind: args.errorKind,
    duration_ms:
      startedAt === undefined
        ? undefined
        : Math.max(0, Math.round(performance.now() - startedAt)),
  });
}

/** Reduce an IPC/main error to the fixed GitHub auth vocabulary. */
export function githubConnectErrorKind(error: unknown): GithubConnectErrorKind {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  return GITHUB_CONNECT_ERROR_KIND_SET.has(code)
    ? (code as GithubConnectErrorKind)
    : "unknown";
}

export function trackGithubInstallOpened(args: {
  variantKey: "github.com";
  kind: GithubInstallKind;
}): void {
  capture("github_install_opened", {
    variant_key: args.variantKey,
    kind: args.kind,
  });
}

export function trackGithubHealthRefreshed(args: {
  method: GithubAuthMethod;
  state: GithubCredentialHealth;
  installationCount?: number;
  repositoryCountKnown: boolean;
}): void {
  capture("github_health_refreshed", {
    method: args.method,
    state: args.state,
    installation_count: args.installationCount,
    repository_count_known: args.repositoryCountKnown,
  });
}

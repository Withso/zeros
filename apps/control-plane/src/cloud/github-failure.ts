import { HttpError } from "../authz.js";
import type { CloudGithubUnavailableReason } from "./github-connection-contract.js";

const reasons: Record<string, CloudGithubUnavailableReason> = {
  github_connection_required: "connection-required",
  github_authorization_required: "connection-required",
  github_authorization_expired: "connection-expired",
  github_refresh_uncertain: "connection-expired",
  github_authorization_changed: "connection-changed",
  github_installation_required: "installation-required",
  github_app_access_required: "installation-required",
  github_installation_suspended: "installation-suspended",
  github_cloud_access_denied: "access-denied",
  github_cloud_write_denied: "access-denied",
  github_repository_unavailable: "access-denied",
  github_sso_required: "sso-required",
  cloud_source_review_required: "source-review-required",
  github_rate_limited: "rate-limited",
  github_unavailable: "unavailable",
  github_refresh_pending: "unavailable",
  github_verification_busy: "unavailable",
  github_verification_expired: "unavailable",
  github_verification_failed: "unavailable",
  github_not_configured: "unavailable",
};

export function cloudGithubFailure(error: unknown): { reason: CloudGithubUnavailableReason; cause: string; kind: "http" | "unexpected" } {
  if (error instanceof HttpError && Object.hasOwn(reasons, error.code))
    return { reason: reasons[error.code]!, cause: error.code, kind: "http" };
  return { reason: "unavailable", cause: "unexpected", kind: "unexpected" };
}

export const cloudGithubUnavailableReason = (error: unknown): CloudGithubUnavailableReason => cloudGithubFailure(error).reason;

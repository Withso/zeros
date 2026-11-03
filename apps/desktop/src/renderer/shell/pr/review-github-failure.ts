// The Review tab's sentence for a pull request read the GitHub connection
// refused. Settings already knows why, so the banner repeats that diagnosis
// and offers Settings instead of a generic load failure.

import { useMemo } from "react";
import type { GithubCredentialSummary } from "@zeros/protocol/github-auth";

import { ghAuthSnapshot } from "../../platform/git";
import {
  isCloudWorkspace,
  parseCloudScopedId,
} from "../../platform/bridge/cloud-workspace-key";
import { githubConnectionAttentionCopy } from "../../features/settings/github-connection-model";
import { useOpenGithubSettings } from "../../features/settings/use-open-github-settings";
import {
  GITHUB_READ_MAX_AGE_MS,
  ghAuthStatusCache,
} from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";
import { WorkbenchConditionError } from "../workbench/tab-status-model";
import { needsGithubSettings } from "./pr-github-access";

/** GitHub connection outcomes the Review names. Anything else stays a generic
 *  load failure with its text in the banner's diagnostic. */
export function reviewGithubFailureCode(error: unknown): string | null {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code !== "string") return null;
  return needsGithubSettings(code) ||
    code === "GITHUB_RATE_LIMITED" ||
    code === "NETWORK_ERROR"
    ? code
    : null;
}

export function describeReviewGithubFailure(input: {
  code: string;
  cloud: boolean;
  /** The selected Local method's Settings summary, when it has been read. */
  connection?: GithubCredentialSummary;
}): string {
  const { code, cloud, connection } = input;
  const subject = cloud ? "Your cloud GitHub connection" : "Your GitHub connection";
  switch (code) {
    case "NOT_AUTHENTICATED":
      if (cloud) return "Reconnect your cloud GitHub connection to load this pull request.";
      // The engine sees no usable token whether nothing was ever connected or
      // a connected App needs re-authorization. Only Settings can tell, so
      // never claim "not connected" until it has.
      if (!connection) return "GitHub didn't accept this connection.";
      if (connection.health === "connected") return "GitHub refused this connection.";
      return githubConnectionAttentionCopy(connection) ?? "Connect GitHub to load this pull request.";
    case "GITHUB_REPO_NOT_INSTALLED":
      return `${subject} can't reach this repository.`;
    case "GITHUB_FORBIDDEN_SCOPE":
      return `${subject} can't read this pull request.`;
    case "GITHUB_SSO_REQUIRED":
      return "This organization requires SAML authorization for your GitHub connection.";
    case "GITHUB_INSTALLATION_SUSPENDED":
      return "This GitHub App installation is suspended. Ask the account owner to restore it.";
    case "GITHUB_RATE_LIMITED":
      return "GitHub is rate-limiting requests. Retry in a moment.";
    default:
      return "Zeros couldn't reach GitHub. Check your network, then retry.";
  }
}

function isCloudReviewWorkspace(workspaceId: string | null | undefined): boolean {
  try {
    return isCloudWorkspace(workspaceId) || parseCloudScopedId(workspaceId) !== null;
  } catch {
    // An unparseable cloud identity is not a Local workspace either.
    return true;
  }
}

/** How long a refused action waits for Settings before keeping its own copy.
 *  The probe keeps running and still warms Settings. */
export const LOCAL_GITHUB_DIAGNOSIS_WAIT_MS = 2_500;

/** Settings' diagnosis of the selected Local connection when it is configured
 *  but unusable; undefined for cloud, healthy, unset, unreadable or slow. */
export async function localGithubDiagnosis(
  workspaceId: string | null | undefined,
): Promise<string | undefined> {
  if (isCloudReviewWorkspace(workspaceId)) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      ghAuthStatusCache.load("auth", () => ghAuthSnapshot(), {
        maxAgeMs: GITHUB_READ_MAX_AGE_MS,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), LOCAL_GITHUB_DIAGNOSIS_WAIT_MS);
      }),
    ]);
    return snapshot
      ? githubConnectionAttentionCopy(snapshot.methods[snapshot.selectedMethod])
      : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Replace a refused GitHub read with the condition to fix. Local sign-in
 *  refusals read the selected method's Settings summary, only while the tab is
 *  visible; cloud placements never consult the Mac's GitHub methods. Fixes
 *  that live in Settings offer it instead of Retry. */
export function useReviewGithubFailure(
  error: unknown,
  options: { workspaceId: string | null | undefined; active: boolean },
): unknown {
  const code = reviewGithubFailureCode(error);
  const cloud = isCloudReviewWorkspace(options.workspaceId);
  const probe = code === "NOT_AUTHENTICATED" && !cloud && options.active;
  const auth = useCachedRead(
    ghAuthStatusCache,
    probe ? "auth" : null,
    () => ghAuthSnapshot(),
    { maxAgeMs: GITHUB_READ_MAX_AGE_MS },
  );
  const connection = auth.data?.methods[auth.data.selectedMethod];
  const openGithubSettings = useOpenGithubSettings();
  return useMemo(
    () =>
      code
        ? new WorkbenchConditionError(
            describeReviewGithubFailure({ code, cloud, connection }),
            {
              cause: error,
              ...(needsGithubSettings(code)
                ? { command: { label: "Open GitHub settings", run: openGithubSettings } }
                : {}),
            },
          )
        : error,
    [code, cloud, connection, error, openGithubSettings],
  );
}

import { useEffect } from "react";

import {
  ghAppConnect,
  onGithubAppConnected,
  onGithubAppError,
  onGithubCredentialStoreChanged,
  type GithubAppErrorReason,
} from "../git";
import { changeCloudGithubConnection, readCloudGithubConnection } from "../cloud-github-connection";
import { getOrganizationStoreGeneration } from "../../features/team/team-store";
import { toast } from "../../shared/ui/primitives/elements";
import { ghAuthStatusCache } from "../../state/read-caches";
import {
  trackGithubConnectCompleted,
  trackGithubMethodSelected,
} from "../observability/analytics/github-events";

export function githubAppErrorCopy(reason: GithubAppErrorReason): {
  title: string;
  description: string;
} | null {
  if (reason === "access_denied") return null;
  if (reason === "authorization_expired") {
    return {
      title: "GitHub authorization expired",
      description: "Connect the GitHub App again to continue.",
    };
  }
  if (reason === "handoff_expired") {
    return {
      title: "GitHub connection expired",
      description: "Start the connection again from Settings.",
    };
  }
  if (reason === "signed_out") {
    return {
      title: "Sign in to connect GitHub",
      description:
        "Sign in to Zeros, then start the GitHub App connection again.",
    };
  }
  if (reason === "nonce_mismatch" || reason === "invalid_callback") {
    return {
      title: "GitHub callback couldn’t be verified",
      description: "Return to Settings and start the connection again.",
    };
  }
  if (reason === "not_configured") {
    return {
      title: "GitHub App sign-in isn’t available yet",
      description:
        "The deployed Zeros control plane is not configured with a GitHub App. Use gh CLI or a Personal Access Token.",
    };
  }
  if (reason === "github_unavailable") {
    return {
      title: "GitHub is temporarily unavailable",
      description: "Your existing connection was left unchanged. Try again.",
    };
  }
  if (reason === "storage_failed") {
    return {
      title: "GitHub connection couldn’t be saved",
      description: "Check Keychain access, then try again.",
    };
  }
  return {
    title: "GitHub App couldn’t connect",
    description: "Return to Settings and try again.",
  };
}

type AppConnectOptions = NonNullable<Parameters<typeof ghAppConnect>[0]>;

// The native controller owns one browser handoff. Keep its scoped restore with
// the app-wide callback so navigating away from Settings cannot drop it.
let pendingRestore: { target: NonNullable<AppConnectOptions["shared"]>; accountGeneration: number } | null = null;

export async function connectSettingsGithubApp(options: AppConnectOptions, restoreCloudPat: boolean) {
  const restore = options.shared && restoreCloudPat
    ? { target: options.shared, accountGeneration: getOrganizationStoreGeneration() }
    : null;
  pendingRestore = restore;
  try {
    const started = await ghAppConnect(options);
    if (!started && pendingRestore === restore) pendingRestore = null;
    return started;
  } catch (error) {
    if (pendingRestore === restore) pendingRestore = null;
    throw error;
  }
}

export function clearGithubAppRestore() {
  pendingRestore = null;
}

async function restoreCloudPat(login: string) {
  const restore = pendingRestore;
  pendingRestore = null;
  if (!restore || restore.accountGeneration !== getOrganizationStoreGeneration()) return;
  const { userId, organizationId, expected } = restore.target;
  try {
    const current = await readCloudGithubConnection(userId, organizationId);
    if (restore.accountGeneration !== getOrganizationStoreGeneration() || current.selectedMethod !== "github-app") return;
    if (current.generation === expected || current.methods["github-app"].login !== login) {
      throw new Error("The Cloud connection changed. Check its selected method in Settings.");
    }
    await changeCloudGithubConnection(userId, organizationId, current.generation, { action: "select", method: "pat" });
  } catch (error) {
    toast.error("GitHub App connected, but couldn’t restore the Cloud method", {
      description: error instanceof Error ? error.message : "Choose the Cloud method again in Settings.",
    });
  }
}

/** Listen app-wide because the browser callback may arrive after Settings unmounts. */
export function GithubAppNotifications() {
  useEffect(() => {
    let closed = false;
    const disposers: Array<() => void> = [];
    void Promise.all([
      onGithubAppConnected((payload) => {
        void restoreCloudPat(payload.login);
        const previous = ghAuthStatusCache.peekSnapshot("auth").data;
        ghAuthStatusCache.invalidateAll();
        trackGithubConnectCompleted({
          method: "github-app",
          outcome: "ok",
        });
        if (previous && previous.selectedMethod !== "github-app") {
          trackGithubMethodSelected({
            method: "github-app",
            previousMethod: previous.selectedMethod,
            hadOtherCredential: Object.entries(previous.methods).some(
              ([method, summary]) =>
                method !== "github-app" && summary.configured,
            ),
          });
        }
        toast.success("GitHub App connected", {
          description: `Connected as @${payload.login}.`,
        });
      }),
      onGithubAppError(({ reason }) => {
        // Native rejects unrelated callbacks without consuming the current handoff.
        if (reason !== "invalid_callback" && reason !== "nonce_mismatch") clearGithubAppRestore();
        ghAuthStatusCache.invalidateAll();
        trackGithubConnectCompleted({
          method: "github-app",
          outcome: reason === "access_denied" ? "cancelled" : "error",
          errorKind: reason,
        });
        const copy = githubAppErrorCopy(reason);
        if (copy) {
          toast.error(copy.title, { description: copy.description });
        }
      }),
      onGithubCredentialStoreChanged(() => {
        ghAuthStatusCache.invalidateAll();
      }),
    ]).then((next) => {
      if (closed) {
        for (const dispose of next) dispose();
      } else {
        disposers.push(...next);
      }
    });
    return () => {
      closed = true;
      for (const dispose of disposers) dispose();
    };
  }, []);
  return null;
}

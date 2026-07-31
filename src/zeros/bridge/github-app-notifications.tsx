import { useEffect } from "react";

import {
  onGithubAppConnected,
  onGithubAppError,
  onGithubCredentialStoreChanged,
  type GithubAppErrorReason,
} from "../../native/git";
import { toast } from "../ui/primitives/elements";
import { ghAuthStatusCache } from "../store/read-caches";
import {
  trackGithubConnectCompleted,
  trackGithubMethodSelected,
} from "../analytics/github-events";

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

/** App-wide listener: the browser may return while Settings is no longer
 * mounted. All transient feedback still uses the one bottom-right toast rail. */
export function GithubAppNotifications() {
  useEffect(() => {
    let closed = false;
    const disposers: Array<() => void> = [];
    void Promise.all([
      onGithubAppConnected((payload) => {
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

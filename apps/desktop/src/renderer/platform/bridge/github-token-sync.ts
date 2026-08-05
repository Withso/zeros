// Mirror engine-originated credential invalidation into Electron's durable,
// method-addressed store. The wire event carries method + reason only.

import type { RuntimeClient } from "./ws-client";
import { isNativeRuntime, nativeInvoke } from "../runtime";
import { ghAuthStatusCache } from "../../state/read-caches";

export function wireGithubCredentialWriteback(
  bridge: RuntimeClient,
): () => void {
  return bridge.on("GITHUB_CREDENTIAL_CHANGED", (message) => {
    if (!isNativeRuntime()) return;
    const change = message as {
      method: "gh-cli" | "github-app" | "pat";
      reason: "credential-invalid";
    };
    ghAuthStatusCache.invalidateAll();
    void nativeInvoke("gh_credential_clear", {
      method: change.method,
      reason: change.reason,
    })
      .then(() => {
        // The first invalidation can race ahead of main recording the rejected
        // PAT or rotating an App token. Revalidate once that state transition
        // is complete so a recovered PAT is re-seeded and a refreshed App
        // snapshot cannot be overwritten by the pre-transition read.
        ghAuthStatusCache.invalidateAll();
      })
      .catch(() => {
        // Best effort. The engine has already stopped using the invalid working
        // copy, and the next status probe will remain disconnected.
      });
  });
}

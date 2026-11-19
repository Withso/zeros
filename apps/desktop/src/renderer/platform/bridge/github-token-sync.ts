// GitHub credential changes cross the bridge as method and reason only, never token values.

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
        // Revalidate after main records rejection or rotation; the initial read can race that change.
        ghAuthStatusCache.invalidateAll();
      })
      .catch(() => {
        // The engine already dropped the invalid working credential.
      });
  });
}

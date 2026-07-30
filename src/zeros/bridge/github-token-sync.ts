// Mirror engine-originated credential invalidation into Electron's durable,
// method-addressed store. The wire event carries method + reason only.

import type { RuntimeClient } from "./ws-client";
import { isNativeRuntime, nativeInvoke } from "../../native/runtime";
import { ghAuthStatusCache } from "../store/read-caches";

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
    }).catch(() => {
      // Best effort. The engine has already stopped using the invalid working
      // copy, and the next status probe will remain disconnected.
    });
  });
}

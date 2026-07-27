// ──────────────────────────────────────────────────────────
// github-token-sync — courier the GitHub token to the engine (option B)
// ──────────────────────────────────────────────────────────
//
// After the single-writer migration the GitHub PR ops run in the engine (bun),
// which CAN'T read Electron safeStorage where the OAuth token is encrypted.
//
// H4 (was: renderer courier) — the renderer NO LONGER fetches the decrypted
// token. Electron main now couriers it straight to the engine (spawn env +
// stdin control channel), so a renderer XSS can't read it (the old
// gh_token_get IPC command has been removed outright).
// What stays here is the reverse path: mirror an engine-originated invalidation
// (401 auto-clear) back into safeStorage.
//
//   main safeStorage ──(spawn env / stdin)──▶ engine            (token in)
//   engine 401 auto-clear ──(GITHUB_TOKEN_CHANGED)──▶ renderer ──(gh_token_clear)──▶ main
// ──────────────────────────────────────────────────────────

import type { RuntimeClient } from "./ws-client";
import { isNativeRuntime, nativeInvoke } from "../../native/runtime";

/** H4: no-op kept for call-site compatibility. Main couriers the token to the
 *  engine directly now — the renderer must never hold the decrypted token. */
export async function pushGithubTokenToEngine(
  _bridge: RuntimeClient,
): Promise<void> {
  return;
}

/** Mirror an engine-originated token invalidation back into safeStorage so the
 *  durable store stays in sync. Returns an unsubscribe. */
export function wireGithubTokenWriteback(bridge: RuntimeClient): () => void {
  return bridge.on("GITHUB_TOKEN_CHANGED", (msg) => {
    if (!isNativeRuntime()) return;
    const token = (msg as { token?: string | null }).token ?? null;
    if (token == null) {
      void nativeInvoke("gh_token_clear").catch(() => {
        /* best-effort — the next push reconciles */
      });
    }
  });
}

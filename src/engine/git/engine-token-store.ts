// ──────────────────────────────────────────────────────────
// Engine-side GitHub TokenStore — in-memory, bridge-fed (option B)
// ──────────────────────────────────────────────────────────
//
// The bun engine can't call Electron `safeStorage` (where the GitHub OAuth
// token is encrypted at rest), so it can't read the durable token directly.
// Instead the HOST (Electron-main, the safeStorage owner) hands the decrypted
// token to the engine over the loopback bridge as a `GITHUB_TOKEN_SET` control
// message; the engine caches it HERE and reads it for `gh.*` Octokit calls.
//
//   host safeStorage ──(renderer courier, GITHUB_TOKEN_SET)──▶ this module
//   this module ──(GITHUB_TOKEN_CHANGED, 401 auto-clear)──▶ host safeStorage
//
// Electron safeStorage stays the ONLY durable store; this is a working copy
// that lives only as long as the engine process. On engine restart the host
// re-pushes on (re)connect (Phase 3), so a lost cache self-heals.
//
// Security: the GITHUB_TOKEN_SET handler (index.ts) accepts the seed from LOCAL
// clients only, and the change notifier is delivered via broadcastLocal — a
// relay device never sets nor receives the host's token.

import type { TokenStore } from "./github";

let token: string | null = null;
let onChange: ((token: string | null) => void) | null = null;

/** Wire the callback the engine uses to mirror an engine-originated token change
 *  back to the host (so it can update safeStorage). Pass `null` to unwire. */
export function setGithubTokenChangeNotifier(
  fn: ((token: string | null) => void) | null,
): void {
  onChange = fn;
}

/** Seed the working copy from a host push (GITHUB_TOKEN_SET). Does NOT notify —
 *  the host is the origin, so echoing the change back would be redundant (and
 *  risk a loop). Empty string normalises to null. */
export function seedGithubToken(t: string | null): void {
  token = t && t.length > 0 ? t : null;
}

/** The engine's GitHub TokenStore. `get()` returns the host-pushed working copy.
 *  `set()`/`clear()` are ENGINE-originated mutations (today only the 401 auto-
 *  clear inside withAuthRetry) and notify the host so safeStorage stays in sync.
 *  The engine never persists — it has no safeStorage. */
export const engineGithubTokenStore: TokenStore = {
  async get() {
    return token;
  },
  async set(t: string) {
    token = t && t.length > 0 ? t : null;
    onChange?.(token);
  },
  async clear() {
    token = null;
    onChange?.(null);
  },
};

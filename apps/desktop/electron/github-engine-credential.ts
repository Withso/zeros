// Pure host→engine credential projection.
//
// Refresh tokens, Auth0 ownership, and installation metadata stay in Electron
// main. The engine receives only the selected short-lived working credential,
// and never receives an expired App token or one owned by another Zeros user.

import type { GithubCredential } from "@zeros/protocol/github-auth";

export function githubCredentialForEngine(
  credential: GithubCredential | null,
  currentOwnerSub: string | null,
  nowMs = Date.now(),
): GithubCredential | null {
  if (!credential || credential.method !== "github-app") return credential;
  if (
    !currentOwnerSub ||
    !credential.ownerSub ||
    credential.ownerSub !== currentOwnerSub ||
    credential.expiresAtMs === undefined ||
    credential.expiresAtMs <= nowMs
  ) {
    return null;
  }
  return {
    method: "github-app",
    accessToken: credential.accessToken,
    gitHost: credential.gitHost,
    gitHttpUsername: credential.gitHttpUsername,
    ...(credential.login ? { login: credential.login } : {}),
    ...(credential.expiresAtMs ? { expiresAtMs: credential.expiresAtMs } : {}),
    ...(credential.variantKey ? { variantKey: credential.variantKey } : {}),
  };
}

/** Project a selected credential without touching the signed-in session unless
 * a GitHub App credential actually needs its owner binding checked. Keychain
 * reads on macOS are synchronous and may display an ACL prompt after a local
 * app reinstall, so eagerly resolving the owner can stall Electron main even
 * when the selected credential is null, PAT, or gh-cli. */
export function githubCredentialForEngineLazyOwner(
  credential: GithubCredential | null,
  getCurrentOwnerSub: () => string | null,
  nowMs = Date.now(),
): GithubCredential | null {
  if (!credential || credential.method !== "github-app") return credential;
  return githubCredentialForEngine(
    credential,
    getCurrentOwnerSub(),
    nowMs,
  );
}

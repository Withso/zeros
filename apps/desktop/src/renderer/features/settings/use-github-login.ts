// The connected GitHub login, read-only.
//
// Settings → Git needs the login to LABEL the "GitHub username (…)" option;
// Settings → Integrations owns actually connecting the account. This hook is
// the read-only half, sharing `ghAuthStatusCache` with GitHubSection so both
// panes show the same account and a sign-in on one is visible on the other
// without a second round trip.
//
// Deliberately does NOT adopt a gh-CLI token: adopting credentials is a side
// effect, and a label has no business causing one. If nothing is connected yet
// this returns null and the caller says so, rather than silently signing the
// user in.

import { ghAuthSnapshot } from "../../platform/git";
import {
  ghAuthStatusCache,
  GITHUB_READ_MAX_AGE_MS,
} from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";

/** The connected GitHub login, or null when unknown / not signed in. */
export function useGithubLogin(): string | null {
  // The exact fetcher GitHubSection uses, so the two panes dedupe onto one
  // read instead of racing two. The fetcher ignores the key it is handed —
  // this read's key is the constant "auth".
  const connection = useCachedRead(
    ghAuthStatusCache,
    "auth",
    () => ghAuthSnapshot(),
    { maxAgeMs: GITHUB_READ_MAX_AGE_MS },
  );
  const snapshot = connection.data;
  if (!snapshot) return null;
  // Since the three-way auth split there is a summary PER method, and only the
  // selected one describes the account Zeros will actually push with. Reading
  // "any method that has a login" would label the branch prefix with an
  // account the user switched away from.
  const summary = snapshot.methods[snapshot.selectedMethod];
  // `configured` is not enough: a method can hold an expired or revoked
  // credential and still be configured. Only a login GitHub confirmed this
  // probe is worth stamping onto a branch name, which is permanent.
  if (!summary || summary.health !== "connected") return null;
  return summary.login ?? null;
}

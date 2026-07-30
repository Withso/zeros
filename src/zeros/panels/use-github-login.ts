// The connected GitHub login, read-only.
//
// Settings → Git needs the login to LABEL the "GitHub username (…)" option;
// Settings → Integrations owns actually connecting the account. This hook is
// the read-only half, sharing `ghAuthStatusCache` with GitHubSection so both
// panes show the same account and a sign-in on one is visible on the other
// without a second /user round trip.
//
// Deliberately does NOT adopt a gh-CLI token the way GitHubSection's probe
// does: adopting credentials is a side effect, and a label has no business
// causing one. If nothing is connected yet this returns null and the caller
// says so, rather than silently signing the user in.

import { ghAuthStatus } from "../../native/git";
import {
  ghAuthStatusCache,
  GITHUB_READ_MAX_AGE_MS,
  type GithubConnection,
} from "../store/read-caches";
import { useCachedRead } from "../store/use-cached-read";

/** The connected GitHub login, or null when unknown / not signed in. */
export function useGithubLogin(): string | null {
  const connection = useCachedRead(
    ghAuthStatusCache,
    "auth",
    async (): Promise<GithubConnection> => {
      const previous = ghAuthStatusCache.getSnapshot("auth").data;
      const status = await ghAuthStatus();
      return {
        login: status.authenticated ? (status.login ?? null) : null,
        // Carry the CLI provenance flags forward — they belong to
        // GitHubSection's probe and this read must not clobber them.
        viaCli: previous?.viaCli ?? false,
        ghAvailable: previous?.ghAvailable ?? false,
      };
    },
    { maxAgeMs: GITHUB_READ_MAX_AGE_MS },
  );
  return connection.data?.login ?? null;
}

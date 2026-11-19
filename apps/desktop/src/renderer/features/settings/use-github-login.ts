import { ghAuthSnapshot } from "../../platform/git";
import {
  ghAuthStatusCache,
  GITHUB_READ_MAX_AGE_MS,
} from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";

// A branch label reads the selected method without selecting or connecting one.
export function useGithubLogin(): string | null {
  // Share the Integrations auth cache so the two panes observe one snapshot.
  const connection = useCachedRead(
    ghAuthStatusCache,
    "auth",
    () => ghAuthSnapshot(),
    { maxAgeMs: GITHUB_READ_MAX_AGE_MS },
  );
  const snapshot = connection.data;
  if (!snapshot) return null;
  const summary = snapshot.methods[snapshot.selectedMethod];
  // Only use the selected account if GitHub confirmed it; the branch name outlives the credential.
  if (!summary || summary.health !== "connected") return null;
  return summary.login ?? null;
}

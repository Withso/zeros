// Reports the Production app's release-candidate opt-in to Electron main, which
// owns the updater feed (apps/desktop/electron/updater.ts `updater_release_candidates`).
// The effective value is staff role AND the Internal flag, sent only once the role
// is known: a signed-out launch, or a /v1/me still loading, keeps main's last choice
// rather than switching the feed back and forth.
import { useEffect } from "react";
import { CHANNEL } from "../../config/release-channel";
import { isElectron, nativeInvoke } from "../../platform/runtime";
import { useInternalFeature } from "../settings/internal-features";
import { useTeams, type TeamStoreState } from "../team/team-store";

/** The opt-in to report, or null while the staff role is unknown. */
export function releaseCandidateChoice(state: Pick<TeamStoreState, "me" | "status">, flag: boolean): boolean | null {
  if (state.status !== "ready" || !state.me) return null;
  const role = state.me.user.staffRole;
  return flag && (role === "developer" || role === "platform_owner");
}

let lastReported: boolean | null = null;
export function resetReleaseCandidatesSyncForTests(): void { lastReported = null; }

export function reportReleaseCandidateChoice(choice: boolean | null): void {
  if (choice === null || choice === lastReported || CHANNEL !== "stable" || !isElectron()) return;
  lastReported = choice;
  void nativeInvoke("updater_release_candidates", { enabled: choice }).catch(() => {
    lastReported = null; // retried on the next change or launch
  });
}

/** Renders nothing; mounted once beside <UpdateNotifications/> in the app shell. */
export function ReleaseCandidatesSync(): null {
  const { me, status } = useTeams();
  const [flag] = useInternalFeature("releaseCandidates");
  const choice = releaseCandidateChoice({ me, status }, flag);
  useEffect(() => { reportReleaseCandidateChoice(choice); }, [choice]);
  return null;
}

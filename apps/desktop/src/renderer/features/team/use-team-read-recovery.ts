import { useMemo } from "react";
import { useReadRecovery } from "../../state/use-read-recovery";
import { getOrganizationStoreGeneration, useTeams } from "./team-store";

/** Presentation-only recovery; membership and access still use the raw store. */
export function useTeamReadRecovery(active = true) {
  const snapshot = useTeams();
  const error = useMemo(() => snapshot.error ? new Error(snapshot.error) : null, [snapshot.error]);
  const recovery = useReadRecovery(`organizations:${getOrganizationStoreGeneration()}`, {
    error, pending: snapshot.status === "loading", hasContent: snapshot.me !== null,
    retry: snapshot.reload, connected: true, active,
  });
  return { ...snapshot, error: recovery.error?.message ?? null };
}

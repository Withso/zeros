import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { useMyUserId } from "../../platform/team-sharing-state";
import { memberName, useOrganizationRoster } from "../../state/organization-roster";
import { useSessionsStore } from "./sessions-store";

/** Team sharing (activated): who the running cloud turn acts as, beside its live timer. Nothing when the worker named nobody. */
export function ActingAs({ chatId, active }: { chatId: string; active: boolean }) {
  const actingUserId = useSessionsStore(state => state.sessions[chatId]?.actingUserId ?? null);
  const cwd = useSessionsStore(state => state.sessions[chatId]?.cwd);
  const me = useMyUserId();
  const organizationId = parseCloudWorkspaceKey(cwd)?.organizationId;
  const roster = useOrganizationRoster(actingUserId && actingUserId !== me ? organizationId : null, active && !!actingUserId);
  const name = actingAsName(actingUserId, me, roster);
  return name ? <ActingAsLabel name={name} /> : null;
}

/** "you" for the viewer's own turn, the roster name otherwise, or nothing when the turn names nobody. */
export function actingAsName(actingUserId: string | null, me: string | null, roster: Parameters<typeof memberName>[0]): string | null {
  if (!actingUserId) return null;
  return actingUserId === me ? "you" : memberName(roster, actingUserId);
}

export function ActingAsLabel({ name }: { name: string }) {
  return <p className="text-fg3 mt-1 text-xs" data-acting-as="">{`Acting as ${name}`}</p>;
}

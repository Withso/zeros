import { z } from "zod";
import { CloudGithubRepositoryPageSchema } from "@zeros/protocol/cloud-github-connection";
import { getSetting, setSetting } from "../../platform/settings";
import { CONTROL_PLANE_URL } from "../team/control-plane";
import { getTeamStoreState, subscribeOrganizationSnapshots } from "../team/team-store";

const key = "settings:environment-selection:v1";
const entry = z.object({ backend: z.string(), user: z.string(), organization: z.string(), scope: z.enum(["local", "cloud"]),
  repository: CloudGithubRepositoryPageSchema.shape.repositories.element.nullable() }).strict();
type Entry = z.infer<typeof entry>;
function entries(): Entry[] {
  const raw = getSetting<unknown>(key, []);
  return Array.isArray(raw) ? raw.slice(-32).flatMap(value => { const parsed = entry.safeParse(value); return parsed.success ? [parsed.data] : []; }) : [];
}
const same = (entry: Entry, user: string, organization: string) => entry.backend === CONTROL_PLANE_URL && entry.user === user && entry.organization === organization;
export function readEnvironmentSelection(user: string, organization: string): Pick<Entry, "scope" | "repository"> {
  return entries().find(entry => same(entry, user, organization)) ?? { scope: "local", repository: null };
}
export function saveEnvironmentSelection(user: string, organization: string, selection: Pick<Entry, "scope" | "repository">): void {
  const parsed = entry.safeParse({ backend: CONTROL_PLANE_URL, user, organization, ...selection });
  if (parsed.success) setSetting(key, [...entries().filter(row => !same(row, user, organization)), parsed.data].slice(-32));
}
subscribeOrganizationSnapshots(() => {
  const me = getTeamStoreState().me;
  if (!me) return;
  const organizations = new Set((me.organizations ?? me.teams).filter(org => !org.isPersonal).map(org => org.id));
  setSetting(key, entries().filter(row => row.backend !== CONTROL_PLANE_URL || row.user !== me.user.id || organizations.has(row.organization)));
});

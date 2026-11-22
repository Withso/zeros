// `--plan`: what each stage would write, with the resolved names and counts, and what each account can do. It makes no
// write to Alpha's control plane, Boat, R2 or GitHub; its only provider call that is not a read is one temporary
// read-only database role (to count platform owners), deleted before it returns.
import { z } from "zod";
import { STAGE_SWITCH, type Api, type Database, type StageName, type Switch } from "./contract.js";
import { safeLine } from "./guard.js";
import { FIXTURE_TWO } from "./stage-provision.js";
import { STAGE_RUNNERS } from "./runner.js";
import { call, parse } from "./steps.js";

export type AccountSummary = {
  label: string;
  organizations: { name: string; role: string; personal: boolean; probe: boolean }[];
  /** In the probe organization. */
  admin: boolean; connections: { organization: number; personal: number; logins: string[] }; activeMachines: number;
  /** In the probe organization: the fixture owner's organization-level connection is present. */
  fixtureConnection: boolean;
};

export async function readAccount(api: Api, label: string, probeOrganization: string, fixtureOwner: string): Promise<AccountSummary> {
  const me = parse(z.object({ organizations: z.array(z.object({ id: z.string(), name: z.string(), role: z.string().nullable().optional(),
    isPersonal: z.boolean().optional() }).passthrough()) }).passthrough(), (await call(api, "GET", "/v1/me", "plan_me")).body, "plan_me");
  const probe = me.organizations.find(org => org.id === probeOrganization);
  const summary: AccountSummary = {
    label, organizations: me.organizations.map(org => ({ name: org.name, role: org.role ?? "none", personal: org.isPersonal === true, probe: org.id === probeOrganization })),
    admin: false, connections: { organization: 0, personal: 0, logins: [] }, activeMachines: 0, fixtureConnection: false,
  };
  if (!probe) return summary;
  const projects = await api.json("GET", `/v1/cloud-v2/organizations/${probeOrganization}/cloud-projects`);
  if (projects.status === 200) summary.admin = z.object({ canCreateOrganization: z.boolean() }).passthrough().safeParse(projects.body).data?.canCreateOrganization === true;
  const connections = await api.json("GET", `/v1/cloud-v2/organizations/${probeOrganization}/github/connections`);
  const Row = z.object({ accountLogin: z.string(), state: z.string() }).passthrough();
  const parsed = z.object({ organization: z.array(Row), personal: z.array(Row) }).passthrough().safeParse(connections.body);
  if (connections.status === 200 && parsed.success) {
    summary.connections = { organization: parsed.data.organization.length, personal: parsed.data.personal.length,
      logins: [...new Set([...parsed.data.organization, ...parsed.data.personal].map(row => row.accountLogin))] };
    summary.fixtureConnection = parsed.data.organization.some(row => row.accountLogin.toLowerCase() === fixtureOwner.toLowerCase() && row.state === "active");
  }
  const workspaces = await api.json("GET", `/v1/cloud-v2/workspaces?organizationId=${probeOrganization}`);
  const listed = z.object({ workspaces: z.array(z.object({ state: z.string() }).passthrough()) }).safeParse(workspaces.body);
  if (listed.success) summary.activeMachines = listed.data.workspaces.filter(row => ["creating", "starting", "running", "stopping"].includes(row.state)).length;
  return summary;
}

export function accountLines(summary: AccountSummary): string[] {
  return [
    `account ${summary.label}: ${summary.organizations.length} organizations`,
    ...summary.organizations.map(org => `  organization ${org.name} role ${org.role}${org.personal ? " personal" : ""}${org.probe ? " (probe)" : ""}`),
    `  probe organization: ${summary.organizations.some(org => org.probe) ? "member" : "not a member"}, owner or admin ${summary.admin ? "yes" : "no"}`,
    `  github connections: organization ${summary.connections.organization}, personal ${summary.connections.personal}` +
      (summary.connections.logins.length ? ` (${summary.connections.logins.join(", ")})` : ""),
    `  fixture connection active: ${summary.fixtureConnection ? "yes" : "no"}; active machines ${summary.activeMachines}`,
  ].map(safeLine);
}

/** Why an account cannot run a stage, or null. Stages A and C need an owner or admin of the probe organization with
 * the fixture owner's organization-level connection. */
export function refusal(stage: StageName, account: AccountSummary, switches: ReadonlySet<Switch>): string | null {
  if (!STAGE_RUNNERS[stage]) return "not_written";
  const needed = STAGE_SWITCH[stage];
  if (needed && !switches.has(needed)) return `undeclared_${needed}`;
  if (stage === "provision") return null;
  if (!account.organizations.some(org => org.probe)) return "not_a_member";
  if (!account.admin) return "not_owner_or_admin";
  if (!account.fixtureConnection) return "no_fixture_connection";
  return null;
}

export function writeLines(stage: StageName, prefix: string, repositories: { one: string; two?: string }): string[] {
  const two = repositories.two ?? FIXTURE_TWO;
  const lines: Record<StageName, string[]> = {
    provision: [`provision would create ${two} (private, one initial commit) only if it does not exist; cleanup removes it unless --keep-fixtures`],
    projects: [
      `projects would create project ${prefix}one (organization, ${repositories.one}) and wait for its copy (1 machine)`,
      `projects would create workspace ${prefix}one-w on branch ${prefix}one (1 machine start), 1 turn, 1 terminal, 1 file`,
      `projects would commit and push branch ${prefix}one to ${repositories.one}, open 1 draft pull request, close it unmerged, delete the branch`,
      `projects would stop, wake (1 start), archive, open (1 start) and delete ${prefix}one-w`,
      `projects would create project ${prefix}two (organization, ${repositories.one} and ${two}) and wait for its copy (1 machine)`,
      `projects would create workspace ${prefix}two-w on branch ${prefix}two (1 machine start), push ${prefix}two to ${two}, open and close 1 draft pull request`,
      `projects would run 2 turns writing 1 file in each repository and rewind the second, then delete ${prefix}two-w and both projects`,
      "projects would read cloud_v2_ready_copy_forks and cloud_v2_ready_copies through one temporary role, deleted at the end of the stage",
    ],
    personal: ["personal: not written yet (waiting on the owner's answers)"],
    retention: [
      `retention would create project ${prefix}ret (organization, ${repositories.one} and ${two}) and its copy (1 machine)`,
      `retention would create workspaces ${prefix}ret-w and ${prefix}ret-k (2 machine starts); in ${prefix}ret-w one unpushed commit and one untracked file in ${two},` +
        ` one ignored file in ${repositories.one}`,
      `retention would stop both, then shift their clocks 5 or 6 times (1 hour, 10.6, 31 and 10.6 days; 61 days for the removal) through one temporary role`,
      "retention would set Keep on then off on one workspace",
      "retention would delete both workspaces' machines on Boat, then open both (2 starts), then delete both workspaces and the project",
      "retention would, when S4 is deployed, stop and archive one workspace again and wait for its backup's removal",
    ],
    submodules: ["submodules: not written yet (after #1247 is deployed)"],
  };
  return lines[stage].map(safeLine);
}

/** Active platform owners, by the first 8 characters of their user ids: the Pro operator's actor for stage B. */
export async function platformOwners(database: Database): Promise<string[]> {
  const rows = await database.read(`SELECT id::text AS id FROM users WHERE staff_role = 'platform_owner' AND auth_status = 'active' AND deleted_at IS NULL ORDER BY id`);
  return rows.map(row => String(row.id).slice(0, 8));
}

// `--plan`: what each stage would write, with the resolved names and counts, and what each account can do. It makes no
// write to Alpha's control plane, Boat, R2 or GitHub; its only provider calls that are not reads are one session per
// account (revoked) and one temporary database role inheriting only pg_read_all_data (to count platform owners), deleted
// before it returns.
import { z } from "zod";
import { RehearsalFailure, STAGE_NEEDS_ACCOUNT, STAGE_SWITCH, type Api, type Database, type StageName, type Switch } from "./contract.js";
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
  /** The account's own GitHub sign-in for the probe organization (GitHub App or token): a project create reads each
   * repository as the caller, so without one it is refused (403 github_connection_required). */
  githubIdentity: boolean;
};

/** Each read names its step, so a failure says which (account_projects http_403, account_github_identity schema:...). */
export async function readAccount(api: Api, label: string, probeOrganization: string, fixtureOwner: string): Promise<AccountSummary> {
  const me = parse(z.object({ organizations: z.array(z.object({ id: z.string(), name: z.string(), role: z.string().nullable().optional(),
    isPersonal: z.boolean().optional() }).passthrough()) }).passthrough(), (await call(api, "GET", "/v1/me", "account_me")).body, "account_me");
  const probe = me.organizations.find(org => org.id === probeOrganization);
  const summary: AccountSummary = {
    label, organizations: me.organizations.map(org => ({ name: org.name, role: org.role ?? "none", personal: org.isPersonal === true, probe: org.id === probeOrganization })),
    admin: false, connections: { organization: 0, personal: 0, logins: [] }, activeMachines: 0, fixtureConnection: false, githubIdentity: false,
  };
  if (!probe) return summary;
  summary.admin = parse(z.object({ canCreateOrganization: z.boolean() }).passthrough(),
    (await call(api, "GET", `/v1/cloud-v2/organizations/${probeOrganization}/cloud-projects`, "account_projects")).body, "account_projects").canCreateOrganization;
  const Row = z.object({ accountLogin: z.string(), state: z.string() }).passthrough();
  const connections = parse(z.object({ organization: z.array(Row), personal: z.array(Row) }).passthrough(),
    (await call(api, "GET", `/v1/cloud-v2/organizations/${probeOrganization}/github/connections`, "account_connections")).body, "account_connections");
  summary.connections = { organization: connections.organization.length, personal: connections.personal.length,
    logins: [...new Set([...connections.organization, ...connections.personal].map(row => row.accountLogin))] };
  summary.fixtureConnection = connections.organization.some(row => row.accountLogin.toLowerCase() === fixtureOwner.toLowerCase() && row.state === "active");
  const Method = z.object({ configured: z.boolean() }).passthrough();
  const identity = parse(z.object({ selectedMethod: z.enum(["github-app", "pat"]).nullable(), methods: z.object({ "github-app": Method, pat: Method }).passthrough() }).passthrough(),
    (await call(api, "GET", `/v1/cloud-v2/github/connection?organizationId=${probeOrganization}`, "account_github_identity")).body, "account_github_identity");
  summary.githubIdentity = identity.selectedMethod !== null && identity.methods[identity.selectedMethod].configured;
  const listed = parse(z.object({ workspaces: z.array(z.object({ state: z.string() }).passthrough()) }).passthrough(),
    (await call(api, "GET", `/v1/cloud-v2/workspaces?organizationId=${probeOrganization}`, "account_workspaces")).body, "account_workspaces");
  summary.activeMachines = listed.workspaces.filter(row => ["creating", "starting", "running", "stopping"].includes(row.state)).length;
  return summary;
}

export function accountLines(summary: AccountSummary): string[] {
  return [
    `account ${summary.label}: ${summary.organizations.length} organizations`,
    ...summary.organizations.map(org => `  organization ${org.name} role ${org.role}${org.personal ? " personal" : ""}${org.probe ? " (probe)" : ""}`),
    `  probe organization: ${summary.organizations.some(org => org.probe) ? "member" : "not a member"}, owner or admin ${summary.admin ? "yes" : "no"}`,
    `  github connections: organization ${summary.connections.organization}, personal ${summary.connections.personal}` +
      (summary.connections.logins.length ? ` (${summary.connections.logins.join(", ")})` : ""),
    `  fixture connection active: ${summary.fixtureConnection ? "yes" : "no"}; own github sign-in: ${summary.githubIdentity ? "yes" : "no"}; active machines ${summary.activeMachines}`,
  ].map(safeLine);
}

/** Why a stage cannot run, or null. `account` is the selected account's summary, or the reason its sign-in or read
 * failed. provision needs no account. A and C need an owner or admin of the probe organization, the fixture owner's
 * organization-level connection, and the account's own GitHub sign-in. */
export function refusal(stage: StageName, account: AccountSummary | { failed: string }, switches: ReadonlySet<Switch>): string | null {
  if (stage === "setup") return "awaiting_approval";
  if (!STAGE_RUNNERS[stage]) return "not_written";
  const needed = STAGE_SWITCH[stage];
  if (needed && !switches.has(needed)) return `undeclared_${needed}`;
  if (!STAGE_NEEDS_ACCOUNT[stage]) return null;
  if ("failed" in account) return `account_unavailable:${account.failed}`;
  if (!account.organizations.some(org => org.probe)) return "not_a_member";
  if (!account.admin) return "not_owner_or_admin";
  if (!account.fixtureConnection) return "no_fixture_connection";
  if (!account.githubIdentity) return "no_github_identity";
  return null;
}

export function writeLines(stage: StageName, prefix: string, repositories: { one: string; two?: string }): string[] {
  const two = repositories.two ?? FIXTURE_TWO;
  const lines: Record<StageName, string[]> = {
    provision: [`provision would create ${two} (private, one initial commit with GitHub's Node .gitignore) only if it does not exist; cleanup removes it unless --keep-fixtures`],
    projects: [
      `projects would create project ${prefix}one (organization, ${repositories.one}) and wait for its copy (1 machine)`,
      `projects would create workspace ${prefix}one-w on branch ${prefix}one (1 machine start), 1 turn, 1 terminal, 1 file`,
      `projects would commit and push branch ${prefix}one to ${repositories.one}, open 1 draft pull request, close it unmerged, delete the branch`,
      `projects would stop, wake (1 start), archive, open (1 start) and delete ${prefix}one-w`,
      `projects would create project ${prefix}two (organization, ${repositories.one} and ${two}) and wait for its copy (1 machine)`,
      `projects would seed the account's environment for ${repositories.one} and ${two} with one file .env each, only if both are at revision 0` +
        " (or empty and this run's own) and both repositories ignore .env, else skip it as environment_exists or path_not_ignored; cleared after the stage and by cleanup",
      `projects would create workspace ${prefix}two-w on branch ${prefix}two (1 machine start), push ${prefix}two to ${two}, open and close 1 draft pull request`,
      `projects would run 2 turns writing 1 file in each repository and rewind the second, then delete ${prefix}two-w and both projects`,
      "projects would read cloud_v2_ready_copy_forks and cloud_v2_ready_copies through one temporary pg_read_all_data role, deleted at the end of the stage; no postgres role",
    ],
    personal: ["personal: not written yet (waiting on the owner's answers)"],
    // A proposal for the owner: what lets a test user run A and C without the owner's account in the stages themselves.
    setup: [
      "setup (proposal, not run until approved) would let test user <n> run projects and retention in the probe organization:",
      "  1. invitation: POST /v1/organizations/<probe>/invitations role admin for user <n>, as an admin of the probe organization (today only the owner's account);" +
        " the reply's one-use token is held in memory",
      "  2. accept: POST /v1/invitations/accept as user <n>; the membership is an ordinary admin row, synced to WorkOS like any invitation",
      "  3. own github sign-in: POST /v1/cloud-v2/github/connection action pat as user <n>, with a fine-grained token from ZEROS_REHEARSAL_GITHUB_TOKEN" +
        " scoped to the fixture repositories only (contents and pull requests write, metadata read); its GitHub account is the owner's choice",
      "  cleanup: user <n> disconnects the token (action disconnect method pat) and leaves the organization (DELETE /v1/organizations/<probe>/members/<n>," +
        " which a member may do for themself); the token is then revoked on GitHub by its owner",
      "  why 3 is needed: a project create resolves each repository as the caller (resolveMemberRepository through github.connections.access)," +
        " and a caller with no GitHub sign-in is refused 403 github_connection_required; an admin who is not the connection's owner is not refused for that",
    ],
    retention: [
      `retention would create project ${prefix}ret (organization, ${repositories.one} and ${two}) and its copy (1 machine)`,
      `retention would seed the account's environment for ${repositories.one} with .env under the same rule as projects (noted as environment_case:seeded_edited` +
        " or hand_made_ignored), cleared after the stage and by cleanup",
      `retention would create workspaces ${prefix}ret-w and ${prefix}ret-k (2 machine starts); in ${prefix}ret-w one unpushed commit and one untracked file in ${two},` +
        ` and in ${repositories.one} either the seeded .env edited by hand or a hand-made ignored file`,
      "retention would stop both, then shift their clocks 4 times (1 hour, 10.6, 31 and 10.6 days) and once more for the removal (61 days), each through its own" +
        " temporary postgres role deleted when the shift commits; reads go through one pg_read_all_data role",
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

/** The probe organization by slug or id, and its WorkOS organization id (the one to choose when WorkOS asks a member of
 * several organizations), read through the read role before any sign-in. */
export async function resolveProbe(database: Database, selector: string): Promise<{ id: string; workosOrganizationId: string | null }> {
  const rows = await database.read(`SELECT o.id::text AS id, l.workos_organization_id FROM organizations o
    LEFT JOIN workos_organization_links l ON l.organization_id = o.id WHERE (o.slug = $1 OR o.id::text = $1) AND o.deleted_at IS NULL`, [selector]);
  if (rows.length !== 1) throw new RehearsalFailure("probe_organization", rows.length ? "ambiguous" : "not_found");
  return { id: String(rows[0]!.id), workosOrganizationId: rows[0]!.workos_organization_id ? String(rows[0]!.workos_organization_id) : null };
}

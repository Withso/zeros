// `--plan`: what each stage would write, with the resolved names and counts, and what each account can do. It makes no
// write to Alpha's control plane, Boat, R2 or GitHub; its only provider calls that are not reads are one session per
// account (revoked) and one temporary database role inheriting only pg_read_all_data (to count platform owners), deleted
// before it returns.
import { z } from "zod";
import { RehearsalFailure, STAGE_NEEDS_ACCOUNT, stageSwitches, type Api, type Database, type OwnerKind, type StageName, type Switch } from "./contract.js";
import { safeLine } from "./guard.js";
import { FIXTURE_TWO } from "./stage-provision.js";
import { STAGE_RUNNERS } from "./runner.js";
import { call, connectedAgents, parse, TURN_AGENTS, type TurnAgent } from "./steps.js";

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
  /** The account's Pro, and its Personal organization: the Personal route's owner. */
  pro: boolean; personal: { id: string; seat: string | null } | null;
  /** The account's connected agents (turn preference order) in its Personal organization and in the probe organization;
   * null when not a member or the read failed. A turn needs one: none runs without its person's credential. */
  agents: { personal: TurnAgent[] | null; probe: TurnAgent[] | null };
};

const agentsIn = (api: Api, organizationId: string) => connectedAgents(api, organizationId, "account_agents").catch(() => null);

/** Each read names its step, so a failure says which (account_projects http_403, account_github_identity schema:...). */
export async function readAccount(api: Api, label: string, probeOrganization: string, fixtureOwner: string): Promise<AccountSummary> {
  const me = parse(z.object({ capabilities: z.object({ pro: z.boolean() }).passthrough().optional(),
    organizations: z.array(z.object({ id: z.string(), name: z.string(), role: z.string().nullable().optional(),
    isPersonal: z.boolean().optional(), seat: z.string().optional() }).passthrough()) }).passthrough(), (await call(api, "GET", "/v1/me", "account_me")).body, "account_me");
  const probe = me.organizations.find(org => org.id === probeOrganization);
  const own = me.organizations.find(org => org.isPersonal === true && org.role === "owner");
  const summary: AccountSummary = {
    label, organizations: me.organizations.map(org => ({ name: org.name, role: org.role ?? "none", personal: org.isPersonal === true, probe: org.id === probeOrganization })),
    admin: false, connections: { organization: 0, personal: 0, logins: [] }, activeMachines: 0, fixtureConnection: false, githubIdentity: false,
    pro: me.capabilities?.pro === true, personal: own ? { id: own.id, seat: own.seat ?? null } : null,
    agents: { personal: own ? await agentsIn(api, own.id) : null, probe: probe ? await agentsIn(api, probe.id) : null },
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
    `  pro: ${summary.pro ? "yes" : "no"}; personal organization: ${summary.personal ? `yes, cloud seat ${summary.personal.seat ?? "none"}` : "no"}`,
    `  connected agents: personal ${agentList(summary.agents.personal)}; probe ${agentList(summary.agents.probe)}`,
  ].map(safeLine);
}
const agentList = (agents: TurnAgent[] | null) => agents === null ? "unread" : agents.length ? agents.join(", ") : "none";

/** What stage projects' three turns will do for the selected account on the route: which agent runs them, or that each is
 * skipped and counted (turn_skipped:no_agent_credential), and what would cover them. Printed before any machine starts. */
export function turnLine(summary: AccountSummary | { failed: string }, owner: "personal" | "organization", label: string, configured: readonly TurnAgent[] = []): string {
  if ("failed" in summary) return `turns: unknown (account ${label} unread: ${summary.failed})`;
  const agents = owner === "personal" ? summary.agents.personal : summary.agents.probe;
  const where = owner === "personal" ? "its Personal organization" : "the probe organization";
  if (agents === null) return `turns: unknown (account ${label}'s agent connections in ${where} unread)`;
  // Every agent the first turn runs on: those connected now, and those setup connects from the rehearsal's credentials.
  const all = TURN_AGENTS.filter(agent => agents.includes(agent) || configured.includes(agent));
  if (all.length) return `turns: ${all.map(agent => `${agent} (${agents.includes(agent) ? "connected" : "the rehearsal's credential, connected by setup and removed by cleanup"})`).join(", ")}`
    + ` for account ${label} in ${where}; the first turn runs once per agent, the rewind on ${all[0]}`;
  return `turns: none connected for account ${label} in ${where}: stage projects skips its 3 turns (turn_skipped:no_agent_credential, counted, not passed);`
    + " to cover them, connect a Claude, Codex or Cursor credential for that account there";
}

/** What the Personal route needs besides an account: the token for the account's own GitHub sign-in, and the one
 * active platform owner for the Pro grant. */
export type PersonalReadiness = { token: boolean; proActor: "resolved" | "none" | "ambiguous";
  /** Why the token check refused it (kind_classic, reaches_outside_fixtures, fixture_contents_read_only, ...). */
  tokenRefusal?: string;
  /** Stage D's two fixture repositories (R3 and the Withso fixture that is one of its submodules), as the run's GitHub identity sees them. */
  submoduleFixtures?: "present" | "missing" | "not_named";
  /** Stage waiting's account (--waiting-account, test user 3 by default): "fresh" when its Personal organization has no
   * base and nothing building, else why not (base_ready, account_unavailable:<code>, no_personal_organization). */
  waitingAccount?: string };

/** Why a stage cannot run, or null. `account` is the selected account's summary, or the reason its sign-in or read
 * failed. provision needs no account. On the Personal route the account needs its Personal organization, and setup the
 * token and the Pro actor; A, C and B then run after setup (in this run or an earlier one). On the organization route A
 * and C need an owner or admin of the probe organization, the fixture owner's organization-level connection and the
 * account's own GitHub sign-in, and setup is a proposal awaiting approval. */
export function refusal(stage: StageName, account: AccountSummary | { failed: string }, switches: ReadonlySet<Switch>, owner: OwnerKind = "personal",
  readiness: PersonalReadiness = { token: true, proActor: "resolved" }): string | null {
  if (stage === "setup" && owner === "organization") return "awaiting_approval";
  if (!STAGE_RUNNERS[stage]) return "not_written";
  if ((stage === "personal" || stage === "submodules") && owner !== "personal") return "personal_route_only";
  if (stage === "submodules" && readiness.submoduleFixtures !== "present") return `fixtures_${readiness.submoduleFixtures ?? "not_named"}`;
  if (stage === "waiting" && owner !== "personal") return "personal_route_only";
  if (stage === "waiting" && readiness.waitingAccount !== "fresh") return `waiting_account_${readiness.waitingAccount ?? "not_configured"}`;
  const missing = stageSwitches(stage, owner).find(needed => !switches.has(needed));
  if (missing) return `undeclared_${missing}`;
  if (!STAGE_NEEDS_ACCOUNT[stage]) return null;
  if ("failed" in account) return `account_unavailable:${account.failed}`;
  if (owner === "personal") {
    if (!account.personal) return "no_personal_organization";
    // Stage waiting prepares its own account as setup does.
    const owns = stage === "setup" || stage === "waiting";
    if (owns && !readiness.token) return "no_github_token";
    if (owns && readiness.tokenRefusal) return `github_token_${readiness.tokenRefusal}`;
    if (owns && readiness.proActor !== "resolved") return `pro_actor_${readiness.proActor}`;
    return null;
  }
  if (!account.organizations.some(org => org.probe)) return "not_a_member";
  if (!account.admin) return "not_owner_or_admin";
  if (!account.fixtureConnection) return "no_fixture_connection";
  if (!account.githubIdentity) return "no_github_identity";
  return null;
}

/** What the Personal route does not rehearse that the organization route would. */
export const PERSONAL_ROUTE_GAPS = [
  "not covered on the Personal route: organization-level projects (every project is Only you), and copies shared with other members",
  "not covered on the Personal route: the per-member access check at create (a copy holding what another member cannot read)",
  "not covered on the Personal route: team sharing and shared execution (a Personal organization has one member)",
  "not covered with a token sign-in: read-only submodule tokens (C4), Mac sync (github_access_required); the build's clone, pushes and pull requests use the token itself",
  "not covered on any route: a private repository; every fixture is public, so no private clone at build, no private submodule and no token-scoped read",
  "not covered: private submodules (no private submodule fixture): read-only submodule tokens and the creator-cannot-read path",
];

export function writeLines(stage: StageName, prefix: string, repositories: { one: string; two?: string }, owner: OwnerKind = "personal"): string[] {
  const two = repositories.two ?? FIXTURE_TWO;
  const where = owner === "personal" ? "in the test user's Personal organization, as Only you projects" : "in the probe organization, as organization projects";
  const lines: Record<StageName, string[]> = {
    provision: [`provision is check-only: ${repositories.one}, ${two} and the stage D fixtures must exist (the rehearsal never creates or deletes a repository;` +
      " the App has no administration permission)"],
    projects: [
      `projects runs ${where}`,
      `projects would create project ${prefix}one (${repositories.one}) and wait for its copy (1 machine)`,
      `projects would create workspace ${prefix}one-w on branch ${prefix}one (1 machine start), 1 turn, 1 terminal, 1 file`,
      `projects would commit and push branch ${prefix}one to ${repositories.one}, open 1 draft pull request, close it unmerged, delete the branch`,
      `projects would stop, wake (1 start), archive, open (1 start) and delete ${prefix}one-w`,
      `projects would create project ${prefix}two (${repositories.one} and ${two}) and wait for its copy (1 machine)`,
      `projects would seed the account's environment for ${repositories.one} and ${two} with one file .env each, only if both are at revision 0` +
        " (or empty and this run's own) and both repositories ignore .env, else skip it as environment_exists or path_not_ignored; cleared after the stage and by cleanup",
      `projects would create workspace ${prefix}two-w on branch ${prefix}two (1 machine start), push ${prefix}two to ${two}, open and close 1 draft pull request`,
      `projects would run 2 turns writing 1 file in each repository and rewind the second, then delete ${prefix}two-w and both projects`,
      "projects would read cloud_v2_ready_copy_forks and cloud_v2_ready_copies through one temporary pg_read_all_data role, deleted at the end of the stage; no postgres role",
    ],
    personal: [
      `personal would create project ${prefix}p (Only you, ${repositories.one}) and its copy (1 machine), and workspace ${prefix}p-w (1 machine start)`,
      "personal would read, as the second test user, the workspace, the project, the project list, the workspace list and the by-number address: each must be 404 or absent",
      "personal would end the account's Pro through manage-account-pro.ts (1 operator change), check 403 pro_required on the workspace and its connect," +
        " and wait up to 35 minutes for the machine to stop (the minutes are reported)",
      "personal would put Pro back (1 operator change), open the workspace (1 machine start), then delete the workspace and the project",
    ],
    // A proposal for the owner: what lets a test user run A and C without the owner's account in the stages themselves.
    setup: owner === "personal" ? [
      "setup would give the selected test user Individual Pro for a day through manage-account-pro.ts (plan, execute, read back; actor the one active platform owner)," +
        " recording the grant before it; cleanup puts that grant back (or ends Pro when there was none)",
      "setup would connect the test user's own GitHub sign-in in its Personal organization by token (action pat, ZEROS_REHEARSAL_GITHUB_TOKEN, fixture repositories only);" +
        " never over a sign-in it did not make; cleanup disconnects it",
      "setup presses no Build: it reads the Personal organization's base (ready, preparing, failed, unavailable or none). Zeros prepares it at the first" +
        " project (1 builder machine from Boat's stock image, or none with a shared base), and every stage's first create waits until it is ready",
      "cleanup removes the base the run caused (the organization's, automatic, newer than the run's start): its live pointer and its own Boat named" +
        " snapshot (never the shared one), unless --keep-base",
    ] : [
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
      `retention runs ${where}`,
      `retention would create project ${prefix}ret (${repositories.one} and ${two}) and its copy (1 machine)`,
      `retention would seed the account's environment for ${repositories.one} with .env under the same rule as projects (noted as environment_case:seeded_edited` +
        " or hand_made_ignored), cleared after the stage and by cleanup",
      `retention would create workspaces ${prefix}ret-w and ${prefix}ret-k (2 machine starts); in ${prefix}ret-w one unpushed commit and one untracked file in ${two},` +
        ` and in ${repositories.one} either the seeded .env edited by hand or a hand-made ignored file`,
      "retention would stop both, then shift their clocks 4 times (1 hour, 10.6, 31 and 10.6 days) and once more for the removal (61 days), each through its own" +
        " temporary postgres role deleted when the shift commits; reads go through one pg_read_all_data role",
      "retention would set Keep on then off on one workspace",
      "retention would rebuild the Cloud Computer once (1 builder machine) before the opens, and wait for the replaced build's snapshot to be cleaned up:" +
        " the clean workspace's open must then rebuild from the live build",
      "retention would delete both workspaces' machines on Boat, then open both (2 starts), then delete both workspaces and the project",
      "retention would, when S4 is deployed, stop and archive one workspace again and wait for its backup's removal",
    ],
    submodules: [
      `submodules would create project ${prefix}sub (Only you, R3 with fetch submodules on) and its copy (1 machine); the copy's record must show both submodules fetched, as public`,
      `submodules would create workspace ${prefix}sub-w (1 machine start), forked from the copy, fetching both public submodules itself, and read git submodule status:` +
        " both initialized at their gitlink commits",
      "submodules needs R3 (--submodule-repository) and the Withso fixture that is one of its submodules (--submodule-fixture-repository), both existing",
    ],
    waiting: [
      "waiting runs in a second, fresh Personal organization: --waiting-account (test user 3 by default), whose organization has no base and nothing building",
      "waiting would give that account Individual Pro and connect its own GitHub sign-in by token, as setup does; cleanup puts both back",
      "waiting would set that organization's install script to one line (echo zeros-rehearsal-waiting) when it has none, so it builds its own base" +
        " instead of riding the shared one; cleanup removes it",
      `waiting would create project ${prefix}wait (Only you, ${repositories.one}): Zeros queues the organization's automatic base (1 builder machine)`,
      `waiting would at once create workspace ${prefix}wait-w (1 machine start): it must answer creating, document field preparing: computer, bound to that base`,
      "waiting would wait for the base to be ready, then for the workspace to be running from it (the wait in seconds, and whether it passed the" +
        " 10-minute boot deadline, are reported), then delete the workspace and the project; cleanup removes that base unless --keep-base",
    ],

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

/** The one active platform owner whose id starts with `prefix` (8 hex characters): the Pro operator's actor. */
export async function proActor(database: Database, prefix: string | undefined): Promise<{ state: PersonalReadiness["proActor"]; id?: string }> {
  if (!prefix || !/^[0-9a-f]{8}$/.test(prefix)) return { state: "none" };
  const rows = await database.read(`SELECT id::text AS id FROM users WHERE staff_role = 'platform_owner' AND auth_status = 'active' AND deleted_at IS NULL
    AND left(id::text, 8) = $1`, [prefix]);
  return rows.length === 1 ? { state: "resolved", id: String(rows[0]!.id) } : { state: rows.length ? "ambiguous" : "none" };
}

/** Why a member's projects read can answer 404, as booleans: the probe organization's state and the member's. */
export async function probeDiagnostics(database: Database, organizationId: string, userId: string): Promise<Record<string, boolean>> {
  const rows = await database.read(`SELECT o.deleted_at IS NULL AS organization_present, o.lifecycle_status = 'active' AS organization_active,
      (o.is_personal OR o.cloud_workspaces_allowed) AS cloud_allowed, m.user_id IS NOT NULL AS member, (u.auth_status = 'active' AND u.deleted_at IS NULL) AS user_active
    FROM organizations o LEFT JOIN organization_members m ON m.org_id = o.id AND m.user_id = $2::uuid LEFT JOIN users u ON u.id = $2::uuid
    WHERE o.id = $1::uuid`, [organizationId, userId]);
  const row = rows[0] ?? {};
  return Object.fromEntries(["organization_present", "organization_active", "cloud_allowed", "member", "user_active"].map(key => [key, row[key] === true]));
}

/** What --plan could observe for the preconditions: each null when it could not be read. */
export type PreconditionFacts = {
  release: { sourceSha: string; workerSha256: string } | null;
  /** The active runtime's capability record in the rehearsal's R2 bucket (cloud-v2/runtime/capabilities/<sha>.json). */
  runtime: { found: boolean; actingUser: boolean; syncContext: boolean } | null;
  /** The selected account's Personal organization's projects read: 200, or its closed 404 code. */
  projectsRead: string | null;
  /** Its Cloud Computer's base as the overview reports it (#1260: ready, preparing, failed, unavailable, none), "absent"
   * from a server before #1260, or the read's closed code (404 while cloud is off for it). */
  computer: string | null;
  /** Organizations whose live build is the shared base: evidence that CLOUD_V2_SHARED_BASE_SNAPSHOT is configured (the
   * variable is Railway's and not read). Null when unread. */
  sharedBaseInUse: number | null;
  /** The shared base for the pinned runtime (cloud_v2_shared_bases, 0268): absent before that migration; its state, whether
   * Boat has it, and which organizations ride which shared base. Null when unread. */
  sharedBase?: { table: false } | { table: true; pinned: { name: string; state: string } | null; atBoat: boolean | null;
    perName: { name: string; organizations: number }[]; ownBases: number } | null;
};

/** The preconditions block: what each switch needs and what is unset on Alpha, checked live where it can be. */
export function preconditionLines(facts: PreconditionFacts): string[] {
  const yes = (value: boolean) => value ? "yes" : "no";
  const shared = facts.sharedBase;
  const lines = [
    "preconditions:",
    // First: the switch must not go on before the shared base for the pinned runtime is ready, or every organization
    // without an install script would start its own build in the first minute.
    `  shared base for the pinned runtime: ${shared === undefined || shared === null ? "unread" : !shared.table ? "not built (no cloud_v2_shared_bases table: the server predates the shared base)"
      : !shared.pinned ? "none for this runtime yet: do not turn ready copies on" : `${shared.pinned.name} ${shared.pinned.state}${shared.pinned.state === "ready" ? "" : ": do not turn ready copies on"},` +
        ` at Boat ${shared.atBoat === null ? "unread" : shared.atBoat ? "yes" : "no"}`}`,
    ...(shared && shared.table ? [`  organizations per shared base: ${shared.perName.length ? shared.perName.map(row => `${row.name} ${row.organizations}`).join(", ") : "none"};` +
      ` organizations on their own base: ${shared.ownBases}`] : []),
    `  release: ${facts.release ? `alpha source ${facts.release.sourceSha.slice(0, 12)}, active runtime ${facts.release.workerSha256.slice(0, 12)}` : "unreadable"}`,
    facts.runtime === null ? "  runtime qualification: unreadable (R2 read failed)"
      : !facts.runtime.found ? "  runtime qualification: no capability record for the active runtime in ZEROS_R2_ALPHA_BUCKET (it may not be Alpha's runtime store; checkpoints live there too)"
        : `  runtime qualification: capability record found (so ZEROS_R2_ALPHA_BUCKET is Alpha's runtime store, where checkpoints also live); acting-user-v1 ${yes(facts.runtime.actingUser)},` +
          ` sync-context-v1 ${yes(facts.runtime.syncContext)}; the release receipt (CLOUD_V2_RUNTIME_RELEASE) is Railway's and not checked`,
    `  projects routes: ${facts.projectsRead === null ? "unread" : facts.projectsRead === "200" ? "mounted (CLOUD_V2_READY_COPIES_ENABLED on)"
      : facts.projectsRead.endsWith(":route_or_resource") ? "not mounted (CLOUD_V2_READY_COPIES_ENABLED off)"
        : facts.projectsRead.endsWith(":organization") ? "mounted, but the Personal organization has no cloud (CLOUD_V2_PERSONAL_CLOUD_ENABLED off, or no Pro yet)" : facts.projectsRead}`,
    `  Personal organization's base: ${facts.computer === null ? "unread" : facts.computer === "absent" ? "not reported: the server predates the safe switch-on (#1260); setup refuses"
      : ["ready", "preparing", "failed", "unavailable", "none"].includes(facts.computer) ? facts.computer
        : `not readable yet (${facts.computer}): it has no cloud before setup's Pro and the personal switch`}`,
    `  shared base: ${facts.sharedBaseInUse === null ? "unread" : facts.sharedBaseInUse > 0 ? `in use by ${facts.sharedBaseInUse} organization(s), so configured`
      : "in use by no organization (CLOUD_V2_SHARED_BASE_SNAPSHOT likely unset; the variable itself is Railway's and not read)"}`,
    "  base (#1260): nobody presses Build. A project (or a create) makes Zeros prepare the organization's automatic base: with no install script and the",
    "    shared base at Boat, at once with no machine; otherwise one builder machine from Boat's stock image (4 an hour and 30 a day across Alpha, and a",
    "    base a create waits on goes first). A create made meanwhile waits for it (document field preparing: computer); 409 cloud_computer_preparing, or",
    "    cloud_computer_preparation_failed during a failed base's backoff (15 minutes, doubling, at most 6 hours); a waiting create stopped: cloud_create_stopped;",
    "    archived or its creator's cloud gone meanwhile: cloud_create_archived, cloud_creator_access_lost",
    "  unset on Alpha, and what that means here:",
    "    CLOUD_V2_SHARED_BASE_SNAPSHOT: each organization's base takes one builder machine; the rehearsal checks nothing that depends on the shared snapshot",
    "    CLOUD_V2_CHECKPOINT_RETRY_ENABLED: nothing for retention; retention runs the checkpoint retry scan itself (lifecycle.ts: checkpointRetry || retention)",
    "    CLOUD_V2_ASYNC_CREATE_ENABLED: unset means on (creates return before their GitHub checks)",
    "    CLOUD_V2_RETENTION_BACKUP_FORKS_PER_HOUR: default 20; CLOUD_V2_RETENTION_MAINTENANCE_PER_HOUR and _PER_DAY: defaults 20 and 120",
    "  set for the run, in one Railway change after no release is running (one redeploy):",
    "    CLOUD_V2_READY_COPIES_ENABLED=true, CLOUD_V2_PERSONAL_CLOUD_ENABLED=true, CLOUD_V2_RETENTION_ENABLED=true",
    "  while on, Alpha-wide: retention starts for every Alpha workspace (a dirty stop takes a backup fork after an hour, its object in R2);",
    "    every Pro user's Personal organization gets cloud; Cloud Computer builds are base only",
    "  to put Alpha back: unset the same three in one change; left behind by design: retention stamps, backups and checkpoint objects of other",
    "    workspaces stopped while it was on (nothing removes them with retention off); the run's own resources are removed by --cleanup",
  ];
  return lines.map(safeLine);
}

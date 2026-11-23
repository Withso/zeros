// `pnpm alpha:rehearse <stage|all> [--plan] [--cleanup] [--run <id>] [--owner personal|organization] [--account <n>] [--other <n>]
//   [--pro-actor <8 hex>] [--switches projects,personal,retention]`
// The live Alpha rehearsal of Projects, Personal cloud, Retention and Submodules. Read
// agents/zstack/playbooks/alpha-operator.md first. Alpha only, test accounts and fixture repositories only.
// Credentials are read in memory from .env.agent (repository root) and the private zeros-dev profile, never printed.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { z } from "zod";
import { gate0SignIn } from "../gate0-cli.js";
import { RehearsalFailure, STAGE_NEEDS_ACCOUNT, STAGES, type Api, type Database, type OwnerKind, type Ports, type StageName, type Switch } from "./contract.js";
import { diagnose, signInAccount, signInAll, type Account, type SignedIn, type SignInDeps } from "./accounts.js";
import { assertRepository, safeLine } from "./guard.js";
import { ALPHA_TARGET, localDatabase, localStaffOrganization, localStaffRole, type DatabaseClient, type LiveDatabase, AGENT_CREDENTIAL_SOURCES, agentCredentialsFromEnv, checkGithubToken, tokenLines, liveApi, liveBoat, liveBridge, liveClock, liveDatabase, liveGithub, liveGithubSignIn, liveGithubToken, livePro, liveRelease, liveStorage,
  tokenRefusal, liveReleaseIdentity, liveRuntimeQualification } from "./live.js";
import { errorCode } from "./steps.js";
import { accountLines, turnLine, PERSONAL_ROUTE_GAPS, preconditionLines, type PreconditionFacts, platformOwners, probeDiagnostics, proActor, readAccount, refusal, resolveProbe, writeLines,
  type AccountSummary } from "./plan.js";
import { cleanup, cleanupNeedsAccount, DEFAULT_RUN_CAP, inventoryLines, NO_ACCOUNT, runStages, stageContext } from "./runner.js";
import { FIXTURE_TWO } from "./stage-provision.js";
import { loadState, newState, saveState, stateTarget } from "./state.js";
import { launcherModules, localStack, type LocalStack } from "./local-stack.js";

export const USAGE = "alpha:rehearse <provision|setup|projects|personal|retention|submodules|waiting|all> [--local] [--plan] [--cleanup] [--run <id>] " +
  "[--owner personal|organization (default personal)] [--account owner|1..10 (default 2)] [--other 1..10 (default the next configured)] " +
  "[--waiting-account 1..10 (default 3)] " +
  "[--pro-actor <first 8 hex of the platform owner>] [--switches projects,personal,retention] --repository owner/name (R1, required unless ZEROS_REHEARSAL_REPOSITORY is set) " +
  "[--repository-two owner/name (default Withso/zeros-dev-fixture-2)] [--submodule-repository owner/name] [--submodule-fixture-repository owner/name] [--keep-base] [--max-active <n>] [--organization <slug|id>]";
/** `all` runs these in order on each route; D is refused until written. */
export const ALL: Record<OwnerKind, readonly StageName[]> = {
  personal: ["provision", "setup", "projects", "personal", "retention", "submodules", "waiting"], organization: ["provision", "setup", "projects", "retention"],
};
export const TIMING = { pollMs: 5_000, stateMs: 15 * 60_000, copyMs: 30 * 60_000, turnMs: 10 * 60_000, scanMs: 5 * 60_000, archiveScanMs: 65 * 60_000,
  idleStopMs: 35 * 60_000, computerMs: 45 * 60_000 };

export type Arguments = {
  stages: StageName[]; plan: boolean; cleanup: boolean; run?: string;
  /** The Dev stack this checkout runs (pnpm electron:cloud) instead of Alpha. */
  local: boolean; owner: OwnerKind; account: "owner" | number; other?: number; proActor?: string;
  /** Stage waiting's account: its own fresh Personal organization. */
  waitingAccount: number;
  switches: Set<Switch>;
  repository?: string; repositoryTwo?: string; submoduleRepository?: string; submoduleFixtureRepository?: string; keepBase: boolean; maxActive: number; organization?: string;
};
export function parseArguments(argv: string[]): Arguments {
  // Private files: .env.agent at the repository root and the zeros-dev profile, both mode 0600; the profile is reached by
  // ZEROS_DEV_PROFILE_PATH (its loader refuses group- or world-readable files and does not follow a symlink).
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    plan: { type: "boolean" }, cleanup: { type: "boolean" }, run: { type: "string" }, local: { type: "boolean" }, account: { type: "string" }, switches: { type: "string" },
    repository: { type: "string" }, "repository-two": { type: "string" }, "keep-base": { type: "boolean" }, "max-active": { type: "string" },
    organization: { type: "string" }, owner: { type: "string" }, "submodule-repository": { type: "string" }, "submodule-fixture-repository": { type: "string" }, other: { type: "string" }, "pro-actor": { type: "string" }, help: { type: "boolean" },
    "waiting-account": { type: "string" },
  } });
  const owner = (values.owner ?? "personal") as OwnerKind;
  if (!["personal", "organization"].includes(owner)) throw new RehearsalFailure("usage", "owner");
  if (values.help || positionals.length !== 1) throw new RehearsalFailure("usage", "usage");
  const stage = positionals[0]!;
  const stages = stage === "all" ? [...ALL[owner]] : (STAGES as readonly string[]).includes(stage) ? [stage as StageName] : null;
  if (!stages) throw new RehearsalFailure("usage", "stage");
  if (values.plan && values.cleanup) throw new RehearsalFailure("usage", "plan_and_cleanup");
  if (values.cleanup && !values.run) throw new RehearsalFailure("usage", "cleanup_needs_run");
  const account = values.account === "owner" ? "owner" as const : Number(values.account ?? 2);
  if (account !== "owner" && !(Number.isInteger(account) && account >= 1 && account <= 10)) throw new RehearsalFailure("usage", "account");
  const other = values.other === undefined ? undefined : Number(values.other);
  if (other !== undefined && !(Number.isInteger(other) && other >= 1 && other <= 10 && other !== account)) throw new RehearsalFailure("usage", "other");
  if (values["pro-actor"] !== undefined && !/^[0-9a-f]{8}$/.test(values["pro-actor"])) throw new RehearsalFailure("usage", "pro_actor");
  const waitingAccount = Number(values["waiting-account"] ?? (account === 3 ? 4 : 3));
  if (!(Number.isInteger(waitingAccount) && waitingAccount >= 1 && waitingAccount <= 10 && waitingAccount !== account)) throw new RehearsalFailure("usage", "waiting_account");
  const switches = new Set<Switch>();
  for (const name of (values.switches ?? "").split(",").filter(Boolean)) {
    if (!["projects", "personal", "retention"].includes(name)) throw new RehearsalFailure("usage", "switch");
    switches.add(name as Switch);
  }
  const maxActive = values["max-active"] === undefined ? 10 : Number(values["max-active"]);
  if (!(Number.isInteger(maxActive) && maxActive >= 0 && maxActive <= 50)) throw new RehearsalFailure("usage", "max_active");
  return { stages, plan: !!values.plan, cleanup: !!values.cleanup, local: !!values.local, ...(values.run ? { run: values.run } : {}), owner, account, waitingAccount,
    ...(other !== undefined ? { other } : {}), ...(values["pro-actor"] ? { proActor: values["pro-actor"] } : {}), switches,
    ...(values.repository ? { repository: assertRepository(values.repository) } : {}),
    ...(values["repository-two"] ? { repositoryTwo: assertRepository(values["repository-two"]) } : {}),
    ...(values["submodule-repository"] ? { submoduleRepository: assertRepository(values["submodule-repository"]) } : {}),
    ...(values["submodule-fixture-repository"] ? { submoduleFixtureRepository: assertRepository(values["submodule-fixture-repository"]) } : {}),
    keepBase: !!values["keep-base"], maxActive, ...(values.organization ? { organization: values.organization } : {}) };
}

const Profile = z.object({
  workos: z.object({ environment: z.literal("alpha"), webClientId: z.string().regex(/^client_[A-Za-z0-9_-]+$/), apiKey: z.string().min(16) }).passthrough(),
  boat: z.object({ apiKey: z.string().min(16), billingOrg: z.string().optional(), secondsPerDollar: z.number().positive().optional() }).passthrough(),
  fixture: z.object({ workosUserId: z.string(), expectedEmail: z.string().email(), workosOrganizationId: z.string().optional() }).passthrough(),
}).passthrough();

async function main(argv: string[]): Promise<number> {
  const log = (line: string) => console.log(`[rehearse] ${safeLine(line)}`);
  let args: Arguments;
  try { args = parseArguments(argv); } catch { console.log(USAGE); return 2; }
  const root = resolve(import.meta.dirname, "../../../../..");
  let profile: z.infer<typeof Profile>, env: NodeJS.Dict<string>;
  // The profile loader refuses a file readable by group or others and opens it without following a symlink: keep both
  // private files at mode 0600 and point ZEROS_DEV_PROFILE_PATH at the profile itself.
  try { profile = Profile.parse((await import(pathToFileURL(resolve(root, "scripts/dev-environment/profile.mjs")).href)).loadProfile(undefined, { root, env: process.env })); }
  catch { log("failed private_configuration profile (mode 0600, reached by ZEROS_DEV_PROFILE_PATH, not a symlink)"); return 1; }
  try { env = parseEnv(readFileSync(resolve(root, ".env.agent"), "utf8")); } catch { log("failed private_configuration env_agent"); return 1; }
  const need = (name: string) => { const value = env[name]?.trim(); if (!value) throw new RehearsalFailure("configuration", name.toLowerCase()); return value; };

  const accounts: Account[] = [];
  if (env.ZEROS_DEV_PASSWORD) accounts.push({ label: "owner", email: profile.fixture.expectedEmail, password: env.ZEROS_DEV_PASSWORD,
    subject: profile.fixture.workosUserId, ...(profile.fixture.workosOrganizationId ? { organizationId: profile.fixture.workosOrganizationId } : {}) });
  for (let n = 1; n <= 10; n++) {
    const password = env[`ZEROS_TEST_USER_${n}_PASSWORD`];
    if (password) accounts.push({ label: String(n), email: `user-${n}@zeros.build`, password });
  }
  // --local: this checkout's running Dev stack, read from the launcher's own state; never Railway, PlanetScale or Alpha.
  let stack: LocalStack | undefined;
  if (args.local) {
    try { stack = localStack(await launcherModules(root, process.env)); }
    catch (error) { log(`failed ${error instanceof RehearsalFailure ? `${error.step} ${error.code}` : "local_stack unreadable"}`); return 1; }
    log(`target: local Dev stack ${stack.target.origin}; switches it runs with: ${Object.keys(stack.started).sort().join(", ") || "none"}`);
    if (args.switches.size) log("--switches is ignored with --local: the running stack's own switches are used");
    args.switches = stack.switches;
  }
  const { target, database, storageConfig } = targetPorts(stack, need);
  // A fresh Dev stack has no probe organization: the Personal route does not need one.
  const NO_PROBE = { id: "00000000-0000-0000-0000-000000000000", workosOrganizationId: null };
  const findProbe = async (reads: Database) => probeSelector ? resolveProbe(reads, probeSelector) : NO_PROBE;
  const probeSelector = args.organization ?? env.ZEROS_ALPHA_PROBE_ORGANIZATION;
  const one = args.repository ?? (env.ZEROS_REHEARSAL_REPOSITORY ? assertRepository(env.ZEROS_REHEARSAL_REPOSITORY) : undefined);
  const two = args.repositoryTwo ?? (env.ZEROS_REHEARSAL_REPOSITORY_2 ? assertRepository(env.ZEROS_REHEARSAL_REPOSITORY_2) : FIXTURE_TWO);
  const githubToken = env.ZEROS_REHEARSAL_GITHUB_TOKEN?.trim();
  // The rehearsal's agent credentials for the turns, every one set (none: the turns are skipped and counted).
  const agentCredentials = agentCredentialsFromEnv(env);
  // The fixtures' reads and clean-up (exists, branches, pull requests, branch deletion): the token when set, so the
  // Personal route does not depend on the App's selected repositories; the App otherwise.
  const fixtureGithub = () => githubToken ? liveGithubToken(githubToken, "Withso")
    : liveGithub({ appId: Number(need("ZEROS_GITHUB_ALPHA_APP_ID")), privateKey: Buffer.from(need("ZEROS_GITHUB_ALPHA_APP_PRIVATE_KEY_B64"), "base64").toString("utf8"), owner: "Withso" });
  const signInDeps = (probe: { workosOrganizationId: string | null }): SignInDeps => ({
    subject: email => workosSubject(profile.workos.apiKey, email),
    signIn: input => gate0SignIn({ clientId: profile.workos.webClientId, apiKey: profile.workos.apiKey, ...input }),
    api: session => liveApi(session.accessToken, fetch, target), sleep: liveClock.sleep,
    ...(probe.workosOrganizationId ? { probeWorkosOrganization: probe.workosOrganizationId } : {}),
  });

  const token = githubToken;
  const personalOf = (signed: SignedIn) => signed.organizations.find(org => org.personal && org.role === "owner");

  try {
    if (!one) throw new RehearsalFailure("configuration", "repository_one");
    if (!probeSelector && !(stack && args.owner === "personal")) throw new RehearsalFailure("configuration", "probe_organization");
    if (!await liveRelease(fetch, target)) throw new RehearsalFailure("release_identity", "not_ready");

    if (args.plan) {
      log("plan: reads only; each account signs in (one session, revoked at the end; 3 s apart, a throttled step retried after 5, 15 and 45 s)," +
        " and one temporary database role inheriting only pg_read_all_data is minted for reads and deleted");
      log(`route: ${args.owner === "personal" ? "personal (the selected test user's Personal organization)" : "organization (the probe organization)"}`);
      // The token first, before any other read: its kind, everything it reaches, and its write access on each fixture.
      const fixtures = [one, two, args.submoduleRepository, args.submoduleFixtureRepository].filter((name): name is string => !!name);
      let tokenState: string | null = githubToken ? null : "absent";
      if (githubToken) {
        try {
          const checked = await checkGithubToken(githubToken, fixtures);
          for (const line of tokenLines(checked, fixtures)) log(line);
          tokenState = tokenRefusal(checked, fixtures);
        } catch (error) { const failed = diagnose(error, "github_token"); tokenState = `${failed.step}:${failed.code}`; }
      }
      log(`github token: ${tokenState === null ? "accepted" : tokenState === "absent" ? "absent" : `refused ${tokenState}`}`);
      log(`fixture reads and clean-up (exists, branches, pull requests, branch deletion): ${githubToken ? "the token" : "the GitHub App (its selected repositories only)"}`);
      log("pushes and pull requests: the test user's own GitHub sign-in by that token (stage setup); stage D's builds fetch public submodules with no credential");
      const reads = database(randomUUID().replace(/-/g, ""));
      try {
        const probe = await findProbe(reads);
        log(`probe organization: found; WorkOS organization ${probe.workosOrganizationId ? "linked" : "not linked"}`);
        const ids = await platformOwners(reads);
        log(`platform owners (active): ${ids.length}${ids.length ? ` ${ids.join(" ")}` : ""}`);
        const actor = await proActor(reads, args.proActor);
        log(`pro actor (--pro-actor): ${actor.state}; github token (ZEROS_REHEARSAL_GITHUB_TOKEN): ${token ? "configured" : "absent"}`);
        const summaries = new Map<string, AccountSummary | { failed: string }>();
      const facts: PreconditionFacts = { release: await liveReleaseIdentity(fetch, target), runtime: null, projectsRead: null, computer: null, sharedBaseInUse: null };
      let waitingAccount = "account_not_configured";
      if (facts.release) facts.runtime = await liveRuntimeQualification(storageConfig(), facts.release.workerSha256).catch(() => null);
        for (const result of await signInAll(accounts, signInDeps(probe))) {
          if (!result.ok) {
            log(`account ${result.label}: failed ${result.step} ${result.code}`); summaries.set(result.label, { failed: `${result.step}:${result.code}` });
            if (result.label === String(args.waitingAccount)) waitingAccount = `account_unavailable:${result.step}:${result.code}`;
            continue;
          }
          try {
            const summary = await readAccount(result.api, result.label, probe.id, "Withso");
            if (result.label === String(args.account) && summary.personal) {
              const base = `/v1/cloud-v2/organizations/${summary.personal.id}`;
              const projects = await result.api.json("GET", `${base}/cloud-projects`);
              facts.projectsRead = projects.status === 200 ? "200" : errorCode(projects);
              facts.computer = await baseOf(result.api, summary.personal.id);
            }
            // Stage waiting's account: its Personal organization must have no base and nothing building.
            if (result.label === String(args.waitingAccount)) {
              const state = summary.personal ? await baseOf(result.api, summary.personal.id) : null;
              // Before its Pro (which stage waiting grants first) its Personal organization has no cloud, so its base reads 404
              // organization: not a refusal; the stage checks it is fresh after the grant.
              const beforePro = !!state && state.startsWith("http_404") && state.endsWith(":organization");
              waitingAccount = !summary.personal ? "no_personal_organization" : state === "none" || beforePro ? "fresh" : `base_${state}`;
              if (beforePro) log(`  waiting account ${args.waitingAccount}: no cloud before its Pro; stage waiting checks its base is fresh after granting it`);
            }
            summaries.set(result.label, summary);
            for (const line of accountLines(summary)) log(line);
            log(`  workos organization chosen at sign-in: ${result.selected}`);
          } catch (error) {
            const failed = diagnose(error, "account_read");
            log(`account ${result.label}: failed ${failed.step} ${failed.code}`);
            // Why a member's projects read answers 404, from the database: booleans only.
            if (failed.code.startsWith("http_404")) {
              try {
                const facts = await probeDiagnostics(reads, probe.id, result.userId);
                log(`  probe organization facts: ${Object.entries(facts).map(([key, value]) => `${key} ${value ? "yes" : "no"}`).join(", ")}`);
              } catch (factsError) {
                const unavailable = diagnose(factsError, "probe_facts");
                log(`  probe organization facts: unavailable ${unavailable.step} ${unavailable.code}`);
              }
            }
            summaries.set(result.label, { failed: `${failed.step}:${failed.code}` });
          } finally { await result.session.close().catch(() => log(`account ${result.label}: sign-out failed`)); }
        }
        const selected = summaries.get(String(args.account)) ?? { failed: "account:not_configured" };
        const otherLabel = String(args.other ?? accounts.find(row => row.label !== "owner" && row.label !== String(args.account))?.label ?? "none");
        log(`selected account ${args.account}; second account ${otherLabel}; waiting account ${args.waitingAccount} (${waitingAccount}); repositories R1 ${one}, R2 ${two}`);
        log(agentCredentials.length ? `agent credentials: ${agentCredentials.map(entry => `${entry.source} (${entry.kind})`).join(", ")}; setup connects each for account ${args.account} in its Personal organization, cleanup removes each`
          : `agent credentials: none (set any of ${AGENT_CREDENTIAL_SOURCES.map(source => source.name).join(", ")} in .env.agent)`);
        if (args.stages.includes("projects")) log(turnLine(selected, args.owner, String(args.account), args.owner === "personal" ? agentCredentials.map(entry => entry.provider) : []));
        facts.sharedBaseInUse = await reads.read(`SELECT count(*)::int AS n FROM cloud_v2_computers c
          JOIN cloud_v2_computer_builds b ON b.id = c.active_build_id AND b.org_id = c.org_id WHERE b.base_shared`).then(rows => Number(rows[0]?.n ?? 0), () => null);
        facts.sharedBase = await sharedBaseFacts(reads, facts.release?.workerSha256 ?? null,
          name => liveBoat({ apiKey: profile.boat.apiKey, ...(profile.boat.billingOrg ? { billingOrg: profile.boat.billingOrg } : {}) }).snapshotExists(name)).catch(() => null);
        if (args.account === "owner") log("note: the owner's own account; the run asserts its entitlement, sessions and settings are unchanged");
        // Stage D's fixtures, read through the run's fixture identity (a repository read; nothing is written).
        const named = args.submoduleRepository && args.submoduleFixtureRepository ? [args.submoduleRepository, args.submoduleFixtureRepository] : null;
        let submoduleFixtures: "present" | "missing" | "not_named" = "not_named";
        if (named) {
          const github = fixtureGithub();
          submoduleFixtures = (await Promise.all(named.map(repository => github.repositoryExists(repository).catch(() => false)))).every(Boolean) ? "present" : "missing";
        }
        log(`submodule fixtures: ${submoduleFixtures}`);
        const readiness = { token: !!token, ...(tokenState && tokenState !== "absent" ? { tokenRefusal: tokenState } : {}), proActor: actor.state, submoduleFixtures, waitingAccount };
        for (const stage of [...new Set<StageName>(["setup", ...args.stages])]) {
          const refused = refusal(stage, selected, args.switches, args.owner, readiness);
          log(`stage ${stage}: ${refused ? `refused ${refused}` : "would run"}`);
          for (const line of writeLines(stage, "zr-<run>-", { one, two }, args.owner)) log(`  ${line}`);
        }
        for (const line of preconditionLines(facts)) log(line);
        if (args.owner === "personal") for (const line of PERSONAL_ROUTE_GAPS) log(line);
      } finally { await reads.close().catch(() => log("plan database role: delete unconfirmed")); }
      return 0;
    }

    // A run: the probe organization and the Pro actor from the database, then sign-ins only when a selected stage needs them.
    const startReads = database(randomUUID().replace(/-/g, ""));
    let probe: { id: string; workosOrganizationId: string | null }, actor: Awaited<ReturnType<typeof proActor>>;
    try { probe = await findProbe(startReads); actor = await proActor(startReads, args.proActor); }
    finally { await startReads.close().catch(() => log("database role: delete unconfirmed")); }
    // A fresh Dev stack's database has no platform owner until one is granted; the Pro steps then refuse, named.
    if (stack && !actor.id) log(`pro actor: ${actor.state} in the Dev stack's database (needs --pro-actor <first 8 hex of an active platform owner there>;` +
      " a fresh stack has none until an operator grants one, and the Pro steps of setup, personal and waiting refuse without it)");
    let state = args.run ? await loadState(args.run) : undefined;
    // A state file belongs to the target it ran on: a cleanup or a resume on the other one is refused.
    if (state && stateTarget(state) !== target.kind) throw new RehearsalFailure("state", `other_target:${stateTarget(state)}`);
    const owner = state?.owner ?? args.owner;
    const needsAccount = args.cleanup ? !!state && cleanupNeedsAccount(state) : args.stages.some(stage => STAGE_NEEDS_ACCOUNT[stage]);
    let held: SignedIn | undefined, other: SignedIn | undefined, accountUnavailable: string | undefined;
    const sessions: SignedIn[] = [];
    try {
      if (needsAccount) {
        const account = accounts.find(row => row.label === String(args.account));
        const result = account ? await signInAccount(account, signInDeps(probe)) : { ok: false as const, label: String(args.account), step: "account", code: "not_configured" };
        if (result.ok) sessions.push(result);
        if (!result.ok) accountUnavailable = `${result.step}:${result.code}`;
        else if (owner === "organization" && !result.organizations.some(org => org.id === probe.id)) accountUnavailable = "probe_organization:not_a_member";
        else if (owner === "personal" && !personalOf(result)) accountUnavailable = "personal_organization:none";
        else held = result;
        if (accountUnavailable) log(`account ${args.account}: unavailable ${accountUnavailable}`);
        if (args.cleanup && !held) throw new RehearsalFailure("cleanup", "account_required");
      }
      // The owner organization: the selected account's Personal organization, or the probe organization.
      const organizationId = owner === "personal" ? (held ? personalOf(held)!.id : state?.organizationId ?? probe.id) : probe.id;
      if (state && state.organizationId !== organizationId) {
        // A provision-only state may move to the account's organization; anything else is refused.
        if (cleanupNeedsAccount(state)) throw new RehearsalFailure("state", "organization");
        state.organizationId = organizationId; state.organizations = [organizationId];
      }
      state ??= newState(randomUUID(), organizationId, new Date(), owner, target.kind);
      const run = state;
      await saveState(run);
      log(`run ${run.runId} prefix ${run.prefix} route ${owner}${stack ? " target local" : ""}`);
      // --local: a fresh stack's database has no platform owner, and the Pro operator needs one. The selected account
      // becomes it for this run, as the launcher's own seed makes its fixture account staff: its current role read and
      // recorded first, then changed; cleanup puts that role back last. A run that already did so reuses it.
      if (stack && !actor.id) {
        const grant = run.created.staffGrant;
        if (grant) actor = { state: "resolved", id: grant.userId };
        else if (held && !args.cleanup && owner === "personal" && personalOf(held)) {
          const staffDb = database(run.runId.replace(/-/g, ""));
          try {
            const previous = (await staffDb.read("SELECT staff_role FROM users WHERE id = $1::uuid", [held.userId]))[0]?.staff_role ?? null;
            const owned = (await staffDb.read(`SELECT o.id::text AS id FROM organizations o JOIN organization_members m ON m.org_id = o.id AND m.user_id = $1::uuid
              WHERE m.role = 'owner' AND NOT o.is_personal AND o.deleted_at IS NULL AND o.lifecycle_status = 'active' ORDER BY o.created_at LIMIT 1`, [held.userId]))[0]?.id;
            const record: NonNullable<typeof run.created.staffGrant> = { userId: held.userId, email: held.email, organizationId: typeof owned === "string" ? owned : "",
              previousRole: (previous ?? null) as NonNullable<typeof run.created.staffGrant>["previousRole"] };
            if (!record.organizationId) { record.organizationId = await localStaffOrganization(staffDb, { userId: held.userId, prefix: run.prefix }); record.madeOrganization = true; }
            run.created.staffGrant = record; await saveState(run);
            await localStaffRole(staffDb, record, "platform_owner");
            actor = { state: "resolved", id: held.userId };
            log("local stack: the selected account is its platform owner for this run (the Pro operator's actor); cleanup puts its role back");
          } finally { await staffDb.close().catch(() => undefined); }
        }
      }
      if (held && args.stages.includes("personal") && !args.cleanup) {
        const label = String(args.other ?? accounts.find(row => row.label !== "owner" && row.label !== String(args.account))?.label ?? "");
        const account = accounts.find(row => row.label === label);
        const result = account ? await signInAccount(account, signInDeps(probe)) : undefined;
        if (result?.ok) { sessions.push(result); other = result; } else log(`second account ${label || "none"}: unavailable${result && !result.ok ? ` ${result.step}:${result.code}` : ""}`);
      }
      // Stage waiting's account, signed in for that stage or for a cleanup of what it made.
      let waiting: SignedIn | undefined;
      if (owner === "personal" && (args.cleanup ? !!run.waiting : args.stages.includes("waiting"))) {
        const account = accounts.find(row => row.label === String(args.waitingAccount));
        const result = account ? await signInAccount(account, signInDeps(probe)) : undefined;
        if (result?.ok && personalOf(result)) { sessions.push(result); waiting = result; }
        else {
          if (result?.ok) sessions.push(result);
          log(`waiting account ${args.waitingAccount}: unavailable${result && !result.ok ? ` ${result.step}:${result.code}` : result ? " personal_organization:none" : " not_configured"}`);
        }
        if (waiting && run.waiting && run.waiting.organizationId !== personalOf(waiting)!.id) throw new RehearsalFailure("state", "waiting_organization");
      }
      const api = held?.api ?? NO_ACCOUNT;
      const db = database(run.runId.replace(/-/g, ""));
      const ports: Ports = {
        release: () => liveRelease(fetch, target), api, bridge: liveBridge(api), boat: liveBoat({ apiKey: profile.boat.apiKey,
          ...(profile.boat.billingOrg ? { billingOrg: profile.boat.billingOrg } : {}) }),
        storage: liveStorage(storageConfig(), () => run.created.workspaces),
        github: fixtureGithub(),
        database: db, clock: liveClock,
        ...(other ? { other: other.api } : {}),
        ...(held && owner === "personal" && actor.id ? { pro: livePro(db, { subjectUserId: held.userId, expectedEmail: held.email, actorUserId: actor.id }, target.channel) } : {}),
        ...(held && token ? { githubSignIn: liveGithubSignIn(held.api, token) } : {}),
        ...(held && agentCredentials.length ? { agentCredentials } : {}),
        ...(waiting ? { waiting: { organizationId: personalOf(waiting)!.id, ports: { api: waiting.api, bridge: liveBridge(waiting.api),
          ...(actor.id ? { pro: livePro(db, { subjectUserId: waiting.userId, expectedEmail: waiting.email, actorUserId: actor.id }, target.channel) } : {}),
          ...(token ? { githubSignIn: liveGithubSignIn(waiting.api, token) } : {}) } } } : {}),
      };
      const ctx = stageContext(ports, run, () => saveState(run), { one, two, ...(args.submoduleRepository ? { submodules: args.submoduleRepository } : {}),
        ...(args.submoduleFixtureRepository ? { submoduleFixture: args.submoduleFixtureRepository } : {}) }, TIMING, DEFAULT_RUN_CAP);
      const before = held && args.account === "owner" ? await ownerFingerprint(held.api, organizationId, profile.workos.apiKey, held.subject) : undefined;
      const startedAt = Date.now();
      let passed: boolean;
      if (args.cleanup) {
        const { inventory, failures: cleanupFailures } = await cleanup(ctx, { accountless: !held, keepBase: args.keepBase, log });
        let failures = cleanupFailures;
        // Last, after the Pro grant went back (its actor was this role): the selected account's staff role as it was.
        const grant = run.created.staffGrant;
        if (stack && grant) {
          try {
            await localStaffRole(db, grant, grant.previousRole ?? "none");
            delete run.created.staffGrant; await saveState(run);
            log("cleanup staff role: put back");
          } catch (error) { failures++; log(`cleanup staff_role: ${error instanceof RehearsalFailure ? error.code : "failed"}`); }
          finally { await db.close().catch(() => undefined); }
        }
        if (args.keepBase) log("cloud computer bases the run caused: kept (--keep-base): their build rows, live pointers and Boat named snapshots stay");
        const { lines, clean } = inventoryLines(inventory);
        for (const line of lines) log(line);
        if (failures) log(`cleanup failures ${failures}`);
        passed = clean && failures === 0;
      } else passed = await runStages(ctx, args.stages, { switches: args.switches, maxActive: args.maxActive, runCap: DEFAULT_RUN_CAP, log,
        ...(needsAccount && !held ? { accountUnavailable: accountUnavailable ?? "account:unavailable" } : {}) });
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      log(`machine starts ${run.machineStarts}; wall seconds ${seconds}; clock shifts ${run.shifts}`);
      if (profile.boat.secondsPerDollar) log(`estimated dollars at most ${(run.machineStarts * seconds / profile.boat.secondsPerDollar).toFixed(2)} (every start running the whole time)`);
      if (before && held) {
        const after = await ownerFingerprint(held.api, organizationId, profile.workos.apiKey, held.subject);
        log(`owner account unchanged: ${before === after ? "yes" : "no"}`);
        if (before !== after) passed = false;
      }
      if (!passed && !args.cleanup) log(`next: pnpm alpha:rehearse all --cleanup --run ${run.runId}`);
      return passed ? 0 : 1;
    } finally { for (const session of sessions) await session.session.close().catch(() => log(`account ${session.label}: sign-out failed`)); }
  } catch (error) {
    log(`failed ${error instanceof RehearsalFailure ? `${error.step} ${error.code}` : "unexpected"}`);
    return 1;
  }
}

/** What a run reaches, by target: Alpha's origin, PlanetScale roles and runtime store (each named by `need`), or the local
 * stack's origin, own PostgreSQL and the profile's store. A local target reads nothing through `need` and mints no role. */
export function targetPorts(stack: LocalStack | undefined, need: (name: string) => string, options: { client?: (url: string) => DatabaseClient } = {}) {
  const roleNames = (run: string) => { let n = 0; return (kind: "read" | "write") => `zeros-rehearsal-${run.slice(0, 8)}-${kind}-${++n}-${Date.now().toString(36)}`; };
  return {
    target: stack?.target ?? ALPHA_TARGET,
    database: (run: string): LiveDatabase => stack ? localDatabase({ readUrl: stack.readUrl, ownerUrl: stack.ownerUrl, ...(options.client ? { client: options.client } : {}) })
      : liveDatabase({ organization: need("PLANETSCALE_ORG"), database: need("ZEROS_PLANETSCALE_ALPHA_DATABASE"),
        tokenId: need("PLANETSCALE_SERVICE_TOKEN_ID"), token: need("PLANETSCALE_SERVICE_TOKEN"), roleName: roleNames(run) }),
    storageConfig: () => stack ? stack.storage : { bucket: need("ZEROS_R2_ALPHA_BUCKET"), endpoint: need("ZEROS_R2_ALPHA_ENDPOINT"),
      accessKeyId: need("ZEROS_R2_ALPHA_ACCESS_KEY_ID"), secretAccessKey: need("ZEROS_R2_ALPHA_SECRET_ACCESS_KEY") },
  };
}

/** The shared base for the pinned runtime, read-only: its row (0268), whether Boat has it, and organizations per shared base. */
export async function sharedBaseFacts(reads: Pick<Database, "read">, runtimeSha256: string | null, atBoat: (name: string) => Promise<boolean>):
  Promise<NonNullable<PreconditionFacts["sharedBase"]>> {
  const table = (await reads.read("SELECT to_regclass('public.cloud_v2_shared_bases') IS NOT NULL AS present"))[0]?.present === true;
  if (!table) return { table: false };
  const row = runtimeSha256 ? (await reads.read(`SELECT name, state FROM cloud_v2_shared_bases WHERE runtime_sha256 = $1 AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1`, [runtimeSha256]))[0] : undefined;
  const pinned = row ? { name: String(row.name), state: String(row.state) } : null;
  const perName = (await reads.read(`SELECT split_part(snapshot_name, '@', 1) AS name, count(*)::int AS organizations FROM cloud_v2_computers
    WHERE position('@' in snapshot_name) > 0 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`)).map(entry => ({ name: String(entry.name), organizations: Number(entry.organizations) }));
  const own = Number((await reads.read(`SELECT count(*)::int AS n FROM cloud_v2_computers WHERE snapshot_name IS NOT NULL AND position('@' in snapshot_name) = 0`))[0]?.n ?? 0);
  return { table: true, pinned, atBoat: pinned ? await atBoat(pinned.name).catch(() => null) : null, perName, ownBases: own };
}

/** An organization's base as its Cloud Computer overview reports it (#1260), "absent" before that, or the read's closed code. */
async function baseOf(api: Api, organizationId: string): Promise<string> {
  const reply = await api.json("GET", `/v1/cloud-v2/organizations/${organizationId}/computer`);
  if (reply.status !== 200) return errorCode(reply);
  const parsed = z.object({ base: z.object({ state: z.enum(["ready", "preparing", "failed", "unavailable", "none"]) }).passthrough().optional() }).passthrough().safeParse(reply.body);
  return parsed.success ? parsed.data.base?.state ?? "absent" : "schema";
}

/** The test user's WorkOS subject, read by email with the Alpha WorkOS key. */
async function workosSubject(apiKey: string, email: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`https://api.workos.com/user_management/users?email=${encodeURIComponent(email)}`, { redirect: "error",
      signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${apiKey}` } });
  } catch { throw new RehearsalFailure("subject_lookup", "network"); }
  const body = z.object({ data: z.array(z.object({ id: z.string(), email: z.string() }).passthrough()) }).safeParse(await response.json().catch(() => null));
  const found = body.success ? body.data.data.find(row => row.email.toLowerCase() === email.toLowerCase()) : undefined;
  if (!response.ok) throw new RehearsalFailure("subject_lookup", `http_${response.status}`);
  if (!found) throw new RehearsalFailure("subject_lookup", "not_found");
  return found.id;
}

/** What must not change on the owner's account: Pro, organization roles and seats, the probe organization's personal
 * setting, and the number of WorkOS sessions (this run's own included both times). A digest; nothing is printed. */
export async function ownerFingerprint(api: Api, organizationId: string, workosKey: string, subject: string): Promise<string> {
  const me = z.object({ capabilities: z.object({ pro: z.boolean() }).passthrough(),
    organizations: z.array(z.object({ id: z.string(), role: z.string().nullable().optional(), seat: z.string().optional() }).passthrough()) }).passthrough()
    .safeParse((await api.json("GET", "/v1/me")).body);
  const projects = await api.json("GET", `/v1/cloud-v2/organizations/${organizationId}/cloud-projects`);
  const personal = z.object({ personalAllowed: z.boolean() }).passthrough().safeParse(projects.body);
  let sessions: number | "unread" = "unread";
  try {
    const response = await fetch(`https://api.workos.com/user_management/users/${encodeURIComponent(subject)}/sessions?limit=100`, { redirect: "error",
      signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${workosKey}` } });
    const listed = z.object({ data: z.array(z.object({ status: z.string().optional() }).passthrough()) }).safeParse(await response.json().catch(() => null));
    if (response.ok && listed.success) sessions = listed.data.data.filter(row => row.status === undefined || row.status === "active").length;
  } catch { sessions = "unread"; }
  return createHash("sha256").update(JSON.stringify({
    pro: me.success ? me.data.capabilities.pro : null,
    organizations: me.success ? me.data.organizations.map(org => [org.id, org.role ?? null, org.seat ?? null]).sort() : null,
    personalAllowed: personal.success ? personal.data.personalAllowed : null, sessions,
  })).digest("hex");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));

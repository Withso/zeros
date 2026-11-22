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
import { RehearsalFailure, STAGE_NEEDS_ACCOUNT, STAGES, type Api, type OwnerKind, type Ports, type StageName, type Switch } from "./contract.js";
import { diagnose, signInAccount, signInAll, type Account, type SignedIn, type SignInDeps } from "./accounts.js";
import { assertRepository, safeLine } from "./guard.js";
import { checkGithubToken, tokenLines, liveApi, liveBoat, liveBridge, liveClock, liveDatabase, liveGithub, liveGithubSignIn, liveGithubToken, livePro, liveRelease, liveStorage,
  tokenRefusal, liveReleaseIdentity, liveRuntimeQualification } from "./live.js";
import { errorCode } from "./steps.js";
import { accountLines, PERSONAL_ROUTE_GAPS, preconditionLines, type PreconditionFacts, platformOwners, probeDiagnostics, proActor, readAccount, refusal, resolveProbe, writeLines,
  type AccountSummary } from "./plan.js";
import { cleanup, cleanupNeedsAccount, DEFAULT_RUN_CAP, inventoryLines, NO_ACCOUNT, runStages, stageContext } from "./runner.js";
import { FIXTURE_TWO } from "./stage-provision.js";
import { loadState, newState, saveState } from "./state.js";

export const USAGE = "alpha:rehearse <provision|setup|projects|personal|retention|submodules|all> [--plan] [--cleanup] [--run <id>] " +
  "[--owner personal|organization (default personal)] [--account owner|1..10 (default 2)] [--other 1..10 (default the next configured)] " +
  "[--pro-actor <first 8 hex of the platform owner>] [--switches projects,personal,retention] [--repository owner/name] " +
  "[--repository-two owner/name (default Withso/zeros-dev-fixture-2)] [--submodule-repository owner/name] [--submodule-fixture-repository owner/name] [--keep-base] [--max-active <n>] [--organization <slug|id>]";
/** `all` runs these in order on each route; D is refused until written. */
export const ALL: Record<OwnerKind, readonly StageName[]> = {
  personal: ["provision", "setup", "projects", "personal", "retention", "submodules"], organization: ["provision", "setup", "projects", "retention"],
};
export const TIMING = { pollMs: 5_000, stateMs: 15 * 60_000, copyMs: 30 * 60_000, turnMs: 10 * 60_000, scanMs: 5 * 60_000, archiveScanMs: 65 * 60_000,
  idleStopMs: 35 * 60_000, computerMs: 45 * 60_000 };

export type Arguments = {
  stages: StageName[]; plan: boolean; cleanup: boolean; run?: string; owner: OwnerKind; account: "owner" | number; other?: number; proActor?: string;
  switches: Set<Switch>;
  repository?: string; repositoryTwo?: string; submoduleRepository?: string; submoduleFixtureRepository?: string; keepBase: boolean; maxActive: number; organization?: string;
};
export function parseArguments(argv: string[]): Arguments {
  // Private files: .env.agent at the repository root and the zeros-dev profile, both mode 0600; the profile is reached by
  // ZEROS_DEV_PROFILE_PATH (its loader refuses group- or world-readable files and does not follow a symlink).
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    plan: { type: "boolean" }, cleanup: { type: "boolean" }, run: { type: "string" }, account: { type: "string" }, switches: { type: "string" },
    repository: { type: "string" }, "repository-two": { type: "string" }, "keep-base": { type: "boolean" }, "max-active": { type: "string" },
    organization: { type: "string" }, owner: { type: "string" }, "submodule-repository": { type: "string" }, "submodule-fixture-repository": { type: "string" }, other: { type: "string" }, "pro-actor": { type: "string" }, help: { type: "boolean" },
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
  const switches = new Set<Switch>();
  for (const name of (values.switches ?? "").split(",").filter(Boolean)) {
    if (!["projects", "personal", "retention"].includes(name)) throw new RehearsalFailure("usage", "switch");
    switches.add(name as Switch);
  }
  const maxActive = values["max-active"] === undefined ? 10 : Number(values["max-active"]);
  if (!(Number.isInteger(maxActive) && maxActive >= 0 && maxActive <= 50)) throw new RehearsalFailure("usage", "max_active");
  return { stages, plan: !!values.plan, cleanup: !!values.cleanup, ...(values.run ? { run: values.run } : {}), owner, account,
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
  const roleNames = (run: string) => { let n = 0; return (kind: "read" | "write") => `zeros-rehearsal-${run.slice(0, 8)}-${kind}-${++n}-${Date.now().toString(36)}`; };
  const database = (run: string) => liveDatabase({ organization: need("PLANETSCALE_ORG"), database: need("ZEROS_PLANETSCALE_ALPHA_DATABASE"),
    tokenId: need("PLANETSCALE_SERVICE_TOKEN_ID"), token: need("PLANETSCALE_SERVICE_TOKEN"), roleName: roleNames(run) });
  const probeSelector = args.organization ?? env.ZEROS_ALPHA_PROBE_ORGANIZATION;
  const one = args.repository ?? (env.ZEROS_REHEARSAL_REPOSITORY ? assertRepository(env.ZEROS_REHEARSAL_REPOSITORY) : undefined);
  const two = args.repositoryTwo ?? (env.ZEROS_REHEARSAL_REPOSITORY_2 ? assertRepository(env.ZEROS_REHEARSAL_REPOSITORY_2) : FIXTURE_TWO);
  const githubToken = env.ZEROS_REHEARSAL_GITHUB_TOKEN?.trim();
  // The fixtures' reads and clean-up (exists, branches, pull requests, branch deletion): the token when set, so the
  // Personal route does not depend on the App's selected repositories; the App otherwise.
  const fixtureGithub = () => githubToken ? liveGithubToken(githubToken, "Withso")
    : liveGithub({ appId: Number(need("ZEROS_GITHUB_ALPHA_APP_ID")), privateKey: Buffer.from(need("ZEROS_GITHUB_ALPHA_APP_PRIVATE_KEY_B64"), "base64").toString("utf8"), owner: "Withso" });
  const signInDeps = (probe: { workosOrganizationId: string | null }): SignInDeps => ({
    subject: email => workosSubject(profile.workos.apiKey, email),
    signIn: input => gate0SignIn({ clientId: profile.workos.webClientId, apiKey: profile.workos.apiKey, ...input }),
    api: session => liveApi(session.accessToken), sleep: liveClock.sleep,
    ...(probe.workosOrganizationId ? { probeWorkosOrganization: probe.workosOrganizationId } : {}),
  });

  const token = githubToken;
  const personalOf = (signed: SignedIn) => signed.organizations.find(org => org.personal && org.role === "owner");

  try {
    if (!one) throw new RehearsalFailure("configuration", "repository_one");
    if (!probeSelector) throw new RehearsalFailure("configuration", "probe_organization");
    if (!await liveRelease()) throw new RehearsalFailure("release_identity", "not_ready");

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
        const probe = await resolveProbe(reads, probeSelector);
        log(`probe organization: found; WorkOS organization ${probe.workosOrganizationId ? "linked" : "not linked"}`);
        const ids = await platformOwners(reads);
        log(`platform owners (active): ${ids.length}${ids.length ? ` ${ids.join(" ")}` : ""}`);
        const actor = await proActor(reads, args.proActor);
        log(`pro actor (--pro-actor): ${actor.state}; github token (ZEROS_REHEARSAL_GITHUB_TOKEN): ${token ? "configured" : "absent"}`);
        const summaries = new Map<string, AccountSummary | { failed: string }>();
      const facts: PreconditionFacts = { release: await liveReleaseIdentity(), runtime: null, projectsRead: null, computer: null };
      if (facts.release) facts.runtime = await liveRuntimeQualification({ bucket: need("ZEROS_R2_ALPHA_BUCKET"), endpoint: need("ZEROS_R2_ALPHA_ENDPOINT"),
        accessKeyId: need("ZEROS_R2_ALPHA_ACCESS_KEY_ID"), secretAccessKey: need("ZEROS_R2_ALPHA_SECRET_ACCESS_KEY") }, facts.release.workerSha256).catch(() => null);
        for (const result of await signInAll(accounts, signInDeps(probe))) {
          if (!result.ok) { log(`account ${result.label}: failed ${result.step} ${result.code}`); summaries.set(result.label, { failed: `${result.step}:${result.code}` }); continue; }
          try {
            const summary = await readAccount(result.api, result.label, probe.id, "Withso");
            if (result.label === String(args.account) && summary.personal) {
              const base = `/v1/cloud-v2/organizations/${summary.personal.id}`;
              const projects = await result.api.json("GET", `${base}/cloud-projects`);
              facts.projectsRead = projects.status === 200 ? "200" : errorCode(projects);
              const computer = await result.api.json("GET", `${base}/computer`);
              const active = z.object({ activeBuildId: z.string().nullable() }).passthrough().safeParse(computer.body);
              facts.computer = computer.status === 200 && active.success ? (active.data.activeBuildId ? "active" : "none") : errorCode(computer);
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
        log(`selected account ${args.account}; second account ${otherLabel}; repositories R1 ${one}, R2 ${two}`);
        if (args.account === "owner") log("note: the owner's own account; the run asserts its entitlement, sessions and settings are unchanged");
        // Stage D's fixtures, read through the run's fixture identity (a repository read; nothing is written).
        const named = args.submoduleRepository && args.submoduleFixtureRepository ? [args.submoduleRepository, args.submoduleFixtureRepository] : null;
        let submoduleFixtures: "present" | "missing" | "not_named" = "not_named";
        if (named) {
          const github = fixtureGithub();
          submoduleFixtures = (await Promise.all(named.map(repository => github.repositoryExists(repository).catch(() => false)))).every(Boolean) ? "present" : "missing";
        }
        log(`submodule fixtures: ${submoduleFixtures}`);
        const readiness = { token: !!token, ...(tokenState && tokenState !== "absent" ? { tokenRefusal: tokenState } : {}), proActor: actor.state, submoduleFixtures };
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
    try { probe = await resolveProbe(startReads, probeSelector); actor = await proActor(startReads, args.proActor); }
    finally { await startReads.close().catch(() => log("database role: delete unconfirmed")); }
    let state = args.run ? await loadState(args.run) : undefined;
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
      state ??= newState(randomUUID(), organizationId, new Date(), owner);
      const run = state;
      await saveState(run);
      log(`run ${run.runId} prefix ${run.prefix} route ${owner}`);
      if (held && args.stages.includes("personal") && !args.cleanup) {
        const label = String(args.other ?? accounts.find(row => row.label !== "owner" && row.label !== String(args.account))?.label ?? "");
        const account = accounts.find(row => row.label === label);
        const result = account ? await signInAccount(account, signInDeps(probe)) : undefined;
        if (result?.ok) { sessions.push(result); other = result; } else log(`second account ${label || "none"}: unavailable${result && !result.ok ? ` ${result.step}:${result.code}` : ""}`);
      }
      const api = held?.api ?? NO_ACCOUNT;
      const db = database(run.runId.replace(/-/g, ""));
      const ports: Ports = {
        release: () => liveRelease(), api, bridge: liveBridge(api), boat: liveBoat({ apiKey: profile.boat.apiKey,
          ...(profile.boat.billingOrg ? { billingOrg: profile.boat.billingOrg } : {}) }),
        storage: liveStorage({ bucket: need("ZEROS_R2_ALPHA_BUCKET"), endpoint: need("ZEROS_R2_ALPHA_ENDPOINT"), accessKeyId: need("ZEROS_R2_ALPHA_ACCESS_KEY_ID"),
          secretAccessKey: need("ZEROS_R2_ALPHA_SECRET_ACCESS_KEY") }, () => run.created.workspaces),
        github: fixtureGithub(),
        database: db, clock: liveClock,
        ...(other ? { other: other.api } : {}),
        ...(held && owner === "personal" && actor.id ? { pro: livePro(db, { subjectUserId: held.userId, expectedEmail: held.email, actorUserId: actor.id }) } : {}),
        ...(held && token ? { githubSignIn: liveGithubSignIn(held.api, token) } : {}),
      };
      const ctx = stageContext(ports, run, () => saveState(run), { one, two, ...(args.submoduleRepository ? { submodules: args.submoduleRepository } : {}),
        ...(args.submoduleFixtureRepository ? { submoduleFixture: args.submoduleFixtureRepository } : {}) }, TIMING, DEFAULT_RUN_CAP);
      const before = held && args.account === "owner" ? await ownerFingerprint(held.api, organizationId, profile.workos.apiKey, held.subject) : undefined;
      const startedAt = Date.now();
      let passed: boolean;
      if (args.cleanup) {
        const { inventory, failures } = await cleanup(ctx, { accountless: !held, keepBase: args.keepBase, log });
        if (args.keepBase && run.created.computerBuild) log("cloud computer base: kept (--keep-base): its build row, live pointer and Boat named snapshot stay");
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

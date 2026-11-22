// `pnpm alpha:rehearse <stage|all> [--plan] [--cleanup] [--run <id>] [--account owner|<n>] [--switches projects,retention]`
// The live Alpha rehearsal of Projects, Personal cloud, Retention and Submodules. Read
// agents/zstack/playbooks/alpha-operator.md first. Alpha only, test accounts and fixture repositories only.
// Credentials are read in memory from .env.agent (repository root) and the private zeros-dev profile, never printed.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { z } from "zod";
import { alphaProbeOrganization } from "../gate0-alpha.js";
import { gate0SignIn } from "../gate0-cli.js";
import { RehearsalFailure, STAGES, type Api, type Ports, type StageName, type Switch } from "./contract.js";
import { assertRepository, safeLine } from "./guard.js";
import { liveApi, liveBoat, liveBridge, liveClock, liveDatabase, liveGithub, liveRelease, liveStorage } from "./live.js";
import { accountLines, platformOwners, readAccount, refusal, writeLines } from "./plan.js";
import { cleanup, DEFAULT_RUN_CAP, inventoryLines, runStages, stageContext } from "./runner.js";
import { FIXTURE_TWO } from "./stage-provision.js";
import { loadState, newState, saveState } from "./state.js";

export const USAGE = "alpha:rehearse <provision|projects|personal|retention|submodules|all> [--plan] [--cleanup] [--run <id>] " +
  "[--account owner|1..10] [--switches projects,personal,retention] [--repository owner/name] [--repository-two owner/name (default Withso/zeros-dev-fixture-2)] " +
  "[--keep-fixtures] [--max-active <n>] [--organization <slug|id>]";
/** `all` runs these in order; B and D are refused until written. */
export const ALL: readonly StageName[] = ["provision", "projects", "retention"];
export const TIMING = { pollMs: 5_000, stateMs: 15 * 60_000, copyMs: 30 * 60_000, turnMs: 10 * 60_000, scanMs: 5 * 60_000, archiveScanMs: 65 * 60_000 };

export type Arguments = {
  stages: StageName[]; plan: boolean; cleanup: boolean; run?: string; account: "owner" | number; switches: Set<Switch>;
  repository?: string; repositoryTwo?: string; keepFixtures: boolean; maxActive: number; organization?: string;
};
export function parseArguments(argv: string[]): Arguments {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    plan: { type: "boolean" }, cleanup: { type: "boolean" }, run: { type: "string" }, account: { type: "string" }, switches: { type: "string" },
    repository: { type: "string" }, "repository-two": { type: "string" }, "keep-fixtures": { type: "boolean" }, "max-active": { type: "string" },
    organization: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help || positionals.length !== 1) throw new RehearsalFailure("usage", "usage");
  const stage = positionals[0]!;
  const stages = stage === "all" ? [...ALL] : (STAGES as readonly string[]).includes(stage) ? [stage as StageName] : null;
  if (!stages) throw new RehearsalFailure("usage", "stage");
  if (values.plan && values.cleanup) throw new RehearsalFailure("usage", "plan_and_cleanup");
  if (values.cleanup && !values.run) throw new RehearsalFailure("usage", "cleanup_needs_run");
  const account = values.account === undefined || values.account === "owner" ? "owner" as const : Number(values.account);
  if (account !== "owner" && !(Number.isInteger(account) && account >= 1 && account <= 10)) throw new RehearsalFailure("usage", "account");
  const switches = new Set<Switch>();
  for (const name of (values.switches ?? "").split(",").filter(Boolean)) {
    if (!["projects", "personal", "retention"].includes(name)) throw new RehearsalFailure("usage", "switch");
    switches.add(name as Switch);
  }
  const maxActive = values["max-active"] === undefined ? 10 : Number(values["max-active"]);
  if (!(Number.isInteger(maxActive) && maxActive >= 0 && maxActive <= 50)) throw new RehearsalFailure("usage", "max_active");
  return { stages, plan: !!values.plan, cleanup: !!values.cleanup, ...(values.run ? { run: values.run } : {}), account, switches,
    ...(values.repository ? { repository: assertRepository(values.repository) } : {}),
    ...(values["repository-two"] ? { repositoryTwo: assertRepository(values["repository-two"]) } : {}),
    keepFixtures: !!values["keep-fixtures"], maxActive, ...(values.organization ? { organization: values.organization } : {}) };
}

const Profile = z.object({
  workos: z.object({ environment: z.literal("alpha"), webClientId: z.string().regex(/^client_[A-Za-z0-9_-]+$/), apiKey: z.string().min(16) }).passthrough(),
  boat: z.object({ apiKey: z.string().min(16), billingOrg: z.string().optional(), secondsPerDollar: z.number().positive().optional() }).passthrough(),
  fixture: z.object({ workosUserId: z.string(), expectedEmail: z.string().email(), workosOrganizationId: z.string().optional() }).passthrough(),
}).passthrough();

type Account = { label: string; email: string; password: string; subject?: string; organizationId?: string };

async function main(argv: string[]): Promise<number> {
  const log = (line: string) => console.log(`[rehearse] ${safeLine(line)}`);
  let args: Arguments;
  try { args = parseArguments(argv); } catch { console.log(USAGE); return 2; }
  const root = resolve(import.meta.dirname, "../../../../..");
  let profile: z.infer<typeof Profile>, env: NodeJS.Dict<string>;
  try {
    const { loadProfile } = await import(pathToFileURL(resolve(root, "scripts/dev-environment/profile.mjs")).href);
    profile = Profile.parse(loadProfile(undefined, { root, env: process.env }));
    env = parseEnv(readFileSync(resolve(root, ".env.agent"), "utf8"));
  } catch { log("failed private_configuration"); return 1; }
  const need = (name: string) => { const value = env[name]?.trim(); if (!value) throw new RehearsalFailure("configuration", name.toLowerCase()); return value; };

  const accounts = new Map<string, Account>();
  if (env.ZEROS_DEV_PASSWORD) accounts.set("owner", { label: "owner", email: profile.fixture.expectedEmail, password: env.ZEROS_DEV_PASSWORD,
    subject: profile.fixture.workosUserId, ...(profile.fixture.workosOrganizationId ? { organizationId: profile.fixture.workosOrganizationId } : {}) });
  for (let n = 1; n <= 10; n++) {
    const password = env[`ZEROS_TEST_USER_${n}_PASSWORD`];
    if (password) accounts.set(String(n), { label: String(n), email: `user-${n}@zeros.build`, password });
  }
  const signIn = async (account: Account) => {
    const subject = account.subject ?? await workosSubject(profile.workos.apiKey, account.email);
    const session = await gate0SignIn({ clientId: profile.workos.webClientId, apiKey: profile.workos.apiKey, email: account.email, password: account.password, subject,
      ...(account.organizationId ? { organizationId: account.organizationId } : {}) });
    return { session, subject, api: liveApi(session.accessToken) };
  };
  const roleNames = (run: string) => { let n = 0; return (kind: "read" | "write") => `zeros-rehearsal-${run.slice(0, 8)}-${kind}-${++n}-${Date.now().toString(36)}`; };
  const database = (run: string) => liveDatabase({ organization: need("PLANETSCALE_ORG"), database: need("ZEROS_PLANETSCALE_ALPHA_DATABASE"),
    tokenId: need("PLANETSCALE_SERVICE_TOKEN_ID"), token: need("PLANETSCALE_SERVICE_TOKEN"), roleName: roleNames(run) });
  const probeSelector = args.organization ?? env.ZEROS_ALPHA_PROBE_ORGANIZATION;
  const one = args.repository ?? (env.ZEROS_REHEARSAL_REPOSITORY ? assertRepository(env.ZEROS_REHEARSAL_REPOSITORY) : undefined);
  const two = args.repositoryTwo ?? (env.ZEROS_REHEARSAL_REPOSITORY_2 ? assertRepository(env.ZEROS_REHEARSAL_REPOSITORY_2) : FIXTURE_TWO);

  try {
    if (!one) throw new RehearsalFailure("configuration", "repository_one");
    if (!await liveRelease()) throw new RehearsalFailure("release_identity", "not_ready");

    if (args.plan) {
      log("plan: reads only; each account signs in (one session, revoked at the end), and one temporary database role inheriting only pg_read_all_data is minted for reads and deleted");
      const summaries = new Map<string, Awaited<ReturnType<typeof readAccount>>>();
      for (const account of accounts.values()) {
        let held: Awaited<ReturnType<typeof signIn>> | undefined;
        try {
          held = await signIn(account);
          const me = z.object({ organizations: z.array(z.object({ id: z.string().uuid(), slug: z.string() })) }).parse((await held.api.json("GET", "/v1/me")).body);
          const probe = probeSelector ? me.organizations.find(org => org.slug === probeSelector || org.id === probeSelector) : undefined;
          const summary = await readAccount(held.api, account.label, probe?.id ?? "", "Withso");
          summaries.set(account.label, summary);
          for (const line of accountLines(summary)) log(line);
        } catch (error) { log(`account ${account.label}: sign-in or read failed ${error instanceof RehearsalFailure ? error.code : "failed"}`); }
        finally { await held?.session.close().catch(() => log(`account ${account.label}: sign-out failed`)); }
      }
      const owners = database(randomUUID().replace(/-/g, ""));
      try { const ids = await platformOwners(owners); log(`platform owners (active): ${ids.length}${ids.length ? ` ${ids.join(" ")}` : ""}`); }
      catch (error) { log(`platform owners: read failed ${error instanceof RehearsalFailure ? error.code : "failed"}`); }
      finally { await owners.close().catch(() => log("plan database role: delete unconfirmed")); }
      const selected = summaries.get(String(args.account));
      log(`selected account ${args.account}; repositories R1 ${one}, R2 ${two}`);
      if (args.account === "owner") log("note: the owner's own account; the run asserts its entitlement, sessions and settings are unchanged");
      for (const stage of args.stages) {
        const refused = selected ? refusal(stage, selected, args.switches) : "account_unavailable";
        log(`stage ${stage}: ${refused ? `refused ${refused}` : "would run"}`);
        for (const line of writeLines(stage, "zr-<run>-", { one, two })) log(`  ${line}`);
      }
      return 0;
    }

    const account = accounts.get(String(args.account));
    if (!account) throw new RehearsalFailure("account", "unavailable");
    const held = await signIn(account);
    try {
      const me = z.object({ organizations: z.array(z.object({ id: z.string().uuid(), slug: z.string() })) }).parse((await held.api.json("GET", "/v1/me")).body);
      let organization;
      try { organization = alphaProbeOrganization(me, probeSelector); } catch { throw new RehearsalFailure("probe_organization", "not_found"); }
      const state = args.run ? await loadState(args.run) : newState(randomUUID(), organization.id, new Date());
      if (state.organizationId !== organization.id) throw new RehearsalFailure("state", "organization");
      await saveState(state);
      log(`run ${state.runId} prefix ${state.prefix}`);
      const ports: Ports = {
        release: () => liveRelease(), api: held.api, bridge: liveBridge(held.api), boat: liveBoat({ apiKey: profile.boat.apiKey,
          ...(profile.boat.billingOrg ? { billingOrg: profile.boat.billingOrg } : {}) }),
        storage: liveStorage({ bucket: need("ZEROS_R2_ALPHA_BUCKET"), endpoint: need("ZEROS_R2_ALPHA_ENDPOINT"), accessKeyId: need("ZEROS_R2_ALPHA_ACCESS_KEY_ID"),
          secretAccessKey: need("ZEROS_R2_ALPHA_SECRET_ACCESS_KEY") }, () => state.created.workspaces),
        github: liveGithub({ appId: Number(need("ZEROS_GITHUB_ALPHA_APP_ID")), privateKey: Buffer.from(need("ZEROS_GITHUB_ALPHA_APP_PRIVATE_KEY_B64"), "base64").toString("utf8"),
          owner: "Withso" }),
        database: database(state.runId.replace(/-/g, "")), clock: liveClock,
      };
      const ctx = stageContext(ports, state, () => saveState(state), { one, two }, TIMING, DEFAULT_RUN_CAP);
      const before = args.account === "owner" ? await ownerFingerprint(held.api, organization.id, profile.workos.apiKey, held.subject) : undefined;
      const startedAt = Date.now();
      let passed: boolean;
      if (args.cleanup) {
        const { inventory, failures } = await cleanup(ctx, { keepFixtures: args.keepFixtures, log });
        const { lines, clean } = inventoryLines(inventory);
        for (const line of lines) log(line);
        if (failures) log(`cleanup failures ${failures}`);
        passed = clean && failures === 0;
      } else passed = await runStages(ctx, args.stages, { switches: args.switches, maxActive: args.maxActive, runCap: DEFAULT_RUN_CAP, log });
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      log(`machine starts ${state.machineStarts}; wall seconds ${seconds}; clock shifts ${state.shifts}`);
      if (profile.boat.secondsPerDollar) log(`estimated dollars at most ${(state.machineStarts * seconds / profile.boat.secondsPerDollar).toFixed(2)} (every start running the whole time)`);
      if (before) {
        const after = await ownerFingerprint(held.api, organization.id, profile.workos.apiKey, held.subject);
        log(`owner account unchanged: ${before === after ? "yes" : "no"}`);
        if (before !== after) passed = false;
      }
      if (!passed && !args.cleanup) log(`next: pnpm alpha:rehearse ${args.stages.length > 1 ? "all" : args.stages[0]} --cleanup --run ${state.runId}`);
      return passed ? 0 : 1;
    } finally { await held.session.close().catch(() => log("sign-out failed")); }
  } catch (error) {
    log(`failed ${error instanceof RehearsalFailure ? `${error.step} ${error.code}` : "unexpected"}`);
    return 1;
  }
}

/** The test user's WorkOS subject, read by email with the Alpha WorkOS key. */
async function workosSubject(apiKey: string, email: string): Promise<string> {
  const response = await fetch(`https://api.workos.com/user_management/users?email=${encodeURIComponent(email)}`, { redirect: "error",
    signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${apiKey}` } });
  const body = z.object({ data: z.array(z.object({ id: z.string(), email: z.string() }).passthrough()) }).safeParse(await response.json().catch(() => null));
  const found = body.success ? body.data.data.find(row => row.email.toLowerCase() === email.toLowerCase()) : undefined;
  if (!response.ok || !found) throw new RehearsalFailure("workos_user", `http_${response.status}`);
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

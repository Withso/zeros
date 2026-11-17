// Headless measurement of deployed Alpha (`pnpm alpha:probe`). Runs the gate0
// probe against api-alpha as the Dev fixture login, inside an explicitly
// selected test organization, and reports each phase's duration and VM time.
// Alpha's worker signing key never leaves Railway, so the hybrid transport
// probe is not run; worker timings are read only when the operator's Boat key
// can see Alpha's VM.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";
import { BoatApiClient } from "./boat-client.js";
import { BoatCloudV2Compute } from "./boat.js";
import { GATE0_AGENTS, Gate0Failure, runCloudV2Gate0, type CloudV2Gate0Result, type Gate0Metric } from "./gate0.js";
import { gate0ModelsFromEnv, gate0SignIn } from "./gate0-cli.js";
import { createGate0TimingReader, type Gate0Timing } from "./gate0-transport.js";

export const ALPHA_PROBE_ORIGIN = "https://api-alpha.zeros.build";
type Agent = typeof GATE0_AGENTS[number];

export function alphaProbeIdentity(value: unknown): { sourceSha: string; workerSha256: string } {
  const checked = z.object({ channel: z.literal("alpha"), ready: z.literal(true), maintenance: z.literal(false), sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    cloud: z.object({ enabled: z.literal(true), ready: z.literal(true), state: z.literal("healthy") }),
    worker: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }) }).safeParse(value);
  if (!checked.success) throw new Gate0Failure("alpha_release_identity");
  return { sourceSha: checked.data.sourceSha, workerSha256: checked.data.worker.sha256 };
}

/** The fixture login also belongs to real team organizations on Alpha; a
 * probe runs only in the one the operator names, matched exactly. */
export function alphaProbeOrganization(me: { organizations: { id: string; slug: string }[] }, selector: string | undefined) {
  const found = selector ? me.organizations.find(org => org.slug === selector || org.id === selector) : undefined;
  if (!found) throw new Gate0Failure("alpha_organization");
  return found;
}

export function alphaProbeAgents(requested: string | undefined, connections: { provider: string; connected: boolean }[]): { agents: Agent[]; skipped: Agent[] } {
  const connected = (agent: Agent) => connections.some(row => row.provider === agent && row.connected);
  const parsed = z.array(z.enum(GATE0_AGENTS)).safeParse(requested ? requested.split(",") : GATE0_AGENTS.filter(connected));
  if (!parsed.success || parsed.data.length === 0 || new Set(parsed.data).size !== parsed.data.length) throw new Gate0Failure("agent_selection");
  for (const agent of parsed.data) if (!connected(agent)) throw new Gate0Failure(`agent_${agent}_login`);
  return { agents: parsed.data, skipped: GATE0_AGENTS.filter(agent => !parsed.data.includes(agent)) };
}

export function alphaProbeReport(input: {
  identity: { sourceSha: string; workerSha256: string }; organization: string; agents: readonly Agent[]; skipped: readonly Agent[];
  metrics: Gate0Metric[]; workerTimings: Gate0Timing[]; startedAt: string; dollarsPerHour?: number;
  result?: CloudV2Gate0Result; failure?: string; failureCause?: string;
}) {
  const vm = input.result ? (() => {
    const runningSeconds = Math.round(input.result.vmRunningMs / 1000);
    return { runningSeconds, ...(input.dollarsPerHour === undefined ? {} : {
      dollarsPerHour: input.dollarsPerHour, estimatedDollars: Math.round(runningSeconds / 3600 * input.dollarsPerHour * 100) / 100 }) };
  })() : undefined;
  return {
    version: 1, target: "alpha", startedAt: input.startedAt, ...input.identity, organization: input.organization,
    agents: input.agents, skipped: input.skipped, outcome: input.failure ? "failed" : "passed",
    ...(input.failure ? { failure: input.failure, ...(input.failureCause ? { failureCause: input.failureCause } : {}) } : { deleted: input.result?.deleted ?? false, turns: input.result?.turns ?? 0, vm,
      // The control plane's own provider cost for this workspace; null when it reported none.
      agentCost: input.result?.agentCost ?? null }),
    metrics: input.metrics, workerTimings: input.workerTimings,
  };
}

export async function runAlphaProbe(values: { profile?: string; "agent-env"?: string; organization?: string; repository?: string; agents?: string; keep?: boolean; report?: string }) {
  const root = resolve(import.meta.dirname, "../../../..");
  // `pnpm --dir` runs here; a relative path belongs to the caller's directory.
  const callerPath = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);
  let profile, env: NodeJS.Dict<string>;
  try {
    const { loadProfile } = await import(pathToFileURL(resolve(root, "scripts/dev-environment/profile.mjs")).href);
    profile = z.object({
      workos: z.object({ environment: z.literal("alpha"), webClientId: z.string().regex(/^client_[A-Za-z0-9_-]+$/), apiKey: z.string().min(16) }),
      boat: z.object({ apiKey: z.string().min(16), billingOrg: z.string().optional() }),
      fixture: z.object({ workosUserId: z.string(), expectedEmail: z.string().email(), workosOrganizationId: z.string().optional() }),
    }).parse(loadProfile(undefined, { root, env: { ...process.env, ...(values.profile ? { ZEROS_DEV_PROFILE_PATH: callerPath(values.profile) } : {}) } }));
    env = parseEnv(readFileSync(values["agent-env"] ? callerPath(values["agent-env"]) : resolve(root, ".env.agent"), "utf8"));
  } catch { throw new Gate0Failure("private_configuration"); }
  if (!env.ZEROS_DEV_PASSWORD) throw new Gate0Failure("test_login_configuration");
  const repository = values.repository ?? env.ZEROS_ALPHA_PROBE_REPOSITORY ?? env.ZEROS_DEV_REPOSITORY;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Gate0Failure("repository_configuration");
  const rate = env.ZEROS_ALPHA_PROBE_VM_DOLLARS_PER_HOUR?.trim();
  const dollarsPerHour = rate ? Number(rate) : undefined;
  if (dollarsPerHour !== undefined && !(Number.isFinite(dollarsPerHour) && dollarsPerHour >= 0)) throw new Gate0Failure("rate_configuration");

  const startedAt = new Date().toISOString();
  let identity;
  try {
    const response = await fetch(`${ALPHA_PROBE_ORIGIN}/v1/release-identity`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    identity = alphaProbeIdentity(await response.json());
  } catch { throw new Gate0Failure("alpha_release_identity"); }
  console.log(`[alpha-probe] Alpha source ${identity.sourceSha.slice(0, 12)} worker ${identity.workerSha256.slice(0, 12)}`);

  const session = await gate0SignIn({ clientId: profile.workos.webClientId, apiKey: profile.workos.apiKey, email: profile.fixture.expectedEmail,
    subject: profile.fixture.workosUserId, password: env.ZEROS_DEV_PASSWORD,
    ...(profile.fixture.workosOrganizationId ? { organizationId: profile.fixture.workosOrganizationId } : {}) });
  const metrics: Gate0Metric[] = [], workerTimings: Gate0Timing[] = [];
  let report;
  try {
    const get = async (path: string, stage: string) => {
      try {
        const response = await fetch(`${ALPHA_PROBE_ORIGIN}${path}`, { redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${await session.accessToken()}` } });
        if (!response.ok) { await response.body?.cancel(); throw new Error(); }
        return await response.json() as unknown;
      } catch { throw new Gate0Failure(stage); }
    };
    const me = z.object({ organizations: z.array(z.object({ id: z.string().uuid(), slug: z.string() })) }).parse(await get("/v1/me", "alpha_sign_in"));
    const organization = alphaProbeOrganization(me, values.organization ?? env.ZEROS_ALPHA_PROBE_ORGANIZATION);
    const logins = z.object({ connections: z.array(z.object({ provider: z.string(), connected: z.boolean() })) })
      .parse(await get(`/v1/organizations/${organization.id}/agent-connections`, "provider_logins"));
    const { agents, skipped } = alphaProbeAgents(values.agents, logins.connections);
    const compute = new BoatCloudV2Compute(new BoatApiClient({ apiKey: profile.boat.apiKey, timeoutMs: 20_000,
      ...(profile.boat.billingOrg ? { billingOrg: profile.boat.billingOrg } : {}) }));
    const readTimings = createGate0TimingReader({ compute });
    const base = { identity, organization: organization.slug, agents, skipped, metrics, workerTimings, startedAt,
      ...(dollarsPerHour === undefined ? {} : { dollarsPerHour }) };
    let result: CloudV2Gate0Result;
    try {
      result = await runCloudV2Gate0({ apiOrigin: ALPHA_PROBE_ORIGIN, organizationId: organization.id, repository, accessToken: session.accessToken,
        agents, models: gate0ModelsFromEnv(env), timingsOptional: true, ...(values.keep ? { keep: true } : {}),
        // Alpha's VMs may belong to a Boat account this operator key cannot read.
        readTimings: async workspace => {
          try { workerTimings.push(...await readTimings(workspace)); } catch { console.log("[alpha-probe] worker timings unavailable with this Boat key"); }
          return workerTimings;
        },
        onMetric: metric => { metrics.push(metric); console.log(`[alpha-probe] ${metric.name} ${metric.ms}ms`); },
        log: message => console.log(`[alpha-probe] ${message}`) });
      report = alphaProbeReport({ ...base, result });
    } catch (error) {
      report = alphaProbeReport({ ...base, failure: error instanceof Gate0Failure ? error.stage : "unexpected_failure",
        ...(error instanceof Gate0Failure && error.cause ? { failureCause: error.cause } : {}) });
      throw error;
    } finally {
      if (report) {
        if (values.report) {
          const file = callerPath(values.report);
          mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
        }
        console.log(`[alpha-probe] report ${JSON.stringify(report)}`);
      }
    }
    if (skipped.length) console.log(`[alpha-probe] Not checked: ${skipped.join(", ")} (not connected or not selected)`);
    console.log("[alpha-probe] Not checked: hybrid transport (Alpha's worker signing key stays in Railway)");
    console.log(`[alpha-probe] PASSED; VM ran ${Math.round(result.vmRunningMs / 1000)}s; workspace ${result.deleted ? "deleted" : "retained (--keep)"}`);
  } finally { await session.close(); }
}

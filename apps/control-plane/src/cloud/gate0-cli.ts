// Deployed-Dev gate0. Reads the private Dev profile and .env.agent in memory;
// credentials, provider output and remote error bodies never enter logs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { decodeJwt } from "jose";
import { z } from "zod";
import { GATE0_AGENTS, Gate0Failure, runCloudV2Gate0 } from "./gate0.js";
import { BoatApiClient } from "./boat-client.js";
import { BoatCloudV2Compute } from "./boat.js";
import { CloudV2WorkerSigner } from "./worker-auth.js";
import { createGate0TransportProbe } from "./gate0-transport.js";

export function gate0DevTarget(input: string, domain: string): { origin: string; owner: string } {
  try {
    const url = new URL(input), suffix = `.${domain}`;
    const prefix = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : "";
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash ||
        !/^api-dev-[a-f0-9]{24}$/.test(prefix)) throw new Error();
    return { origin: url.origin, owner: prefix.slice("api-dev-".length) };
  } catch { throw new Gate0Failure("dev_target"); }
}

const Profile = z.object({
  version: z.literal(2), mode: z.literal("hosted"),
  cloudflare: z.object({ domain: z.string().regex(/^[a-z0-9.-]+$/) }),
  workos: z.object({ environment: z.enum(["alpha", "dev"]), webClientId: z.string().regex(/^client_[A-Za-z0-9_-]+$/), apiKey: z.string().min(16) }),
  registry: z.object({ endpoint: z.string().url(), bucket: z.string(), encryptionKey: z.string(), accessKeyId: z.string(), secretAccessKey: z.string() }),
  boat: z.object({ apiKey: z.string().min(16), billingOrg: z.string().optional() }),
  fixture: z.object({ workosUserId: z.string(), expectedEmail: z.string().email(), expectedOrganizationSlug: z.string() }).optional(),
});

/** A separate test login. Never reads, rotates or writes the shared saved
 * zeros-dev session; only this probe's newly issued session is revoked. */
export async function gate0SignIn(input: { clientId: string; apiKey: string; email: string; password: string; subject: string }, fetchImpl: typeof fetch = fetch) {
  const origin = "https://api.workos.com/user_management";
  let accessToken = "", refreshToken = "", sessionId = "", expiresAt = 0;
  const request = async (path: string, body: unknown, revoke = false) => {
    try {
      const response = await fetchImpl(`${origin}/${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", ...(revoke ? { authorization: `Bearer ${input.apiKey}` } : {}) }, body: JSON.stringify(body) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      if (revoke) { await response.body?.cancel(); return undefined; }
      return await response.json();
    } catch { throw new Gate0Failure(revoke ? "sign_out" : "sign_in"); }
  };
  const authenticate = async (grant: Record<string, string>) => {
    const reply = await request("authenticate", { client_id: input.clientId, client_secret: input.apiKey, ...grant });
    const parsed = z.object({ access_token: z.string().min(16), refresh_token: z.string().min(16),
      user: z.object({ id: z.string(), email: z.string(), email_verified: z.literal(true) }),
      authentication_method: z.string().optional() }).safeParse(reply);
    if (!parsed.success) throw new Gate0Failure("sign_in");
    const value = parsed.data;
    let claims;
    try { claims = decodeJwt(value.access_token); } catch { throw new Gate0Failure("sign_in"); }
    if (typeof claims.sid !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(claims.sid)) throw new Gate0Failure("sign_in");
    // Retain the SID for cleanup even if the intended identity check fails.
    sessionId = claims.sid;
    if (value.user.id !== input.subject || value.user.email.toLowerCase() !== input.email.toLowerCase() ||
        (grant.grant_type === "password" && value.authentication_method !== "Password") ||
        typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Gate0Failure("sign_in_identity");
    accessToken = value.access_token; refreshToken = value.refresh_token; expiresAt = claims.exp * 1000;
  };
  const close = async () => { if (sessionId) await request("sessions/revoke", { session_id: sessionId }, true); };
  try { await authenticate({ grant_type: "password", email: input.email, password: input.password }); }
  catch (error) { await close().catch(() => {}); throw error; }
  return {
    accessToken: async () => {
      if (expiresAt - Date.now() < 60_000) await authenticate({ grant_type: "refresh_token", refresh_token: refreshToken });
      return accessToken;
    },
    close,
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    api: { type: "string" }, profile: { type: "string" }, "agent-env": { type: "string" }, organization: { type: "string" },
    repository: { type: "string" }, agents: { type: "string" }, runtime: { type: "string" }, keep: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("cloud-v2:gate0 --api <Dev API origin> [--profile <private JSON>] [--agent-env <private .env.agent>] [--organization <UUID>] [--repository owner/name] [--runtime <sha256>] [--agents codex,claude,cursor] [--keep]");
    console.log("Uses the selected Dev profile's WorkOS client, Boat access, encrypted registry and the dedicated .env.agent test password. Requires an installed Computer and connected provider logins. Creates one workspace, checks it, then deletes it unless --keep is set.");
    return;
  }
  const root = resolve(import.meta.dirname, "../../../..");
  let profile: z.infer<typeof Profile>, env: NodeJS.Dict<string>;
  try {
    profile = Profile.parse(JSON.parse(readFileSync(values.profile ?? resolve(root, "zeros-dev-env.json"), "utf8")));
    env = parseEnv(readFileSync(values["agent-env"] ?? resolve(root, ".env.agent"), "utf8"));
  } catch { throw new Gate0Failure("private_configuration"); }
  const target = gate0DevTarget(values.api ?? "", profile.cloudflare.domain);
  const agents = z.array(z.enum(GATE0_AGENTS)).min(1).parse((values.agents ?? GATE0_AGENTS.join(",")).split(","));
  const repository = values.repository ?? env.ZEROS_DEV_REPOSITORY;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Gate0Failure("repository_configuration");
  const email = profile.fixture?.expectedEmail ?? env.ZEROS_DEV_EMAIL;
  const subject = profile.fixture?.workosUserId ?? env.ZEROS_DEV_WORKOS_SUBJECT;
  if (!email || !subject || !env.ZEROS_DEV_PASSWORD) throw new Gate0Failure("test_login_configuration");
  if (values.runtime && !/^[a-f0-9]{64}$/.test(values.runtime)) throw new Gate0Failure("runtime_pin");
  let health;
  try {
    const response = await fetch(`${target.origin}/healthz`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    health = z.object({ ok: z.literal(true), development: z.object({ owner: z.literal(target.owner), generation: z.string().uuid() }) }).safeParse(await response.json());
    if (!response.ok || !health.success) throw new Error();
  } catch { throw new Gate0Failure("dev_identity"); }
  let transportProbe;
  try {
    // Read-only Dev registry access: derive the same generation-stable signer
    // as hosted-profile without printing or storing its private material.
    const [{ r2Registry }, { cloudV2WorkerSigningKey }] = await Promise.all([
      import(pathToFileURL(resolve(root, "scripts/dev-environment/hosted-state.mjs")).href),
      import(pathToFileURL(resolve(root, "scripts/dev-environment/hosted-profile.mjs")).href),
    ]);
    const receipt = await r2Registry(profile.registry).read(target.owner);
    if (receipt?.state?.owner !== target.owner || receipt.state.generation !== health.data.development.generation) throw new Error();
    const signer = new CloudV2WorkerSigner(cloudV2WorkerSigningKey(receipt.state));
    const compute = new BoatCloudV2Compute(new BoatApiClient({ apiKey: profile.boat.apiKey, timeoutMs: 20_000,
      ...(profile.boat.billingOrg ? { billingOrg: profile.boat.billingOrg } : {}) }));
    transportProbe = createGate0TransportProbe({ compute, signer });
  } catch { throw new Gate0Failure("transport_configuration"); }
  const session = await gate0SignIn({ clientId: profile.workos.webClientId, apiKey: profile.workos.apiKey, email, subject, password: env.ZEROS_DEV_PASSWORD });
  try {
    const meResponse = await fetch(`${target.origin}/v1/me`, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${await session.accessToken()}` } });
    if (!meResponse.ok) { await meResponse.body?.cancel(); throw new Gate0Failure("dev_sign_in"); }
    const me = z.object({ organizations: z.array(z.object({ id: z.string().uuid(), slug: z.string() })) }).parse(await meResponse.json());
    const organizationId = values.organization ?? me.organizations.find(org => org.slug === profile.fixture?.expectedOrganizationSlug)?.id ?? env.ZEROS_DEV_ORGANIZATION_ID;
    if (!organizationId || !me.organizations.some(org => org.id === organizationId)) throw new Gate0Failure("organization_configuration");
    // Check the vault before spending a VM start. Only statuses are inspected.
    const loginResponse = await fetch(`${target.origin}/v1/organizations/${organizationId}/agent-connections`, {
      redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${await session.accessToken()}` },
    });
    if (!loginResponse.ok) { await loginResponse.body?.cancel(); throw new Gate0Failure("provider_logins"); }
    const logins = z.object({ connections: z.array(z.object({ provider: z.string(), connected: z.boolean() })) }).parse(await loginResponse.json());
    for (const agent of agents) if (!logins.connections.some(row => row.provider === agent && row.connected)) throw new Gate0Failure(`agent_${agent}_login`);
    const result = await runCloudV2Gate0({ apiOrigin: target.origin, organizationId, repository, accessToken: session.accessToken, agents, transportProbe,
      ...(values.runtime ? { runtimeSha: values.runtime } : {}), ...(values.keep ? { keep: true } : {}), log: message => console.log(`[gate0] ${message}`) });
    const skipped = GATE0_AGENTS.filter(agent => !agents.includes(agent));
    if (skipped.length) console.log(`[gate0] Not checked: ${skipped.join(", ")}`);
    console.log(`[gate0] PASSED; workspace ${result.workspaceId} ${result.deleted ? "deleted" : "retained (--keep)"}`);
  } finally { await session.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Gate0Failure ? error.message : "Cloud v2 gate0 failed; details withheld"); process.exitCode = 1; });
}

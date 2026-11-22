// Hosted or local Dev gate0, or the Alpha probe (--alpha, gate0-alpha.ts). Reads the private Dev profile and .env.agent in memory;
// credentials, provider output and remote error bodies never enter logs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { decodeJwt } from "jose";
import { z } from "zod";
import { GATE0_AGENTS, GATE0_DEFAULT_MODELS, Gate0Failure, runCloudV2Gate0 } from "./gate0.js";
import { BoatApiClient } from "./boat-client.js";
import { BoatCloudV2Compute } from "./boat.js";
import { CloudV2WorkerSigner } from "./worker-auth.js";
import { createGate0TransportProbe, createGate0TimingReader } from "./gate0-transport.js";

export function gate0ModelsFromEnv(env: NodeJS.Dict<string>): Record<typeof GATE0_AGENTS[number], string> {
  return {
    codex: env.ZEROS_GATE0_CODEX_MODEL?.trim() || GATE0_DEFAULT_MODELS.codex,
    claude: env.ZEROS_GATE0_CLAUDE_MODEL?.trim() || GATE0_DEFAULT_MODELS.claude,
    cursor: env.ZEROS_GATE0_CURSOR_MODEL?.trim() || GATE0_DEFAULT_MODELS.cursor,
  };
}

export function gate0DevTarget(input: string, domain: string): { origin: string; owner: string } {
  try {
    const url = new URL(input), suffix = `.${domain}`;
    const prefix = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : "";
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash ||
        !/^api-dev-[a-f0-9]{24}$/.test(prefix)) throw new Error();
    return { origin: url.origin, owner: prefix.slice("api-dev-".length) };
  } catch { throw new Gate0Failure("dev_target"); }
}

type LocalTarget = { owner: string; runId: string; apiPort: number };

export function gate0LocalTarget(input: string | undefined, domain: string, local: LocalTarget): { origin: string; owner: string } {
  try {
    const url = new URL(input ?? `https://api-dev-${local.owner}.${domain}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    if (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === String(local.apiPort))
      return { origin: url.origin, owner: local.owner };
    const target = gate0DevTarget(url.href, domain);
    if (target.owner !== local.owner) throw new Error();
    return target;
  } catch { throw new Gate0Failure("local_target"); }
}

export function gate0LocalIdentity(health: unknown, local: LocalTarget): void {
  const result = z.object({ ok: z.literal(true), development: z.object({
    owner: z.literal(local.owner), runId: z.literal(local.runId),
  }).strict() }).safeParse(health);
  if (!result.success) throw new Gate0Failure("local_identity");
}

const CommonProfile = z.object({
  cloudflare: z.object({ domain: z.string().regex(/^[a-z0-9.-]+$/) }),
  workos: z.object({ environment: z.enum(["alpha", "dev"]), webClientId: z.string().regex(/^client_[A-Za-z0-9_-]+$/), apiKey: z.string().min(16) }),
  boat: z.object({ apiKey: z.string().min(16), billingOrg: z.string().optional() }),
  fixture: z.object({ workosUserId: z.string(), expectedEmail: z.string().email(), expectedOrganizationSlug: z.string(),
    workosOrganizationId: z.string().optional() }).optional(),
});
const Profile = CommonProfile.extend({
  version: z.literal(2), mode: z.literal("hosted"),
  registry: z.object({ endpoint: z.string().url(), bucket: z.string(), encryptionKey: z.string(), accessKeyId: z.string(), secretAccessKey: z.string() }),
});
const LocalState = z.object({
  version: z.literal(1), status: z.literal("active"), owner: z.string().regex(/^[a-f0-9]{24}$/), identity: z.string(),
  keys: z.object({ agent: z.string().regex(/^[a-f0-9]{64}$/) }),
  ports: z.object({ api: z.number().int().min(1024).max(65535) }),
  launcher: z.object({ runId: z.string().uuid() }),
});

const OrganizationSelection = z.object({ code: z.literal("organization_selection_required"), pending_authentication_token: z.string().min(16),
  user: z.object({ id: z.string(), email: z.string() }), organizations: z.array(z.object({ id: z.string() })) });

/** A separate test login. Never reads, rotates or writes the shared saved
 * zeros-dev session; only this probe's newly issued session is revoked. A
 * member of several WorkOS organizations finishes inside `organizationId`. */
/** WorkOS error names a failed sign-in may report. Only these are shown: anything else in a body (which could echo a
 * credential) is discarded. */
const WORKOS_ERRORS = new Set(["invalid_credentials", "invalid_grant", "invalid_client", "unauthorized_client", "email_verification_required",
  "mfa_enrollment", "mfa_challenge", "sso_required", "organization_authentication_methods_required", "organization_selection_required",
  "user_not_found", "rate_limit_exceeded", "invalid_request", "access_denied"]);
/** WorkOS's error code name (`code`, or OAuth's `error`) as `_<name>` when it is a known one; the body is otherwise discarded. */
function workosErrorCode(body: unknown): string {
  const value = body as { code?: unknown; error?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code : typeof value?.error === "string" ? value.error : "";
  return WORKOS_ERRORS.has(code) ? `_${code}` : "";
}

export async function gate0SignIn(input: { clientId: string; apiKey: string; email: string; password: string; subject: string; organizationId?: string;
  /** When WorkOS asks a member of several organizations to choose and no organizationId is given: which offered one to take. */
  selectOrganization?(offered: readonly string[]): string | undefined },
  fetchImpl: typeof fetch = fetch) {
  const origin = "https://api.workos.com/user_management";
  let accessToken = "", refreshToken = "", sessionId = "", expiresAt = 0;
  const request = async (path: string, body: unknown, revoke = false) => {
    try {
      const response = await fetchImpl(`${origin}/${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", ...(revoke ? { authorization: `Bearer ${input.apiKey}` } : {}) }, body: JSON.stringify(body) });
      // WorkOS asks a member of several organizations to choose one; that reply issues no session.
      if (!revoke && response.status === 403) {
        const body: unknown = await response.json().catch(() => null), selection = OrganizationSelection.safeParse(body);
        if (selection.success) return selection.data;
        throw new Gate0Failure("sign_in", `http_403${workosErrorCode(body)}`);
      }
      // A failure is http_<status>, plus WorkOS's own error code name when it gives one (never its message or body).
      if (!response.ok) throw new Gate0Failure(revoke ? "sign_out" : "sign_in", `http_${response.status}${workosErrorCode(await response.json().catch(() => null))}`);
      if (revoke) { await response.body?.cancel(); return undefined; }
      return await response.json();
    } catch (error) { throw error instanceof Gate0Failure ? error : new Gate0Failure(revoke ? "sign_out" : "sign_in", "network"); }
  };
  let chosen: string | undefined;
  const authenticate = async (grant: Record<string, string>) => {
    let reply: unknown = await request("authenticate", { client_id: input.clientId, client_secret: input.apiKey, ...grant });
    const selection = grant.grant_type === "password" ? OrganizationSelection.safeParse(reply) : undefined;
    if (selection?.success) {
      const pending = selection.data;
      if (pending.user.id !== input.subject || pending.user.email.toLowerCase() !== input.email.toLowerCase()) throw new Gate0Failure("sign_in_identity", "user");
      chosen = input.organizationId ?? input.selectOrganization?.(pending.organizations.map(org => org.id));
      if (!chosen) throw new Gate0Failure("sign_in_organization", "selection_required");
      if (!pending.organizations.some(org => org.id === chosen)) throw new Gate0Failure("sign_in_organization", "not_offered");
      reply = await request("authenticate", { client_id: input.clientId, client_secret: input.apiKey,
        grant_type: "urn:workos:oauth:grant-type:organization-selection",
        pending_authentication_token: pending.pending_authentication_token, organization_id: chosen });
    }
    const parsed = z.object({ access_token: z.string().min(16), refresh_token: z.string().min(16),
      user: z.object({ id: z.string(), email: z.string(), email_verified: z.literal(true) }),
      authentication_method: z.string().optional(), organization_id: z.string().optional() }).safeParse(reply);
    if (!parsed.success) throw new Gate0Failure("sign_in", "schema");
    const value = parsed.data;
    let claims;
    try { claims = decodeJwt(value.access_token); } catch { throw new Gate0Failure("sign_in", "token"); }
    if (typeof claims.sid !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(claims.sid)) throw new Gate0Failure("sign_in", "session");
    // Retain the SID for cleanup even if the intended identity check fails.
    sessionId = claims.sid;
    // Which identity check failed, as a closed name.
    const mismatch = value.user.id !== input.subject || value.user.email.toLowerCase() !== input.email.toLowerCase() ? "user"
      : grant.grant_type === "password" && value.authentication_method !== "Password" ? "method"
        : selection?.success && value.organization_id !== chosen ? "organization"
          : typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now() ? "expired" : undefined;
    if (mismatch) throw new Gate0Failure("sign_in_identity", mismatch);
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
    local: { type: "boolean" }, alpha: { type: "boolean" }, report: { type: "string" },
  } });
  if (values.help) {
    console.log("cloud-v2:gate0 [--local | --api <Dev API origin>] [--profile <private JSON>] [--agent-env <private .env.agent>] [--organization <UUID>] [--repository owner/name] [--runtime <sha256>] [--agents codex,claude,cursor] [--keep]");
    console.log("--local uses the running electron:cloud instance and its private signing key; --api may select its exact loopback port. Hosted mode reads the encrypted Dev registry. Requires an installed Computer, connected provider logins and the dedicated .env.agent test password. Creates one workspace and deletes it unless --keep is set.");
    console.log("--alpha measures deployed Alpha (`pnpm alpha:probe`): needs --organization <test org slug or UUID> or ZEROS_ALPHA_PROBE_ORGANIZATION, defaults to that organization's connected agents, and --report <path> writes the JSON metrics report.");
    console.log("Models: gpt-6-luna, claude-haiku-5-5, Cursor default. Override in .env.agent with ZEROS_GATE0_{CODEX,CLAUDE,CURSOR}_MODEL. All probe chats select low effort; Cursor Auto has no native effort control.");
    return;
  }
  if (values.alpha) {
    if (values.local || values.api || values.runtime) throw new Gate0Failure("alpha_target");
    const { runAlphaProbe } = await import("./gate0-alpha.js");
    return runAlphaProbe(values);
  }
  const root = resolve(import.meta.dirname, "../../../..");
  let profile: z.infer<typeof CommonProfile>, hosted: z.infer<typeof Profile> | undefined;
  let localState: z.infer<typeof LocalState> | undefined, env: NodeJS.Dict<string>;
  try {
    if (values.local) {
      const [{ loadProfile }, { derivedWorkspaceIdentity, readPrivateJson }] = await Promise.all([
        import(pathToFileURL(resolve(root, "scripts/dev-environment/profile.mjs")).href),
        import(pathToFileURL(resolve(root, "scripts/dev-environment/state.mjs")).href),
      ]);
      profile = CommonProfile.parse(loadProfile(undefined, { root, env: { ...process.env,
        ...(values.profile ? { ZEROS_DEV_PROFILE_PATH: resolve(values.profile) } : {}) } }));
      const identity = derivedWorkspaceIdentity(root, process.env);
      // Read only: gate0 must not create a new local instance or rotate its key.
      localState = LocalState.parse(readPrivateJson(resolve(homedir(), ".zeros-dev/environments", identity.owner, "workspace.json")));
      if (localState.owner !== identity.owner || localState.identity !== identity.identity) throw new Error();
    } else {
      hosted = Profile.parse(JSON.parse(readFileSync(values.profile ?? resolve(root, "zeros-dev-env.json"), "utf8")));
      profile = hosted;
    }
    env = parseEnv(readFileSync(values["agent-env"] ?? resolve(root, ".env.agent"), "utf8"));
  } catch { throw new Gate0Failure("private_configuration"); }
  const local = localState ? { owner: localState.owner, runId: localState.launcher.runId, apiPort: localState.ports.api } : undefined;
  const target = local ? gate0LocalTarget(values.api, profile.cloudflare.domain, local) : gate0DevTarget(values.api ?? "", profile.cloudflare.domain);
  const agents = z.array(z.enum(GATE0_AGENTS)).min(1).parse((values.agents ?? GATE0_AGENTS.join(",")).split(","));
  const repository = values.repository ?? env.ZEROS_DEV_REPOSITORY;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Gate0Failure("repository_configuration");
  const email = profile.fixture?.expectedEmail ?? env.ZEROS_DEV_EMAIL;
  const subject = profile.fixture?.workosUserId ?? env.ZEROS_DEV_WORKOS_SUBJECT;
  if (!email || !subject || !env.ZEROS_DEV_PASSWORD) throw new Gate0Failure("test_login_configuration");
  if (values.runtime && !/^[a-f0-9]{64}$/.test(values.runtime)) throw new Gate0Failure("runtime_pin");
  let generation: string | undefined;
  try {
    const response = await fetch(`${target.origin}/healthz`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const health: unknown = await response.json();
    if (local) gate0LocalIdentity(health, local);
    else generation = z.object({ ok: z.literal(true), development: z.object({ owner: z.literal(target.owner), generation: z.string().uuid() }) }).parse(health).development.generation;
  } catch { throw new Gate0Failure("dev_identity"); }
  let transportProbe, readTimings;
  try {
    const { cloudV2WorkerSigningKey } = await import(pathToFileURL(resolve(root, "scripts/dev-environment/cloud-v2-keys.mjs")).href);
    let state = localState;
    if (!state) {
      const { r2Registry } = await import(pathToFileURL(resolve(root, "scripts/dev-environment/hosted-state.mjs")).href);
      const receipt = await r2Registry(hosted!.registry).read(target.owner);
      if (receipt?.state?.owner !== target.owner || receipt.state.generation !== generation) throw new Error();
      state = receipt.state;
    }
    const signer = new CloudV2WorkerSigner(cloudV2WorkerSigningKey(state));
    const compute = new BoatCloudV2Compute(new BoatApiClient({ apiKey: profile.boat.apiKey, timeoutMs: 20_000,
      ...(profile.boat.billingOrg ? { billingOrg: profile.boat.billingOrg } : {}) }));
    transportProbe = createGate0TransportProbe({ compute, signer });
    readTimings = createGate0TimingReader({ compute });
  } catch { throw new Gate0Failure("transport_configuration"); }
  const session = await gate0SignIn({ clientId: profile.workos.webClientId, apiKey: profile.workos.apiKey, email, subject, password: env.ZEROS_DEV_PASSWORD,
    ...(profile.fixture?.workosOrganizationId ? { organizationId: profile.fixture.workosOrganizationId } : {}) });
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
    const result = await runCloudV2Gate0({ apiOrigin: target.origin, organizationId, repository, accessToken: session.accessToken, agents, models: gate0ModelsFromEnv(env), transportProbe,
      readTimings,
      ...(values.runtime ? { runtimeSha: values.runtime } : {}), ...(values.keep ? { keep: true } : {}), log: message => console.log(`[gate0] ${message}`) });
    const skipped = GATE0_AGENTS.filter(agent => !agents.includes(agent));
    if (skipped.length) console.log(`[gate0] Not checked: ${skipped.join(", ")}`);
    console.log(`[gate0] PASSED; workspace ${result.workspaceId} ${result.deleted ? "deleted" : "retained (--keep)"}`);
  } finally { await session.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Gate0Failure ? error.message : "Cloud v2 gate0 failed; details withheld"); process.exitCode = 1; });
}

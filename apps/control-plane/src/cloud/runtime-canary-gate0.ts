import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { gate0SignIn } from "./gate0-cli.js";
import { GATE0_AGENTS, Gate0Failure, runCloudV2Gate0 } from "./gate0.js";
import { RuntimeCanaryClaimsSchema } from "./runtime-canary.js";
import { RuntimeCanaryReceiptSchema, type RuntimeCanaryReceipt } from "./runtime-release.js";

const ALPHA_ORIGIN = "https://api-alpha.zeros.build";
const Configuration = z.object({
  expectedCpSha: z.string().regex(/^[a-f0-9]{40}$/), expectedRuntimeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
  canary: z.object({ token: z.string().min(1).max(4096), claims: RuntimeCanaryClaimsSchema }).strict(),
  login: z.object({ clientId: z.string().regex(/^client_[A-Za-z0-9_-]+$/), apiKey: z.string().min(16), email: z.string().email(),
    password: z.string().min(1), subject: z.string().regex(/^user_[A-Za-z0-9_-]+$/), organizationId: z.string().regex(/^org_[A-Za-z0-9_-]+$/).optional() }).strict(),
}).strict();
type Configuration = z.infer<typeof Configuration>;

export function loadAlphaRuntimeCanary(env: NodeJS.ProcessEnv): Configuration {
  try {
    const raw = env.CLOUD_RUNTIME_CANARY_CLAIMS ?? "";
    if (raw.length > 4096) throw new Error();
    return Configuration.parse({ expectedCpSha: env.CLOUD_RUNTIME_RELEASE_CP_SHA, expectedRuntimeSha256: env.CLOUD_RUNTIME_RELEASE_PRIOR_SHA256,
      repository: env.CLOUD_RUNTIME_CANARY_REPOSITORY,
      canary: { token: env.CLOUD_RUNTIME_CANARY_GRANT, claims: JSON.parse(raw) },
      login: { clientId: env.WORKOS_CLIENT_ID, apiKey: env.WORKOS_API_KEY, email: env.CLOUD_RUNTIME_FIXTURE_EMAIL,
        password: env.CLOUD_RUNTIME_FIXTURE_PASSWORD, subject: env.CLOUD_RUNTIME_FIXTURE_WORKOS_USER_ID,
        ...(env.CLOUD_RUNTIME_FIXTURE_WORKOS_ORGANIZATION_ID ? { organizationId: env.CLOUD_RUNTIME_FIXTURE_WORKOS_ORGANIZATION_ID } : {}) } });
  } catch { throw new Gate0Failure("alpha_canary_configuration"); }
}

export async function runAlphaRuntimeCanary(input: Configuration, deps: {
  fetch?: typeof fetch; signIn?: typeof gate0SignIn; gate0?: typeof runCloudV2Gate0; log?(message: string): void;
} = {}): Promise<RuntimeCanaryReceipt> {
  const options = Configuration.safeParse(input);
  if (!options.success) throw new Gate0Failure("alpha_canary_configuration");
  const config = options.data, fetchImpl = deps.fetch ?? fetch, claims = config.canary.claims;
  async function request(path: string, stage: string, token?: string): Promise<unknown> {
    try {
      const response = await fetchImpl(`${ALPHA_ORIGIN}${path}`, { redirect: "error", signal: AbortSignal.timeout(15_000),
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      return await response.json();
    } catch { throw new Gate0Failure(stage); }
  }
  async function identity() {
    const value = await request("/v1/release-identity", "alpha_release_identity");
    const checked = z.object({ version: z.literal(1), channel: z.literal("alpha"), ready: z.literal(true), maintenance: z.literal(false),
      sourceSha: z.literal(config.expectedCpSha), runtimeCanaryAdmission: z.literal(1), migrations: z.object({ state: z.literal("current") }),
      cloud: z.object({ enabled: z.literal(true), ready: z.literal(true), state: z.literal("healthy") }),
      worker: z.object({ sha256: z.literal(config.expectedRuntimeSha256) }) }).safeParse(value);
    if (!checked.success) throw new Gate0Failure("alpha_release_identity");
  }
  await identity();
  const { organizationId, ...login } = config.login;
  const session = await (deps.signIn ?? gate0SignIn)({ ...login, ...(organizationId ? { organizationId } : {}) }, fetchImpl);
  let proof: RuntimeCanaryReceipt | undefined, failure: Gate0Failure | undefined;
  try {
    const value = await request("/v1/me", "fixture_identity", await session.accessToken());
    const me = z.object({ user: z.object({ id: z.literal(claims.creatorUserId), staffRole: z.null() }),
      organizations: z.array(z.object({ id: z.string().uuid(), isPersonal: z.boolean() })) }).safeParse(value);
    if (!me.success || !me.data.organizations.some(org => org.id === claims.organizationId && !org.isPersonal)) throw new Gate0Failure("fixture_identity");
    const loginValue = await request(`/v1/organizations/${claims.organizationId}/agent-connections`, "provider_logins", await session.accessToken());
    const logins = z.object({ connections: z.array(z.object({ provider: z.string(), connected: z.boolean() })) }).safeParse(loginValue);
    if (!logins.success || !GATE0_AGENTS.every(agent => logins.data.connections.some(row => row.provider === agent && row.connected))) throw new Gate0Failure("provider_logins");
    const result = await (deps.gate0 ?? runCloudV2Gate0)({ apiOrigin: ALPHA_ORIGIN, organizationId: claims.organizationId,
      repository: config.repository, runtimeSha: claims.runtimeSha256, canary: config.canary, accessToken: session.accessToken,
      agents: GATE0_AGENTS, keep: false, fetch: fetchImpl, ...(deps.log ? { log: deps.log } : {}) });
    if (!result.deleted) throw new Gate0Failure("canary_cleanup");
    await identity();
    proof = RuntimeCanaryReceiptSchema.parse({ version: 1, channel: "alpha", cpSourceSha: config.expectedCpSha,
      previousRuntimeSha256: config.expectedRuntimeSha256, runtimeSha256: claims.runtimeSha256, sourceSha: claims.sourceSha,
      grantId: claims.jti, workspaceId: result.workspaceId, creatorUserId: claims.creatorUserId, organizationId: claims.organizationId,
      repositoryId: claims.repositoryId, runId: claims.runId, runAttempt: claims.runAttempt, agents: result.agents,
      deleted: true, completedAt: new Date().toISOString() });
  } catch (error) { failure = error instanceof Gate0Failure ? error : new Gate0Failure("alpha_canary"); }
  try { await session.close(); } catch { failure ??= new Gate0Failure("sign_out"); }
  if (failure || !proof) throw failure ?? new Gate0Failure("alpha_canary");
  return proof;
}

async function main() {
  const { values } = parseArgs({ options: { receipt: { type: "string" } } });
  if (!values.receipt) throw new Gate0Failure("receipt_path");
  const proof = await runAlphaRuntimeCanary(loadAlphaRuntimeCanary(process.env), { log: message => console.log(`[runtime-canary] ${message}`) });
  await writeFile(values.receipt, JSON.stringify(proof) + "\n", { mode: 0o600, flag: "wx" });
  console.log("[runtime-canary] passed; candidate deleted");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Gate0Failure ? error.message : "Cloud runtime canary failed; details withheld"); process.exitCode = 1; });
}

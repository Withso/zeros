import { z } from "zod";
import type { createMigrationPool } from "../../apps/control-plane/src/db";
import { gate0SignIn } from "../../apps/control-plane/src/cloud/gate0-cli";
import { loadAlphaRuntimeCanary, runAlphaRuntimeCanary } from "../../apps/control-plane/src/cloud/runtime-canary-gate0";
import type { RuntimeCanaryReceipt } from "../../apps/control-plane/src/cloud/runtime-release";
import { loadRuntimeCanaryPolicy, RuntimeCanaryClaimsSchema } from "../../apps/control-plane/src/cloud/runtime-canary";
import { PromotionError, requireCheck } from "./contracts";
import { closeReleaseCanary, closeRecordedCanary, cleanupRecordedCanary, createReleaseCanary, recordedCanary,
  type ClosedCanary, type ReleaseCanary, type RecordedCanary } from "./runtime-canary";
import { runtimeOrigin, type RuntimeManifest, type RuntimeReleaseConfig } from "./runtime-contracts";
import type { RuntimeEventDetail } from "./runtime-journal";
import { qualifiedRuntime } from "./runtime-proof";
import { sleep } from "./io";

export async function qualifyRuntime(config: RuntimeReleaseConfig, manifest: RuntimeManifest, env: NodeJS.ProcessEnv,
  pool: ReturnType<typeof createMigrationPool>, deps: {
    record(value: RuntimeEventDetail): Promise<void>;
    run?: typeof runAlphaRuntimeCanary; signIn?: typeof gate0SignIn; fetch?: typeof fetch;
    close?(canary: ReleaseCanary): Promise<ClosedCanary>; pause?: () => Promise<void>; signal?: AbortSignal;
  }) {
  const canary = createReleaseCanary(config, manifest, env), fetcher = deps.fetch ?? fetch;
  const input = loadAlphaRuntimeCanary({ ...env, CLOUD_RUNTIME_CANARY_GRANT: canary.token,
    CLOUD_RUNTIME_CANARY_CLAIMS: JSON.stringify(canary.claims), CLOUD_RUNTIME_RELEASE_CP_SHA: config.expectedCpSha,
    CLOUD_RUNTIME_RELEASE_PRIOR_SHA256: config.expectedRuntimeSha256 });
  let proof: RuntimeCanaryReceipt | undefined, failed = false;
  try {
    await deps.record({ kind: "canary", ...recordedCanary(canary), keyId: env.CLOUD_RUNTIME_CANARY_KEY_ID! });
    requireCheck(!deps.signal?.aborted, "Runtime qualification cancelled");
    const activeFetch: typeof fetch = (url, init) => fetcher(url, { ...init,
      ...(deps.signal ? { signal: AbortSignal.any([deps.signal, ...(init?.signal ? [init.signal] : [])]) } : {}) });
    proof = await (deps.run ?? runAlphaRuntimeCanary)(input, { fetch: activeFetch });
  } catch { failed = true; }
  let cleanup: { deleted: true; workspaceId: string | null } | undefined;
  try {
    cleanup = await retireRuntimeCanary(config, recordedCanary(canary), env, pool, { ...deps,
      close: () => deps.close ? deps.close(canary) : closeReleaseCanary(pool, canary) });
    await deps.record({ kind: "canary-cleanup", grantId: canary.claims.jti, ...cleanup });
  } catch { failed = true; }
  if (failed || !proof || !cleanup || deps.signal?.aborted) throw new PromotionError("Alpha qualification or cleanup failed; no pin authority was produced, details withheld");
  return qualifiedRuntime(config, manifest, canary, proof, cleanup);
}

export async function retireRuntimeCanary(config: RuntimeReleaseConfig, canary: RecordedCanary, env: NodeJS.ProcessEnv,
  pool: ReturnType<typeof createMigrationPool>, deps: {
    signIn?: typeof gate0SignIn; fetch?: typeof fetch; close?(): Promise<ClosedCanary>; pause?: () => Promise<void>;
  } = {}): Promise<{ deleted: true; workspaceId: string | null }> {
  const claims = RuntimeCanaryClaimsSchema.parse(canary.claims), policy = loadRuntimeCanaryPolicy(env.CLOUD_V2_RUNTIME_CANARY_CONFIG, "alpha");
  requireCheck(config.channel === "alpha" && claims.runId === config.runId && claims.runAttempt === config.runAttempt &&
    claims.creatorUserId === policy?.fixture.creatorUserId && claims.organizationId === policy.fixture.organizationId &&
    claims.repositoryId === policy.fixture.repositoryId && (config.action !== "publish" || claims.sourceSha === config.sourceSha),
    "Canary retirement differs from the dedicated release fixture");
  const login = z.object({ clientId: z.string().regex(/^client_[A-Za-z0-9_-]+$/), apiKey: z.string().min(16), email: z.string().email(),
    password: z.string().min(1), subject: z.string().regex(/^user_[A-Za-z0-9_-]+$/), organizationId: z.string().regex(/^org_[A-Za-z0-9_-]+$/).optional() }).parse({
    clientId: env.WORKOS_CLIENT_ID, apiKey: env.WORKOS_API_KEY, email: env.CLOUD_RUNTIME_FIXTURE_EMAIL, password: env.CLOUD_RUNTIME_FIXTURE_PASSWORD,
    subject: env.CLOUD_RUNTIME_FIXTURE_WORKOS_USER_ID, ...(env.CLOUD_RUNTIME_FIXTURE_WORKOS_ORGANIZATION_ID ? { organizationId: env.CLOUD_RUNTIME_FIXTURE_WORKOS_ORGANIZATION_ID } : {}),
  });
  const fetcher = deps.fetch ?? fetch;
  let session: Awaited<ReturnType<typeof gate0SignIn>> | undefined;
  const request = async (path: string, method = "GET") => {
    requireCheck(session, "Canary cleanup requires its fixture login");
    const reply = await fetcher(`${runtimeOrigin(config.channel)}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${await session.accessToken()}` } });
    if (method === "DELETE") {
      requireCheck(reply.ok || reply.status === 404, "Canary deletion was refused");
      await reply.body?.cancel(); return null;
    }
    requireCheck(reply.ok, "Canary cleanup identity was refused");
    const bytes = await reply.text(); requireCheck(bytes.length <= 64 * 1024, "Canary cleanup response exceeds its bound");
    return JSON.parse(bytes);
  };
  try {
    return await cleanupRecordedCanary(canary, {
      close: () => deps.close ? deps.close() : closeRecordedCanary(pool, canary),
      remove: async workspaceId => {
        session = await (deps.signIn ?? gate0SignIn)(login, fetcher);
        const me = z.object({ user: z.object({ id: z.literal(canary.claims.creatorUserId), staffRole: z.null() }),
          organizations: z.array(z.object({ id: z.string().uuid(), isPersonal: z.boolean() })) }).safeParse(await request("/v1/me"));
        requireCheck(me.success && me.data.organizations.some(row => row.id === canary.claims.organizationId && !row.isPersonal),
          "Canary cleanup login differs from the dedicated fixture");
        await request(`/v1/cloud-v2/workspaces/${workspaceId}`, "DELETE");
      },
      status: () => request(`/v1/cloud-v2/runtime-canaries/${canary.claims.jti}`),
      pause: deps.pause ?? (() => sleep(1000)),
    });
  } finally { await session?.close(); }
}

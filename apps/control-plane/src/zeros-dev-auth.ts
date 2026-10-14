import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "./config.js";
import { cloudWorkspaceChannelEnabled } from "./cloud-workspaces/channel-policy.js";
import { ZerosDevAuthError } from "./zeros-dev-auth-config.js";
import type { ZerosDevAuthRepository, ZerosDevAuthOutcome } from "./zeros-dev-auth-repository.js";
import { abortable, boundedJson, type ZerosDevIssuedGrant, type ZerosDevPasswordProvider } from "./zeros-dev-auth-workos.js";

export const ZEROS_DEV_AUTH_PATH = "/auth/zeros-dev/session";
export const ZerosDevAuthRequest = z.object({
  password: z.string().min(1).max(1024),
  requestId: z.string().uuid(),
  device: z.object({ id: z.string().uuid(), intent: z.enum(["register", "reuse"]), platform: z.literal("linux") }).strict(),
}).strict();
export type ZerosDevAuthRequest = z.infer<typeof ZerosDevAuthRequest>;

/** Cheap abuse backstop before buffering/DB. The repository's audited limits
 * are also serialized across every CP replica, so restart/headers cannot reset
 * the deployment-wide budget. This map is bounded by the global budget. */
export class ZerosDevAuthLimiter {
  private start = -Infinity;
  private global = 0;
  private readonly sources = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  take(source: string): boolean {
    const now = this.now();
    if (now < this.start || now - this.start >= 60_000) { this.start = now; this.global = 0; this.sources.clear(); }
    const count = this.sources.get(source) ?? 0;
    if (this.global >= 20 || count >= 5) return false;
    this.global++; this.sources.set(source, count + 1);
    return true;
  }
}

export function zerosDevAuthEnabled(config: Config): boolean {
  return config.deploymentChannel === "alpha" && cloudWorkspaceChannelEnabled(config.deploymentChannel) &&
    !!config.zerosDevAuth && config.auth.provider === "workos" && !!config.workos;
}

export type ZerosDevAuthDependencies = {
  repository: ZerosDevAuthRepository;
  provider: ZerosDevPasswordProvider;
  timeoutMs?: number;
};

function response(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });
}

export function createZerosDevAuthRoutes(config: Config, dependencies: ZerosDevAuthDependencies): Hono {
  const app = new Hono();
  if (!zerosDevAuthEnabled(config)) return app;
  const identity = config.zerosDevAuth!;
  const limiter = new ZerosDevAuthLimiter();
  const { repository, provider } = dependencies;
  const revoke = async (grant: ZerosDevIssuedGrant) => {
    // Local tombstone and existing WorkOS outbox survive transient provider
    // failure. Neither failure can make the held session a successful result.
    const signal = AbortSignal.timeout(2_000);
    const results=await Promise.allSettled([
      abortable(repository.revoke(identity, grant.sessionId), signal),
      abortable(provider.revoke(grant.sessionId, signal), signal),
    ]);
    return results.every(result=>result.status==="fulfilled") ? "retired" as const : "pending" as const;
  };
  app.post(ZEROS_DEV_AUTH_PATH, async c => {
    // Railway terminates the public edge and supplies X-Real-IP. Do not trust
    // X-Forwarded-For/CF values from a caller; missing peers share one bucket.
    const peer = c.req.header("X-Real-IP")?.trim() ?? "";
    const source = isIP(peer) ? peer : "unknown";
    if (!limiter.take(source)) return response(429, "zeros_dev_auth_rate_limited");
    const deadline = AbortSignal.timeout(dependencies.timeoutMs ?? 5_000);
    const signal = AbortSignal.any([deadline, c.req.raw.signal]);
    let parsed: z.SafeParseReturnType<unknown, ZerosDevAuthRequest>;
    try {
      if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
        return response(400, "zeros_dev_auth_invalid_request");
      parsed = ZerosDevAuthRequest.safeParse(await boundedJson(c.req.raw, 4096, signal));
    } catch { return response(signal.aborted ? 503 : 400, signal.aborted ? "zeros_dev_auth_unavailable" : "zeros_dev_auth_invalid_request"); }
    if (!parsed.success) return response(400, "zeros_dev_auth_invalid_request");
    const input = parsed.data;
    const sourceHash = createHash("sha256").update(`zeros-dev-source-v1:${source}`).digest("hex");
    const phase: { stage: "database" | "provider" } = { stage: "database" };
    const operation = async () => {
      let grant: ZerosDevIssuedGrant | undefined;
      let succeeded = false;
      let reserved = false;
      let issuing = false;
      let outcome: ZerosDevAuthOutcome["outcome"] = "unavailable";
      try {
        await repository.begin(identity, input, sourceHash);
        reserved = true;
        signal.throwIfAborted();
        phase.stage = "provider";
        issuing = true;
        grant = await provider.issue(identity, input.password, signal);
        signal.throwIfAborted();
        const claims = await provider.verify(grant.accessToken);
        if (grant.authenticationMethod !== "Password" || !grant.refreshToken || !grant.emailVerified ||
            grant.subject !== identity.subject || grant.email !== identity.email || claims.emailVerified !== true ||
            claims.clientKind !== "desktop" || config.auth.provider !== "workos" || claims.clientId !== config.auth.desktopClientId ||
            claims.providerSubject !== identity.subject ||
            claims.email !== identity.email || claims.sessionId !== grant.sessionId)
          throw new ZerosDevAuthError("denied");
        signal.throwIfAborted();
        phase.stage = "database";
        await repository.commit(identity, input, claims);
        signal.throwIfAborted();
        succeeded = true;
        return { accountId: identity.accountId, organizationId: identity.organizationId,
          session: { accessToken: grant.accessToken, refreshToken: grant.refreshToken, expiresAt: claims.expiresAt * 1000,
            providerSubject: claims.providerSubject, sessionId: claims.sessionId, clientKind: "desktop",
            email: claims.email, name: claims.displayName, authenticationMethod: "Password" } };
      } catch(error) {
        const kind = signal.aborted ? "unavailable" : error instanceof ZerosDevAuthError ? error.kind :
          phase.stage === "provider" && grant ? "denied" : "unavailable";
        outcome = issuing && !grant && kind !== "denied" ? "unknown_issuance" : kind === "denied" ? "denied" : "unavailable";
        throw new ZerosDevAuthError(kind);
      } finally {
        if (!succeeded && reserved) {
          const cleanup = grant ? await revoke(grant) : outcome === "unknown_issuance" ? "unknown" : "not_needed";
          // A denied attempt cannot become successful if its diagnostic audit
          // fails. The issuance audit above remains mandatory for every success.
          await abortable(repository.finish(identity, input, {outcome,cleanup}), AbortSignal.timeout(2_000)).catch(()=>{});
        }
      }
    };
    try {
      const result = await abortable(operation(), signal);
      return c.json(result, 200, { "cache-control": "no-store", pragma: "no-cache" });
    } catch (error) {
      const kind = signal.aborted ? "unavailable" : error instanceof ZerosDevAuthError ? error.kind : phase.stage === "provider" ? "denied" : "unavailable";
      return response(kind === "rate_limited" ? 429 : kind === "denied" ? 401 : 503, `zeros_dev_auth_${kind}`);
    }
  });
  return app;
}

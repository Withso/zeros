import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "./config.js";
import type { AuthTokenClaims } from "./auth-token-contract.js";
import { cloudWorkspaceChannelEnabled } from "./cloud-workspaces/channel-policy.js";
import { ZerosDevAuthError } from "./zeros-dev-auth-config.js";
import type { ZerosDevAuthRepository, ZerosDevAuthOutcome } from "./zeros-dev-auth-repository.js";
import { abortable, boundedJson, type ZerosDevIssuedGrant, type ZerosDevPasswordProvider } from "./zeros-dev-auth-workos.js";

export const ZEROS_DEV_AUTH_PATH = "/auth/zeros-dev/session";
export const ZEROS_DEV_AUTH_PATHS = {
  login: ZEROS_DEV_AUTH_PATH,
  refresh: "/auth/zeros-dev/refresh",
  revoke: "/auth/zeros-dev/revoke",
} as const;
export const ZerosDevAuthRequest = z.object({
  password: z.string().min(1).max(1024),
  requestId: z.string().uuid(),
  device: z.object({ id: z.string().uuid(), intent: z.enum(["register", "reuse"]), platform: z.literal("linux") }).strict(),
}).strict();
export type ZerosDevAuthRequest = z.infer<typeof ZerosDevAuthRequest>;
export type ZerosDevAuthAttempt = Pick<ZerosDevAuthRequest, "requestId" | "device">;
const SessionRequest = ZerosDevAuthRequest.omit({ password: true });
const RefreshRequest = SessionRequest.extend({ refreshToken: z.string().min(1).max(64 * 1024) }).strict();

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
  const revoke = async (sessionId: string) => {
    // Local tombstone and existing WorkOS outbox survive transient provider
    // failure. Neither failure can make the held session a successful result.
    const signal = AbortSignal.timeout(2_000);
    const results=await Promise.allSettled([
      abortable(repository.revoke(identity, sessionId), signal),
      abortable(provider.revoke(sessionId, signal), signal),
    ]);
    return results.every(result=>result.status==="fulfilled") ? "retired" as const : "pending" as const;
  };
  const assertClaims = (claims: AuthTokenClaims) => {
    if (config.auth.provider !== "workos" || claims.clientKind !== "web" || claims.clientId !== config.auth.webClientId ||
        claims.providerSubject !== identity.subject || claims.email !== identity.email || claims.emailVerified !== true)
      throw new ZerosDevAuthError("denied");
  };
  for (const operation of ["login", "refresh", "revoke"] as const) {
    const schema = operation === "login" ? ZerosDevAuthRequest : operation === "refresh" ? RefreshRequest : SessionRequest;
    app.post(ZEROS_DEV_AUTH_PATHS[operation], async c => {
      // Railway terminates the public edge and supplies X-Real-IP. Do not trust
      // X-Forwarded-For/CF values from a caller; missing peers share one bucket.
      const peer = c.req.header("X-Real-IP")?.trim() ?? "";
      const source = isIP(peer) ? peer : "unknown";
      if (!limiter.take(source)) return response(429, "zeros_dev_auth_rate_limited");
      const deadline = AbortSignal.timeout(dependencies.timeoutMs ?? 5_000);
      const signal = AbortSignal.any([deadline, c.req.raw.signal]);
      let parsed: z.SafeParseReturnType<unknown, ZerosDevAuthRequest | z.infer<typeof RefreshRequest> | ZerosDevAuthAttempt>;
      try {
        if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
          return response(400, "zeros_dev_auth_invalid_request");
        parsed = schema.safeParse(await boundedJson(c.req.raw, operation === "refresh" ? 70 * 1024 : 4096, signal));
      } catch { return response(signal.aborted ? 503 : 400, signal.aborted ? "zeros_dev_auth_unavailable" : "zeros_dev_auth_invalid_request"); }
      if (!parsed.success) return response(400, "zeros_dev_auth_invalid_request");
      const input = parsed.data;
      const sourceHash = createHash("sha256").update(`zeros-dev-source-v1:${source}`).digest("hex");
      const phase: { stage: "database" | "provider" } = { stage: "database" };
      const perform = async () => {
        let grant: ZerosDevIssuedGrant | undefined;
        let previousSessionId: string | undefined;
        let succeeded = false;
        let reserved = false;
        let issuing = false;
        let outcome: ZerosDevAuthOutcome["outcome"] = "unavailable";
        try {
          if (operation !== "login") {
            const header = c.req.header("authorization") ?? "";
            if (!/^Bearer [^\s]+$/.test(header) || header.length > 64 * 1024 + 7)
              throw new ZerosDevAuthError("denied");
            let proof: AuthTokenClaims;
            try { proof = await provider.verifySessionProof(header.slice(7)); }
            catch { throw new ZerosDevAuthError("denied"); }
            assertClaims(proof);
            previousSessionId = proof.sessionId;
            signal.throwIfAborted();
            await repository.begin(identity, input, sourceHash, { sessionId: previousSessionId, operation });
          } else await repository.begin(identity, input, sourceHash);
          reserved = true;
          signal.throwIfAborted();
          if (operation === "revoke") {
            await repository.revoke(identity, previousSessionId!, input);
            signal.throwIfAborted();
            phase.stage = "provider";
            await provider.revoke(previousSessionId!, signal);
            signal.throwIfAborted();
            succeeded = true;
            return { revoked: 1 };
          }
          phase.stage = "provider";
          issuing = true;
          grant = operation === "login"
            ? await provider.issue(identity, (input as ZerosDevAuthRequest).password, signal)
            : await provider.refresh((input as z.infer<typeof RefreshRequest>).refreshToken, signal);
          signal.throwIfAborted();
          const claims = await provider.verify(grant.accessToken);
          assertClaims(claims);
          // Refresh may omit authentication_method; its original Password
          // ceremony is pinned by the issuance audit. Challenges never continue.
          if (grant.challengePresent || (operation === "login" ? grant.authenticationMethod !== "Password" :
                !!grant.authenticationMethod && grant.authenticationMethod !== "Password") ||
              !grant.refreshToken || !grant.emailVerified || grant.subject !== identity.subject || grant.email !== identity.email ||
              claims.sessionId !== grant.sessionId || (previousSessionId && claims.sessionId !== previousSessionId))
            throw new ZerosDevAuthError("denied");
          signal.throwIfAborted();
          phase.stage = "database";
          if (operation === "refresh") await repository.commit(identity, input, claims, "refresh");
          else await repository.commit(identity, input, claims);
          signal.throwIfAborted();
          succeeded = true;
          return { accountId: identity.accountId, organizationId: identity.organizationId,
            session: { accessToken: grant.accessToken, refreshToken: grant.refreshToken, expiresAt: claims.expiresAt * 1000,
              providerSubject: claims.providerSubject, sessionId: claims.sessionId, clientKind: claims.clientKind,
              email: claims.email, name: claims.displayName, authenticationMethod: "Password" } };
        } catch(error) {
          const kind = signal.aborted ? "unavailable" : error instanceof ZerosDevAuthError ? error.kind :
            phase.stage === "provider" && grant ? "denied" : "unavailable";
          outcome = issuing && !grant && kind !== "denied" ? "unknown_issuance" : kind === "denied" ? "denied" : "unavailable";
          throw new ZerosDevAuthError(kind);
        } finally {
          if (!succeeded && reserved) {
            const sessions = new Set([grant?.sessionId, issuing || operation === "revoke" ? previousSessionId : undefined]
              .filter((value): value is string => !!value));
            const retired = await Promise.all([...sessions].map(revoke));
            const cleanup = sessions.size ? retired.every(value => value === "retired") ? "retired" : "pending" :
              outcome === "unknown_issuance" ? "unknown" : "not_needed";
            // A denied attempt cannot become successful if its diagnostic audit
            // fails. The issuance audit above remains mandatory for every success.
            await abortable(repository.finish(identity, input, {outcome,cleanup}), AbortSignal.timeout(2_000)).catch(()=>{});
          }
        }
      };
      try {
        const result = await abortable(perform(), signal);
        return c.json(result, 200, { "cache-control": "no-store", pragma: "no-cache" });
      } catch (error) {
        const kind = signal.aborted ? "unavailable" : error instanceof ZerosDevAuthError ? error.kind : phase.stage === "provider" ? "denied" : "unavailable";
        return response(kind === "rate_limited" ? 429 : kind === "denied" ? 401 : 503, `zeros_dev_auth_${kind}`);
      }
    });
  }
  return app;
}

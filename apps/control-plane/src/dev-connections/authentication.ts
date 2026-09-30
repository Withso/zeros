import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { WorkOS } from "@workos-inc/node";
import {
  authTokenVerifyOptions,
  validateAuthTokenClaims,
} from "../auth-token-contract.js";
import type { DevConnectionsConfig } from "./config.js";
import { DevConnectionStore } from "./store.js";
import {
  AUDIENCE,
  denied,
  type Context,
  type GenerationAuth,
  type Member,
} from "./types.js";

export type MemberVerifier = (
  token: string,
  organization: string,
) => Promise<Member>;
export function workosMemberVerifier(
  config: DevConnectionsConfig["auth"],
  getKey: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwksUrl)),
  client = new WorkOS(config.apiKey, { clientId: config.webClientId }),
): MemberVerifier {
  return async (token, organization) => {
    try {
      if (organization !== config.organization) denied();
      const { payload } = await jwtVerify(
        token,
        getKey,
        authTokenVerifyOptions(config),
      );
      const claims = validateAuthTokenClaims(payload, config);
      const [user, memberships, sessions] = await Promise.all([
        client.userManagement.getUser(claims.providerSubject),
        client.userManagement.listOrganizationMemberships({
          userId: claims.providerSubject,
          organizationId: organization,
          statuses: ["active"],
          limit: 100,
        }),
        client.userManagement.listSessions(claims.providerSubject, {
          limit: 100,
        }),
      ]);
      if (
        user.id !== claims.providerSubject ||
        !user.emailVerified ||
        !memberships.data.some(
          (m) =>
            m.userId === claims.providerSubject &&
            m.organizationId === organization &&
            m.status === "active",
        ) ||
        !sessions.data.some(
          (s) => s.id === claims.sessionId && s.status === "active",
        )
      )
        denied();
      return {
        issuer: config.issuer,
        subject: claims.providerSubject,
        organization,
        sessionId: claims.sessionId,
        expiresAt: claims.expiresAt * 1000,
      };
    } catch {
      denied();
    }
  };
}
export function generationHeaders(request: Request): GenerationAuth {
  const id = request.headers.get("x-zeros-dev-generation") ?? "",
    credential = request.headers.get("x-zeros-dev-credential") ?? "",
    audience = request.headers.get("x-zeros-dev-audience") ?? "";
  if (audience !== AUDIENCE) denied();
  return { id, credential, audience };
}
export async function authenticateMember(
  request: Request,
  store: DevConnectionStore,
  verify: MemberVerifier,
): Promise<Context> {
  const generation = generationHeaders(request),
    registered = await store.authenticateGeneration(generation);
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 20000)
    denied();
  const member = await verify(authorization.slice(7), registered.organization);
  if (member.organization !== registered.organization) denied();
  return { member, generation };
}
export function authenticateProvisioner(request: Request, expected: string) {
  const actual = request.headers.get("authorization") ?? "";
  const hash = (s: string) => createHash("sha256").update(s).digest();
  if (
    actual.length > 200 ||
    !timingSafeEqual(hash(actual), hash(`Bearer ${expected}`))
  )
    denied();
}

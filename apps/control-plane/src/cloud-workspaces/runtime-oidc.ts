import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const RUNTIME_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
export const RUNTIME_OIDC_JWKS_URL = `${RUNTIME_OIDC_ISSUER}/.well-known/jwks`;
export type RuntimeOidcPurpose = "publication" | "base_registration";
export type RuntimeOidcConfig = {
  audience: string;
  repository: string;
  environment: "alpha" | null;
};
export type RuntimePublicationProvenance = {
  runId: number;
  runNumber: number;
  runAttempt: number;
  sha: string;
  workflowRef: string;
};
export type RuntimeOidcVerifier = (
  token: string,
  purpose: RuntimeOidcPurpose,
) => Promise<RuntimePublicationProvenance>;

const workflows = {
  publication: { file: "release-alpha.yml", events: ["push"] },
  base_registration: {
    file: "cloud-runtime-base.yml",
    events: ["workflow_dispatch"],
  },
} as const;

export class RuntimeOidcError extends Error {
  constructor() {
    super("Runtime publication authentication rejected");
    this.name = "RuntimeOidcError";
  }
}

function positiveClaim(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/.test(value) ||
    value.length > 16
  )
    throw new RuntimeOidcError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum)
    throw new RuntimeOidcError();
  return parsed;
}

/** Same jose/JWKS verification mechanism as account auth, with a separate
 * issuer and a narrow workflow authority. The remote key set is created once
 * per verifier, caches GitHub keys, and reloads on key rotation. Raw JWTs and
 * jose/network exception details never cross this boundary. */
export function createRuntimeOidcVerifier(
  config: RuntimeOidcConfig,
  dependencies: { keySet?: JWTVerifyGetKey } = {},
): RuntimeOidcVerifier {
  const keys =
    dependencies.keySet ??
    createRemoteJWKSet(new URL(RUNTIME_OIDC_JWKS_URL), {
      timeoutDuration: 5_000,
    });
  return async (token, purpose) => {
    try {
      if (!token || token.length > 16 * 1024) throw new RuntimeOidcError();
      const { payload } = await jwtVerify(token, keys, {
        issuer: RUNTIME_OIDC_ISSUER,
        audience: config.audience,
        algorithms: ["RS256"],
        requiredClaims: [
          "iss",
          "aud",
          "iat",
          "exp",
          "repository",
          "workflow_ref",
          "ref",
          "event_name",
          "run_id",
          "run_number",
          "run_attempt",
          "sha",
        ],
      });
      const workflow = workflows[purpose];
      const workflowRef = `${config.repository}/.github/workflows/${workflow.file}@refs/heads/main`;
      if (
        typeof payload.repository !== "string" ||
        payload.repository.toLowerCase() !== config.repository.toLowerCase() ||
        payload.workflow_ref !== workflowRef ||
        payload.ref !== "refs/heads/main" ||
        typeof payload.event_name !== "string" ||
        !(workflow.events as readonly string[]).includes(payload.event_name) ||
        (config.environment !== null &&
          payload.environment !== config.environment) ||
        typeof payload.sha !== "string" ||
        payload.sha.length !== 40 ||
        !/^[a-f0-9]{40}$/.test(payload.sha)
      ) {
        throw new RuntimeOidcError();
      }
      return {
        runId: positiveClaim(payload.run_id),
        runNumber: positiveClaim(payload.run_number),
        runAttempt: positiveClaim(payload.run_attempt, 2_147_483_647),
        sha: payload.sha,
        workflowRef,
      };
    } catch {
      throw new RuntimeOidcError();
    }
  };
}

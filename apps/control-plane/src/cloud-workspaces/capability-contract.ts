import { z } from "zod";

/** S1 capability contract, FROZEN 1.0.0. Mirrored from
 * packages/protocol/src/cloud-capabilities.ts (the frozen source of truth):
 * the control plane type-checks and deploys without that package; parity is
 * tested in capability-contract.test.ts. Change only by an additive contract
 * minor, in lockstep with the protocol copy. */

export const CAPABILITY_CONTRACT_VERSION = 1;
export const CAPABILITY_TOKEN_TYPE = "zeros-cap+jwt";
export const CAPABILITY_ALGORITHM = "EdDSA";
export const CAPABILITY_KEY_ID_PATTERN = /^cap-[0-9]{4}-[0-9]{2}-[a-z0-9]{1,16}$/;
/** exp − iat; no leeway after exp. */
export const CAPABILITY_TOKEN_LIFETIME_SECONDS = 300;
/** Leeway on nbf only. */
export const CAPABILITY_NBF_LEEWAY_SECONDS = 30;
/** Encoded compact JWS size budget for issued tokens. */
/** Hard verifier parse ceiling (S1 verification step 1). The contract's
 * "under 1 KiB encoded" issuance budget is currently unattainable for a
 * maximal client token (5 epochs, 4 scopes, `ein`, `cnf`: 1026 bytes with a
 * 23-character issuer) - flagged for a contract minor; issuance enforces the
 * hard ceiling so a standard token is never refused. */
export const CAPABILITY_TOKEN_MAX_BYTES = 4096;
/** Verification step 1 bound. */
export const CAPABILITY_TOKEN_PARSE_MAX_BYTES = 4096;
export const CAPABILITY_POP_DOMAIN = "zeros-cap-pop-v1";
export const CAPABILITY_POP_TIMESTAMP_LEEWAY_MS = 30_000;
export const CAPABILITY_POP_REPLAY_WINDOW_MS = 300_000;
export const CAPABILITY_JWKS_PATH = "/.well-known/zeros-capabilities/jwks.json";

export const CAPABILITY_AUDIENCES = ["zeros:engine", "zeros:realtime", "zeros:api"] as const;
export type CapabilityAudience = (typeof CAPABILITY_AUDIENCES)[number];
export const CAPABILITY_KINDS = ["client", "engine"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export const CAPABILITY_CLIENT_SCOPES = ["ws:read", "ws:prompt", "ws:edit", "ws:manage"] as const;
export type CapabilityClientScope = (typeof CAPABILITY_CLIENT_SCOPES)[number];
export const CAPABILITY_ENGINE_SCOPES = [
  "engine:credentials.read",
  "engine:history.write",
  "engine:checkpoint",
] as const;
export type CapabilityEngineScope = (typeof CAPABILITY_ENGINE_SCOPES)[number];

export const CAPABILITY_ERROR_CODES = [
  "capability_missing",
  "capability_malformed",
  "capability_key_unknown",
  "capability_signature_invalid",
  "capability_issuer_mismatch",
  "capability_contract_unsupported",
  "capability_audience_mismatch",
  "capability_workspace_mismatch",
  "capability_generation_mismatch",
  "capability_not_yet_valid",
  "capability_expired",
  "capability_revoked",
  "capability_proof_invalid",
  "capability_scope_denied",
  "capability_issuer_unavailable",
] as const;
export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];

const UuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const EpochSchema = z.number().int().min(1).max(9007199254740991);
const NumericDateSchema = z.number().int().min(0).max(9007199254740991);

/** The protected header has exactly these members; a verifier rejects any
 * other member, algorithm or typ before calling its JWS library. */
export const CapabilityHeaderSchema = z
  .object({
    alg: z.literal(CAPABILITY_ALGORITHM),
    typ: z.literal(CAPABILITY_TOKEN_TYPE),
    kid: z.string().regex(CAPABILITY_KEY_ID_PATTERN),
  })
  .strict();
export type CapabilityHeader = z.infer<typeof CapabilityHeaderSchema>;

export const CapabilityEpochsSchema = z
  .object({
    wa: EpochSchema,
    wr: EpochSchema.optional(),
    me: EpochSchema.optional(),
    ac: EpochSchema.optional(),
    dk: EpochSchema.optional(),
  })
  .catchall(EpochSchema);
export type CapabilityEpochs = z.infer<typeof CapabilityEpochsSchema>;

export const CapabilityDeviceKeySchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type CapabilityDeviceKey = z.infer<typeof CapabilityDeviceKeySchema>;

const ScopeSchema = z.string().regex(/^(ws|engine):[a-z][a-z0-9.]{1,47}$/);

/** Claims schema. Unknown claims are allowed and ignored (additive minors);
 * kind-specific requirements are the frozen refinements below. `aud` is a
 * single string; an array is malformed. */
export const CapabilityClaimsSchema = z
  .object({
    iss: z.string().regex(/^https:\/\/[^/\s]+$/),
    aud: z.enum(CAPABILITY_AUDIENCES),
    sub: z
      .string()
      .regex(/^(user|engine):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    knd: z.enum(CAPABILITY_KINDS),
    org: UuidSchema,
    wsp: UuidSchema,
    gen: z.number().int().min(1).max(9007199254740991),
    ein: UuidSchema.optional(),
    role: z.enum(["viewer", "prompter", "developer", "manager", "owner"]).optional(),
    scp: z.array(ScopeSchema).min(1).max(32).refine(value => new Set(value).size === value.length, {
      message: "scopes must be unique",
    }),
    ep: CapabilityEpochsSchema,
    sid: UuidSchema.optional(),
    did: UuidSchema.optional(),
    cnf: z.object({ jwk: CapabilityDeviceKeySchema }).strict().optional(),
    iat: NumericDateSchema,
    nbf: NumericDateSchema,
    exp: NumericDateSchema,
    jti: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    cv: z.literal(CAPABILITY_CONTRACT_VERSION),
  })
  .superRefine((claims, context) => {
    const epochKeys = (keys: readonly string[]) => keys.every(key => claims.ep[key] !== undefined);
    if (claims.knd === "client") {
      if (claims.role === undefined || claims.sid === undefined || claims.did === undefined || claims.cnf === undefined)
        context.addIssue({ code: "custom", message: "client capability requires role, sid, did and cnf" });
      if (!claims.sub.startsWith("user:"))
        context.addIssue({ code: "custom", message: "client capability subject must be a user" });
      if (claims.aud === "zeros:api")
        context.addIssue({ code: "custom", message: "client capability audience must be zeros:engine or zeros:realtime" });
      if (claims.scp.some(scope => !scope.startsWith("ws:")))
        context.addIssue({ code: "custom", message: "client capability scopes must be ws:*" });
      if (!epochKeys(["wa", "wr", "me", "ac", "dk"] as const))
        context.addIssue({ code: "custom", message: "client capability requires wa, wr, me, ac and dk epochs" });
    } else {
      if (claims.ein === undefined)
        context.addIssue({ code: "custom", message: "engine capability requires ein" });
      if (claims.cnf !== undefined || claims.sid !== undefined || claims.did !== undefined)
        context.addIssue({ code: "custom", message: "engine capability forbids cnf, sid and did" });
      if (!claims.sub.startsWith("engine:"))
        context.addIssue({ code: "custom", message: "engine capability subject must be an engine" });
      if (claims.aud !== "zeros:api")
        context.addIssue({ code: "custom", message: "engine capability audience must be zeros:api" });
      if (claims.scp.some(scope => !scope.startsWith("engine:")))
        context.addIssue({ code: "custom", message: "engine capability scopes must be engine:*" });
      if (["wr", "me", "ac", "dk"].some(key => claims.ep[key] !== undefined))
        context.addIssue({ code: "custom", message: "engine capability carries only the wa epoch" });
    }
  });
export type CapabilityClaims = z.infer<typeof CapabilityClaimsSchema>;

/** Scope check per S1 step 13: the operation's scope must be present;
 * cross-kind scopes never count. */
export function capabilityGrantsScope(claims: CapabilityClaims, scope: string): boolean {
  const prefix = claims.knd === "client" ? "ws:" : "engine:";
  return scope.startsWith(prefix) && claims.scp.includes(scope);
}

/** Epoch keys a verifier requires for the kind (S1 step 7). */
export function capabilityRequiredEpochs(kind: CapabilityKind): readonly string[] {
  return kind === "client" ? ["wa", "wr", "me", "ac", "dk"] : ["wa"];
}

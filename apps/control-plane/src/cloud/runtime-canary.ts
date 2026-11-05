import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../authz.js";

export const RUNTIME_CANARY_HEADER = "x-zeros-runtime-canary";
export const RUNTIME_CANARY_MAX_SECONDS = 15 * 60;
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const repositoryId = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
const keyId = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/);
const grantHeader = z.object({ alg: z.literal("EdDSA"), typ: z.literal("zeros-runtime-canary+jwt"), kid: keyId }).strict();
export const RuntimeCanaryClaimsSchema = z.object({
  version: z.literal(1), iss: z.literal("zeros-runtime-release"), aud: z.literal("zeros-cloud-runtime-canary"), channel: z.literal("alpha"),
  jti: uuid, iat: z.number().int().nonnegative().safe(), exp: z.number().int().nonnegative().safe(),
  runId: z.string().regex(/^[1-9][0-9]{0,19}$/), runAttempt: z.number().int().min(1).max(10_000),
  runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  creatorUserId: uuid, organizationId: uuid, repositoryId,
  createKey: z.string().regex(/^[\x21-\x7e]{1,200}$/),
}).strict();
const policySchema = z.object({
  keys: z.array(z.object({ id: keyId, publicKey: z.string().min(1).max(256) }).strict()).min(1).max(2),
  fixture: z.object({ creatorUserId: uuid, organizationId: uuid, repositoryId }).strict(),
}).strict();
export type RuntimeCanaryPolicy = z.infer<typeof policySchema>;
export type RuntimeCanaryClaims = z.infer<typeof RuntimeCanaryClaimsSchema>;
export type RuntimeCanaryAdmission = Readonly<RuntimeCanaryClaims & { grantHash: string }>;
export const RuntimeCanaryStatusSchema = z.object({
  version: z.literal(1), grantId: uuid, workspaceId: uuid,
  creatorUserId: uuid, organizationId: uuid, repositoryId,
  runId: z.string().regex(/^[1-9][0-9]{0,19}$/), runAttempt: z.number().int().min(1).max(10_000),
  runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  grantSha256: z.string().regex(/^[a-f0-9]{64}$/), createKeySha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["creating", "starting", "running", "stopping", "stopped", "deleting", "deleted", "failed"]),
  deleted: z.boolean(),
}).strict();
export type RuntimeCanaryStatus = z.infer<typeof RuntimeCanaryStatusSchema>;
export const refuseRuntimeCanary = () => new HttpError(403, "cloud_runtime_canary_refused", "Runtime canary admission was refused");

function publicKey(value: string): KeyObject {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error();
  const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || !key.export({ format: "der", type: "spki" }).equals(bytes)) throw new Error();
  return key;
}

export function loadRuntimeCanaryPolicy(raw: string | undefined, channel: string): RuntimeCanaryPolicy | undefined {
  if (!raw?.trim()) return undefined;
  try {
    if (channel !== "alpha" || raw.length > 4096) throw new Error();
    const policy = policySchema.parse(JSON.parse(raw));
    if (new Set(policy.keys.map(key => key.id)).size !== policy.keys.length) throw new Error();
    for (const key of policy.keys) publicKey(key.publicKey);
    return policy;
  } catch { throw new Error("Invalid environment: CLOUD_V2_RUNTIME_CANARY_CONFIG is an Alpha-only public verification policy"); }
}

const decode = (part: string): Buffer => {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error();
  const value = Buffer.from(part, "base64url");
  if (value.toString("base64url") !== part) throw new Error();
  return value;
};

export class RuntimeCanaryAuthority {
  private readonly keys: Map<string, KeyObject>;
  constructor(readonly policy: RuntimeCanaryPolicy, private readonly now = Date.now) {
    this.keys = new Map(policy.keys.map(key => [key.id, publicKey(key.publicKey)]));
  }

  verify(token: string, request: { creatorUserId: string; organizationId: string; createKey?: string | undefined }): RuntimeCanaryAdmission {
    try {
      if (token.length > 4096) throw new Error();
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error();
      const header = grantHeader.parse(JSON.parse(decode(parts[0]!).toString("utf8")));
      const key = this.keys.get(header.kid);
      if (!key || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, decode(parts[2]!))) throw new Error();
      const claims = RuntimeCanaryClaimsSchema.parse(JSON.parse(decode(parts[1]!).toString("utf8")));
      const now = Math.floor(this.now() / 1000), fixture = this.policy.fixture;
      if (claims.exp <= now || claims.exp - now > RUNTIME_CANARY_MAX_SECONDS || claims.iat > now + 30 || claims.exp <= claims.iat || claims.exp - claims.iat > RUNTIME_CANARY_MAX_SECONDS ||
          claims.creatorUserId !== fixture.creatorUserId || claims.organizationId !== fixture.organizationId || claims.repositoryId !== fixture.repositoryId ||
          claims.creatorUserId !== request.creatorUserId.toLowerCase() || claims.organizationId !== request.organizationId.toLowerCase() ||
          claims.createKey !== request.createKey) throw new Error();
      return Object.freeze({ ...claims, grantHash: createHash("sha256").update(token).digest("hex") });
    } catch { throw refuseRuntimeCanary(); }
  }
}

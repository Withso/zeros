import { z } from "zod";
import { HttpError } from "../authz.js";
import { CloudAgentModelSchema } from "../cloud-workspaces/agent-credentials.js";
import {
  CloudAgentCredentialMaterialSchema,
  parseCloudAgentCredential,
  type CloudAgentCredentialMaterial,
} from "../cloud-workspaces/agent-credential-envelope.js";
import {
  parseCodexNativeCache,
  type CodexNativeAuthCache,
} from "../cloud-workspaces/codex-auth-cache.js";

export const AUDIENCE = "zeros-dev-connections-v1";
export const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const uuid = z
  .string()
  .uuid()
  .transform((s) => s.toLowerCase());
const secret = z
  .string()
  .min(16)
  .max(16384)
  .regex(/^[A-Za-z0-9._~+\/-]+={0,2}$/);
const expiry = z.number().int().positive().max(4102444800);
export const GithubMaterialSchema = z
  .object({
    kind: z.literal("github-app"),
    accessToken: secret,
    refreshToken: secret,
    expiresAt: expiry,
    refreshExpiresAt: expiry,
    accountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    appId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    clientId: identifier,
  })
  .strict();
export type GithubMaterial = z.infer<typeof GithubMaterialSchema>;
export type DevMaterial =
  | Exclude<CloudAgentCredentialMaterial, { kind: "codex-chatgpt" }>
  | { kind: "codex-chatgpt"; nativeCache: CodexNativeAuthCache }
  | GithubMaterial;
export type AccessMaterial =
  | Exclude<CloudAgentCredentialMaterial, { kind: "codex-chatgpt" }>
  | {
      kind: "codex-chatgpt";
      accessToken: string;
      accountId: string;
      expiresAt: number;
    }
  | { kind: "github-app"; accessToken: string; expiresAt: number };
export const repository = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .transform((s) => s.toLowerCase());
export const ConsentSchema = z
  .object({
    models: z.array(CloudAgentModelSchema).max(32),
    repositories: z.array(repository).max(100),
    scopes: z
      .array(z.enum(["agent", "github:read", "github:write"]))
      .min(1)
      .max(3),
  })
  .strict();
export const ConnectSchema = z
  .object({
    id: uuid,
    accountId: identifier,
    appScope: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:.-]+$/),
    material: z.unknown(),
    consent: ConsentSchema,
    replaceExisting: z.literal(true).optional(),
  })
  .strict();
export const GrantScopeSchema = z.discriminatedUnion("action", [
  z.object({action:z.literal("github:catalog")}).strict(),
  z
    .object({
      action: z.literal("agent"),
      workspaceId: uuid,
      model: CloudAgentModelSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("github:read"),
      workspaceId: uuid,
      repository,
      installationId: z.number().int().positive().safe(),
    })
    .strict(),
  z
    .object({
      action: z.literal("github:write"),
      workspaceId: uuid,
      repository,
      installationId: z.number().int().positive().safe(),
    })
    .strict(),
]);
export type GrantScope = z.infer<typeof GrantScopeSchema>;
export const GenerationSchema = z
  .object({
    id: uuid,
    owner: z.string().regex(/^[a-f0-9]{24}$/),
    organization: identifier,
    audience: z.literal(AUDIENCE),
    credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    keyRevision: z.number().int().positive().safe(),
    expiresAt: z.string().datetime(),
    source: z.literal("hosted-dev"),
  })
  .strict();
export type GenerationRegistration = z.infer<typeof GenerationSchema>;
export type GenerationAuth = {
  id: string;
  credential: string;
  audience: string;
};
/** Only the WorkOS verifier constructs this at the HTTP boundary. No local user UUID or fixture is identity. */
export type Member = {
  issuer: string;
  subject: string;
  organization: string;
  sessionId: string;
  expiresAt: number;
};
export type Context = { member: Member; generation: GenerationAuth };
export type ConnectionReference = {
  mode: "dev-reference";
  bindingId: string;
  connectionId: string;
  generationId: string;
  organization: string;
  kind: DevMaterial["kind"];
  accountId: string;
  appScope: string;
  revision: number;
  consentRevision: number;
  consent: z.infer<typeof ConsentSchema>;
  connectionMethod: "account" | "api";
  expiresAt: string;
};
export type Grant = {
  id: string;
  bindingId: string;
  audience: string;
  scope: GrantScope;
  expiresAt: string;
  providerExpiresAt: string | null;
  materialVersion?: number;
  material: AccessMaterial;
};
export const GrantSchema = z
  .object({
    id: uuid,
    bindingId: uuid,
    audience: z.literal(AUDIENCE),
    scope: GrantScopeSchema,
    expiresAt: z.string().datetime(),
    providerExpiresAt: z.string().datetime().nullable(),
    materialVersion: z.number().int().positive().optional(),
    material: z.union([
      CloudAgentCredentialMaterialSchema.refine(
        (m) => m.kind !== "codex-chatgpt" || !("refreshToken" in m),
      ),
      z
        .object({
          kind: z.literal("github-app"),
          accessToken: secret,
          expiresAt: expiry,
        })
        .strict(),
    ]),
  })
  .strict();
export function denied(): never {
  throw new HttpError(
    403,
    "dev_connection_denied",
    "Dev connection access is unavailable",
  );
}
export function reconnect(): never {
  throw new HttpError(
    409,
    "dev_connection_reconnect_required",
    "Reconnect this Dev provider account",
  );
}
export function invalid(): never {
  throw new HttpError(
    422,
    "dev_connection_invalid",
    "Invalid Dev connection request",
  );
}
export function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid();
  return result.data;
}
export function parseMaterial(value: unknown): DevMaterial {
  try {
    if (value && typeof value === "object" && "kind" in value) {
      if (value.kind === "github-app")
        return parse(GithubMaterialSchema, value);
      if (value.kind === "codex-chatgpt") {
        const shape = z
          .object({
            kind: z.literal("codex-chatgpt"),
            nativeCache: z.unknown(),
          })
          .strict()
          .parse(value);
        return {
          kind: "codex-chatgpt",
          nativeCache: parseCodexNativeCache(shape.nativeCache).cache,
        };
      }
    }
    const material = parseCloudAgentCredential(value);
    if (material.kind === "codex-chatgpt") invalid();
    return material;
  } catch {
    invalid();
  }
}
export function accessMaterial(material: DevMaterial): AccessMaterial {
  if (material.kind === "codex-chatgpt")
    return parseCodexNativeCache(material.nativeCache)
      .material as AccessMaterial;
  if (material.kind === "github-app")
    return {
      kind: material.kind,
      accessToken: material.accessToken,
      expiresAt: material.expiresAt,
    };
  return material;
}
export function refreshSeed(material: DevMaterial): string | null {
  return material.kind === "codex-chatgpt"
    ? material.nativeCache.tokens.refresh_token
    : material.kind === "github-app"
      ? material.refreshToken
      : null;
}

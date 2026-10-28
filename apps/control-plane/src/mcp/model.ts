import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { McpUuidSchema } from "../cloud/contract.js";

export const SECRET_REF = "${zeros.secret}";
const text = z.string().max(16384).refine(value => !value.includes("\0"));
const name = z.string().trim().min(1).max(128).refine(value => [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
const headerName = z.string().min(1).max(128).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
  .refine(value => !/^(host|connection|content-length|transfer-encoding|cookie|set-cookie|proxy-authorization)$/i.test(value));
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const env = z.record(envName, text).refine(value => Object.keys(value).length <= 128);
const headers = z.record(headerName, text.refine(value => !/[\r\n]/.test(value))).refine(value => Object.keys(value).length <= 128);
export const McpRepositorySchema = z.string().max(255).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine(value => !value.split("/").some(part => part === "." || part === "..")).transform(value => value.toLowerCase());
export const McpRepositoryIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/)
  .refine(value => Number.isSafeInteger(Number(value)));
export function isLoopbackMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}
const url = z.string().min(1).max(4096).url().refine(value => {
  const parsed = new URL(value);
  return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash;
});
const common = { name, enabled: z.boolean().optional(), credential_id: z.string().min(1).max(256).optional(), env: env.optional() };
const remote = {
  ...common, url, headers: headers.optional(), auth: z.enum(["none", "header", "oauth"]).optional(),
  header_name: headerName.optional(), header_names: z.array(headerName).max(128).optional(),
  oauth_client_mode: z.enum(["auto", "metadata", "dynamic", "custom"]).optional(),
  oauth_client_id: z.string().trim().min(1).max(4096).optional(),
  oauth_scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/).max(512)).max(64).optional(),
  disabled_tools: z.array(z.string().min(1).max(256)).max(1024).optional(),
};
export const McpConfigSchema = z.discriminatedUnion("transport", [
  z.object({ ...common, transport: z.literal("stdio"), command: z.string().trim().min(1).max(4096).refine(value => !value.includes("\0")),
    args: z.array(z.string().max(8192).refine(value => !value.includes("\0"))).max(128).optional(), cwd: z.string().trim().min(1).max(4096).refine(value => !value.includes("\0")).optional(),
    listen_url: z.string().max(4096).refine(isLoopbackMcpUrl).optional() }).strict(),
  z.object({ ...remote, transport: z.literal("http") }).strict(),
  z.object({ ...remote, transport: z.literal("sse") }).strict(),
]);
export type McpConfig = z.infer<typeof McpConfigSchema>;
export function oauthClientMode(config: McpConfig): "auto" | "metadata" | "dynamic" | "custom" {
  return config.transport === "stdio" ? "auto" : config.oauth_client_mode ?? (config.oauth_client_id ? "custom" : "auto");
}
export const McpSecretsPatchSchema = z.object({
  env: z.record(envName, text.nullable()).refine(value => Object.keys(value).length <= 128).optional(),
  headers: z.record(headerName, text.refine(value => !/[\r\n]/.test(value)).nullable()).refine(value => Object.keys(value).length <= 128).optional(),
  oauthClientSecret: text.nullable().optional(),
}).strict();
export type McpSecretsPatch = z.infer<typeof McpSecretsPatchSchema>;
export interface McpSecrets { env?: Record<string, string>; headers?: Record<string, string>; oauthClientSecret?: string }
export const McpWriteSchema = z.object({
  kind: z.literal("mcp"), owner: z.enum(["organization", "user"]), repository: McpRepositorySchema.nullable(),
  expectedRevision: z.number().int().positive().safe().nullable(), config: McpConfigSchema,
  secrets: McpSecretsPatchSchema.optional(), oauthAttemptId: McpUuidSchema.optional(),
}).strict();
export type McpWrite = z.infer<typeof McpWriteSchema>;
export const McpDraftSchema = z.object({ config: McpConfigSchema, secrets: McpSecretsPatchSchema.optional(),
  extensionId: McpUuidSchema.optional(), expectedRevision: z.number().int().positive().safe().optional(), oauthAttemptId: McpUuidSchema.optional() }).strict();
export type McpDraft = z.infer<typeof McpDraftSchema>;
const invalid = () => new HttpError(422, "invalid_mcp_config", "MCP configuration or a required secret is missing");

/** New organization values are sealed even when a caller omits the UI toggle.
 * Only an explicit reference retains this row's old value; no global key lookup. */
export function mergeMcpSecrets(config: McpConfig, patch: McpSecretsPatch, previous: McpSecrets): { config: McpConfig; secrets: McpSecrets } {
  const next = structuredClone(config), secrets: McpSecrets = {};
  for (const field of ["env", "headers"] as const) {
    const source = field === "env" ? next.env : next.transport === "stdio" ? undefined : next.headers;
    const required = field === "headers" && next.transport !== "stdio" ? next.header_names ?? (next.header_name ? [next.header_name] : []) : [];
    const names = new Set([...Object.keys(source ?? {}), ...required]);
    if (Object.keys(patch[field] ?? {}).some(key => !names.has(key))) throw invalid();
    const sealed: Record<string, string> = {}, refs: Record<string, string> = {};
    for (const key of names) {
      const value = Object.hasOwn(patch[field] ?? {}, key) ? patch[field]![key]
        : source?.[key] === SECRET_REF || source?.[key] === undefined ? previous[field]?.[key] : source[key];
      if (value === null || value === undefined) throw invalid();
      sealed[key] = value; refs[key] = SECRET_REF;
    }
    if (names.size) {
      secrets[field] = sealed;
      if (field === "env") next.env = refs;
      else if (next.transport !== "stdio") next.headers = refs;
    }
  }
  if (next.transport !== "stdio" && next.auth === "oauth") {
    const clientSecret = patch.oauthClientSecret === undefined ? previous.oauthClientSecret : patch.oauthClientSecret;
    if (clientSecret && oauthClientMode(next) === "custom") secrets.oauthClientSecret = clientSecret;
    if ((next.oauth_client_mode === "custom" || next.oauth_client_mode === "metadata") && !next.oauth_client_id) throw invalid();
    if (next.oauth_client_mode === "metadata" && (!next.oauth_client_id?.startsWith("https://") || !url.safeParse(next.oauth_client_id).success)) throw invalid();
  }
  return { config: next, secrets };
}

export function materializeMcp(config: McpConfig, secrets: McpSecrets): McpConfig {
  const variables = Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, value === SECRET_REF ? secrets.env?.[key] : value]));
  if (Object.values(variables).some(value => value === undefined)) throw invalid();
  const substitute = (value: string): string => value.replace(/\$\{(?:env[:.])?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    if (variables[key] === undefined) throw invalid();
    return variables[key]!;
  });
  if (config.transport === "stdio") return { ...config, ...(config.env ? { env: variables as Record<string, string> } : {}) };
  const resolved = Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => {
    const raw = value === SECRET_REF ? secrets.headers?.[key] : value;
    if (raw === undefined) throw invalid();
    return [key, substitute(raw)];
  }));
  if (!headers.safeParse(resolved).success) throw invalid();
  return { ...config, ...(config.env ? { env: variables as Record<string, string> } : {}), ...(Object.keys(resolved).length ? { headers: resolved } : {}) };
}

/** Each new identity gets an independent opaque marker, never a credential digest. */
export function newOAuthBinding(): string {
  return randomBytes(32).toString("hex");
}

type OAuthIdentity = { config: McpConfig; secrets: McpSecrets };
function oauthIdentityBytes({ config, secrets }: OAuthIdentity): Buffer {
  return Buffer.from(JSON.stringify(config.transport === "stdio" ? [config.transport] : [
    config.transport, config.url, config.auth ?? "none", oauthClientMode(config), config.oauth_client_id ?? "",
    [...new Set(config.oauth_scopes ?? [])].sort(), secrets.oauthClientSecret ?? "",
  ]));
}

/** Retain historical markers only after comparing the complete identity against
 * authenticated decrypted material. Clear temporary secret-bearing bytes. */
export function sameOAuthIdentity(left: OAuthIdentity, right: OAuthIdentity): boolean {
  const leftBytes = oauthIdentityBytes(left);
  let rightBytes: Buffer | undefined;
  try {
    rightBytes = oauthIdentityBytes(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } finally { leftBytes.fill(0); rightBytes?.fill(0); }
}

export function selectMcpEntries<T extends { id: string; ownerUserId: string | null; repository: string | null; config: McpConfig }>(
  entries: readonly T[], userId: string, repository: string,
): T[] {
  const rank = (entry: T) => (entry.ownerUserId === userId ? 2 : 0) + (entry.repository === repository ? 1 : 0);
  const ordered = entries.filter(entry => (entry.ownerUserId === null || entry.ownerUserId === userId) && (entry.repository === null || entry.repository === repository))
    .sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
  const seen = new Set<string>(), result: T[] = [];
  for (const entry of ordered) {
    if (seen.has(entry.config.name)) continue;
    seen.add(entry.config.name);
    if (entry.config.enabled !== false) result.push(entry);
  }
  return result;
}

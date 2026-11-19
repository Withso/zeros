import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { mcpServerSchema, type McpSettingsServer } from "./schema";
import { opSettingsRead, opSettingsWrite } from "./ops";
import { OAuthVault, type BackendCredentials } from "../agents/gateway/oauth-provider";
import { mcpCredentialKey } from "../agents/gateway/credential-key";

const valueChanges = z.record(z.string().min(1).max(256), z.string().max(16384).nullable())
  .refine(value => Object.keys(value).length <= 128);
export const mcpSaveInputSchema = z.object({
  layer: z.enum(["user", "repo-local"]), repoRoot: z.string().min(1).max(4096).optional(),
  previous: z.record(z.string(), z.unknown()).nullable(),
  server: z.record(z.string(), z.unknown()),
  secrets: z.object({ env: valueChanges.optional(), headers: valueChanges.optional(), oauthClientSecret: z.string().max(16384).nullable().optional() }).strict().optional(),
}).strict();
export type McpSaveInput = z.infer<typeof mcpSaveInputSchema>;
export type McpGatewaySecretChanges = NonNullable<McpSaveInput["secrets"]>;
export type McpSettingsWrite = ReturnType<typeof opSettingsWrite>;
export type McpSettingsCommit = (server: McpSettingsServer | null, changes: McpGatewaySecretChanges, repoRoot: string | undefined, write: () => McpSettingsWrite, previous: Record<string, unknown> | null) => Promise<McpSettingsWrite>;

/** On save, stage valid credentials durably before changing settings; publish to the live vault only after the file write succeeds. */
export function commitMcpCredentials(vault: OAuthVault, server: McpSettingsServer | null, changes: McpGatewaySecretChanges, repoRoot: string | undefined, write: () => McpSettingsWrite, previous: Record<string, unknown> | null, persist?: (snapshot: Record<string, BackendCredentials>) => Promise<void>): Promise<McpSettingsWrite> {
  const target = server ?? mcpServerSchema.parse(previous);
  const key = mcpCredentialKey(target.credential_id, target.transport === "stdio" ? undefined : target.url, repoRoot);
  // Lock the shared settings array and fence OAuth refresh for this entry through durable acknowledgement.
  return vault.exclusive("mcp-settings-transaction", () => vault.exclusive(key, async () => {
  if (!server) {
    const prior = mcpServerSchema.parse(previous);
    if (!prior.credential_id) return write(); // legacy URI keys may be shared
    // Remove config first so a crash cannot leave it pointing to deleted credentials.
    const result = write();
    vault.clear(key);
    await persist?.(vault.snapshot());
    return result;
  }
  const saved = vault.readEntry(key);
  const legacyKey = previous && !previous.credential_id && typeof previous.url === "string" && previous.url === (server.transport === "stdio" ? undefined : server.url)
    ? mcpCredentialKey(undefined, previous.url, repoRoot) : undefined;
  const next: BackendCredentials = structuredClone(saved ?? (legacyKey ? vault.readEntry(legacyKey) : undefined) ?? {});
  for (const kind of ["env", "headers"] as const) {
    const source = kind === "headers" ? { ...(next.header ? { [next.header.name]: next.header.value } : {}), ...next.headers } : next.env ?? {};
    const configured = kind === "env" ? server.env : server.transport !== "stdio" ? server.headers : undefined;
    const sealed: Record<string, string> = {};
    for (const [name, marker] of Object.entries(configured ?? {})) {
      if (marker !== "${zeros.secret}") continue;
      const change = changes[kind]?.[name];
      const value = change === undefined ? Object.entries(source).find(([key]) => kind === "headers" ? key.toLowerCase() === name.toLowerCase() : key === name)?.[1] : change;
      if (value === null || value === undefined) throw new Error(`Enter a value for ${name} before saving.`);
      if (value.includes("\0") || (kind === "headers" && /[\r\n]/.test(value))) throw new Error("Invalid MCP credential value.");
      sealed[name] = value;
    }
    next[kind] = sealed;
  }
  if (changes.oauthClientSecret !== undefined) {
    const secret = changes.oauthClientSecret !== null && server.transport !== "stdio" && server.oauth_client_id
      ? { clientId: server.oauth_client_id, value: changes.oauthClientSecret } : undefined;
    if (!isDeepStrictEqual(secret, next.oauthSecret)) {
      delete next.tokens; delete next.client; delete next.oauthSecret;
      if (secret) next.oauthSecret = secret;
    }
  }
  if (server.transport === "stdio" || server.auth !== "oauth") {
    delete next.tokens; delete next.client; delete next.oauthSecret; delete next.oauthConfig;
  }
  delete next.header;
  const snapshot = vault.snapshot(); snapshot[key] = next;
  await persist?.(snapshot);
  try {
    const result = write();
    vault.replaceEntry(key, next);
    return result;
  } catch (error) {
    // Restore the confirmed vault, including unrelated refreshes, not the staged snapshot.
    await persist?.(vault.snapshot());
    throw error;
  }
  }));
}

/** Compare bridge JSON: TOML tables can have null prototypes and datetimes become strings. */
function sameSavedValue(saved: unknown, edited: unknown): boolean {
  const json = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return isDeepStrictEqual(json(saved), json(edited));
}

/** Reuse unchanged originals so TOML datetimes are not written as ISO strings. */
function keepUnchangedValues(saved: unknown, edited: unknown): unknown {
  if (sameSavedValue(saved, edited)) return saved;
  const isTable = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
  if (!isTable(saved) || !isTable(edited)) return edited;
  return Object.fromEntries(Object.entries(edited).map(([key, value]) => [key, Object.hasOwn(saved, key) ? keepUnchangedValues(saved[key], value) : value]));
}

/** Check for stale edits by original identity so unrelated row changes survive. */
export function replaceMcpServer(servers: unknown[], previous: Record<string, unknown> | null, server: Record<string, unknown>): unknown[] {
  const isRecord = (entry: unknown): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry);
  const index = previous ? servers.findIndex(entry => isRecord(entry) && (previous.credential_id ? entry.credential_id === previous.credential_id : entry.name === previous.name)) : -1;
  if (previous && (index === -1 || !sameSavedValue(servers[index], previous))) throw new Error("This MCP server changed while you were editing. Reopen it to review the latest version.");
  if (servers.some((entry, offset) => offset !== index && isRecord(entry) && entry.name === server.name)) throw new Error("Another MCP server already uses this name.");
  if (index === -1 && servers.length >= 128) throw new Error("Use up to 128 MCP servers per project.");
  return index === -1 ? [...servers, server] : servers.map((entry, offset) => offset === index ? keepUnchangedValues(entry, server) : entry);
}

/** Read and replace synchronously so each engine edit starts from the latest array. */
export async function opMcpSaveServer(input: McpSaveInput, commit?: McpSettingsCommit): Promise<McpSettingsWrite> {
  const validated = mcpServerSchema.safeParse(input.server);
  if (!validated.success) throw new Error("Invalid MCP configuration. Review the server details.");
  const write = () => {
    const current = opSettingsRead(input.layer, input.repoRoot).doc;
    const raw = (current.mcp as { servers?: unknown } | undefined)?.servers;
    const next = replaceMcpServer(Array.isArray(raw) ? raw : [], input.previous, input.server);
    return opSettingsWrite(input.layer, { mcp: { servers: next } }, input.repoRoot);
  };
  if (validated.data.credential_id || (validated.data.transport !== "stdio" && (validated.data.auth === "oauth" || validated.data.auth === "header"))) {
    if (!commit) throw new Error("MCP credential storage is unavailable. Reconnect and try again.");
    return commit(validated.data, input.secrets ?? {}, input.repoRoot, write, input.previous);
  }
  return write();
}

export const mcpDeleteInputSchema = mcpSaveInputSchema.omit({ server: true, secrets: true }).extend({ previous: z.record(z.string(), z.unknown()) });
export function removeMcpServer(servers: unknown[], previous: Record<string, unknown>): unknown[] {
  // Use the same conflict check before deleting an entry.
  replaceMcpServer(servers, previous, previous);
  return servers.filter(entry => !sameSavedValue(entry, previous));
}
export async function opMcpDeleteServer(input: z.infer<typeof mcpDeleteInputSchema>, commit?: McpSettingsCommit): Promise<McpSettingsWrite> {
  const write = () => {
    const current = opSettingsRead(input.layer, input.repoRoot).doc;
    const raw = (current.mcp as { servers?: unknown } | undefined)?.servers;
    const servers = removeMcpServer(Array.isArray(raw) ? raw : [], input.previous);
    return opSettingsWrite(input.layer, { mcp: { servers } }, input.repoRoot);
  };
  return commit ? commit(null, {}, input.repoRoot, write, input.previous) : write();
}

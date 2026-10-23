// ──────────────────────────────────────────────────────────
// Customize → MCP — server form model (no React/JSX, unit-tested)
// ──────────────────────────────────────────────────────────
//
// The data layer between a settings layer's `[[mcp.servers]]` array-of-tables
// (user `settings.toml`, or a repo's personal `settings.local.toml`) and the
// Customize page's list/form UI. Kept view-free so the round-trip rules — raw
// entries preserved, `enabled` carried forward, names unique — are testable
// without a DOM. See customize-mcp.tsx / mcp-server-form.tsx for the views.
// ──────────────────────────────────────────────────────────

export type Transport = "stdio" | "http" | "sse";
export type OAuthClientMode = "auto" | "metadata" | "dynamic" | "custom";

/** The sentinel an env VALUE carries when its real value lives in the OS
 *  Keychain, not the settings file. The engine strips it from the registry and
 *  the renderer couriers the real value into the agent's process env. MUST match
 *  the engine (apps/desktop/src/engine/agents/mcp-registry.ts MCP_SECRET_SENTINEL). The pure
 *  renderer source of truth — agent/mcp-secrets.ts imports it from here. */
export const MCP_SECRET_SENTINEL = "${zeros.secret}";

/** One raw entry as it sits in settings.toml — loosely typed so a hand-written
 *  / forward-version entry survives a round-trip even when this UI can't render
 *  every field. */
export type RawServer = Record<string, unknown>;

export interface KV {
  id: number;
  key: string;
  value: string;
  /** This env var's real value lives in the Keychain (env only; never headers).
   *  Its settings value is the sentinel; `value` holds a freshly-typed secret to
   *  store, or "" when editing an already-stored one (masked, leave as-is). */
  secret?: boolean;
  /** An empty masked value retains this exact saved key; a new empty value is literal. */
  stored?: boolean;
  originalKey?: string;
}

export interface Draft {
  name: string;
  /** Optional free-text note shown under the name in the server list (UI-only;
   *  the engine registry ignores it, the raw file round-trips it). */
  description: string;
  transport: Transport;
  command: string;
  cwd: string;
  argsText: string; // one arg per line (handles spaces; no shell-splitting)
  /** Form rows preserve literal arguments, including empty values and newlines. */
  args?: string[];
  listenUrl?: string;
  url: string;
  env: KV[];
  headers: KV[];
  /** Remote transports only: "oauth"/"header" route through the Zeros gateway (which brokers
   *  OAuth, or holds a static auth header). */
  auth: "none" | "oauth" | "header";
  /** auth:"header" — the header NAME the gateway sets (e.g. Authorization). */
  headerName: string;
  /** auth:"header" — a freshly-typed secret VALUE to store in the engine vault
   *  (write-only; empty when editing an existing one — the stored value is not
   *  readable here, and never lands in settings). */
  headerSecret: string;
  /** auth:"oauth" — optional pre-registered client_id for no-DCR servers
   *  (non-secret; written to settings as oauth_client_id). */
  oauthClientId: string;
  oauthScopes: string;
  oauthClientSecret: string;
  clearOAuthClientSecret: boolean;
  oauthMode?: OAuthClientMode;
  /** Absent on older callers; an explicit empty list allows every tool. */
  disabledTools?: string[];
}

export function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Read the raw servers array from a user-layer settings doc, keeping only
 *  object entries (a scalar can't be a server and can't round-trip as a row). */
export function readRawServers(doc: Record<string, unknown> | undefined): RawServer[] {
  const servers = (doc?.mcp as { servers?: unknown } | undefined)?.servers;
  if (!Array.isArray(servers)) return [];
  return servers.filter(
    (s): s is RawServer => typeof s === "object" && s !== null && !Array.isArray(s),
  );
}

export function transportOf(s: RawServer): Transport {
  return s.transport === "http" || s.transport === "sse" ? s.transport : "stdio";
}

/** A one-line, monospace summary of where a server points. */
export function endpointSummary(s: RawServer): string {
  if (transportOf(s) !== "stdio") return asString(s.url) || "(no url)";
  const cmd = asString(s.command) || "(no command)";
  const args = Array.isArray(s.args) ? s.args.filter((a) => typeof a === "string").join(" ") : "";
  return args ? `${cmd} ${args}` : cmd;
}

export function isEnabled(s: RawServer): boolean {
  return s.enabled !== false; // absent / true → on
}

let kvSeq = 0;
/** Monotonic id for a key/value row (stable React keys; never reused). */
export function nextKvId(): number {
  return kvSeq++;
}

export function mapToKV(m: unknown): KV[] {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return [];
  return Object.entries(m as Record<string, unknown>).map(([key, value]) => ({
    id: nextKvId(),
    key,
    value: asString(value),
  }));
}

export function kvToMap(rows: KV[]): Record<string, string> {
  return Object.fromEntries(rows.filter(row => row.key.trim()).map(row => [row.key.trim(), row.value]));
}

export function draftFromServer(s: RawServer | null): Draft {
  const transport = s ? transportOf(s) : "stdio";
  const args = s && Array.isArray(s.args) ? s.args.filter((a) => typeof a === "string") : [];
  return {
    name: s ? asString(s.name) : "",
    description: s ? asString(s.description) : "",
    transport,
    command: s ? asString(s.command) : "",
    cwd: asString(s?.cwd),
    argsText: (args as string[]).join("\n"),
    args,
    listenUrl: asString(s?.listen_url),
    url: s ? asString(s.url) : "",
    // A sentinel'd env value is a Keychain secret: mark the row secret and clear
    // the (masked) value — the real value stays in the Keychain, untouched
    // unless the user types a new one.
    env: mapToKV(s?.env).map((kv) =>
      kv.value === MCP_SECRET_SENTINEL ? { ...kv, secret: true, stored: true, originalKey: kv.key, value: "" } : kv,
    ),
    headers: mapToKV(s?.headers).map(kv => kv.value === MCP_SECRET_SENTINEL
      ? { ...kv, secret: true, stored: true, originalKey: kv.key, value: "" } : kv),
    auth:
      transport !== "stdio" && (s?.auth === "oauth" || s?.auth === "header")
        ? (s.auth as "oauth" | "header")
        : "none",
    headerName: asString(s?.header_name) || "Authorization",
    headerSecret: "", // never read a stored secret into the form
    oauthClientId: asString(s?.oauth_client_id),
    oauthScopes: Array.isArray(s?.oauth_scopes) ? s.oauth_scopes.filter((v): v is string => typeof v === "string").join(" ") : "",
    oauthClientSecret: "",
    clearOAuthClientSecret: false,
    disabledTools: s ? disabledToolsOf(s) : [],
    ...(s?.oauth_client_mode === "auto" || s?.oauth_client_mode === "metadata" || s?.oauth_client_mode === "dynamic" || s?.oauth_client_mode === "custom"
      ? { oauthMode: s.oauth_client_mode }
      : {}),
  };
}

/** Build the env table from rows, writing the Keychain SENTINEL for any row
 *  marked secret (its real value is stored separately by the dialog). */
function envFromRows(rows: KV[]): Record<string, string> {
  return Object.fromEntries(rows.filter(row => row.key.trim()).map(row => [row.key.trim(), row.secret ? MCP_SECRET_SENTINEL : row.value]));
}

/** The env var NAMES marked secret in a draft whose value was freshly typed (so
 *  the dialog knows which Keychain entries to write on save). */
export function newSecretsFromDraft(d: Draft): Array<{ name: string; value: string }> {
  return d.env
    .filter((kv) => kv.secret && kv.key.trim() && (kv.value.length > 0 || kv.stored === false))
    .map((kv) => ({ name: kv.key.trim(), value: kv.value }));
}

/** Keys the form/draft fully owns — everything else on a prior entry is
 *  carried forward verbatim by serverFromDraft (the "never silently dropped"
 *  round-trip contract for hand-written / forward-version keys). */
const DRAFT_OWNED_KEYS = new Set([
  "name",
  "description",
  "transport",
  "command",
  "cwd",
  "args",
  "listen_url",
  "env",
  "url",
  "headers",
  "auth",
  "header_name",
  "header_names",
  "oauth_client_id",
  "oauth_scopes",
  "oauth_client_secret",
  "oauth_client_mode",
  "enabled",
  "disabled_tools",
]);

/** Build the clean server object a Save persists, carrying forward from the
 *  entry being edited what the form doesn't own: `enabled: false` (the on/off
 *  toggle lives on the list row), remote `disabled_tools` when an older caller
 *  does not edit tool policy, and any unknown keys. Empty optionals are omitted
 *  so the TOML stays tidy. */
export function serverFromDraft(d: Draft, prior: RawServer | null): RawServer {
  const carried: RawServer = {};
  if (prior) {
    for (const [k, v] of Object.entries(prior)) {
      if (!DRAFT_OWNED_KEYS.has(k)) carried[k] = v;
    }
  }
  const enabled = prior && prior.enabled === false ? { enabled: false } : {};
  const toolPolicy = d.disabledTools ?? (prior ? disabledToolsOf(prior) : []);
  const disabledTools = toolPolicy.length ? { disabled_tools: toolPolicy } : {};
  const description = d.description.trim()
    ? { description: d.description.trim() }
    : {};
  if (d.transport === "stdio") {
    const args = d.args ?? d.argsText.split("\n").map((a) => a.trim()).filter(Boolean);
    const env = envFromRows(d.env);
    return {
      ...carried,
      name: d.name.trim(),
      ...description,
      transport: "stdio",
      command: d.command.trim(),
      ...(d.cwd.trim() ? { cwd: d.cwd.trim() } : {}),
      ...(d.listenUrl?.trim() ? { listen_url: d.listenUrl.trim() } : {}),
      ...(args.length ? { args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...enabled,
    };
  }
  const remoteEnv = envFromRows(d.env);
  // auth:"header" — the gateway brokers a static header; its NAME is written here,
  // its VALUE goes to the engine vault (never settings), and the plain headers
  // editor is replaced by the brokered header (so no secret can sit in the file).
  if (d.auth === "header") {
    return {
      ...carried,
      name: d.name.trim(),
      ...description,
      transport: d.transport,
      url: d.url.trim(),
      auth: "header",
      ...(Object.keys(remoteEnv).length ? { env: remoteEnv } : {}),      ...(d.headers.length ? {
        header_names: d.headers.filter(row => row.key.trim()).map(row => row.key.trim()),
        headers: envFromRows(d.headers),
      } : { header_name: d.headerName.trim() || "Authorization" }),
      ...disabledTools,
      ...enabled,
    };
  }
  const headers = envFromRows(d.headers);
  return {
    ...carried,
    name: d.name.trim(),
    ...description,
    transport: d.transport,
    url: d.url.trim(),
    ...(Object.keys(remoteEnv).length ? { env: remoteEnv } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(d.auth === "oauth"
      ? {
          auth: "oauth",
          ...(d.oauthMode ? { oauth_client_mode: d.oauthMode } : {}),
          ...((!d.oauthMode || d.oauthMode === "custom") && d.oauthClientId.trim() ? { oauth_client_id: d.oauthClientId.trim() } : {}),
          ...(d.oauthScopes.trim() ? { oauth_scopes: [...new Set(d.oauthScopes.trim().split(/\s+/))] } : {}),
        }
      : {}),
    ...disabledTools,
    ...enabled,
  };
}

/** The freshly-typed header secret to store in the engine vault on save, or null
 *  when there's nothing new to store (not an auth:"header" http draft, or the
 *  value wasn't re-entered while editing). The value NEVER goes to settings —
 *  only this returns it, for the dialog's local bridge call. */
export function newHeaderSecretFromDraft(
  d: Draft,
): { url: string; headerName: string; value: string } | null {
  if (d.transport === "stdio" || d.auth !== "header" || !d.headerSecret) return null;
  return {
    url: d.url.trim(),
    headerName: d.headerName.trim() || "Authorization",
    value: d.headerSecret,
  };
}

function containsControlCharacter(value: string, includeSpace = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= (includeSpace ? 32 : 31) || code === 127) return true;
  }
  return false;
}

/** Validation message for a draft, or null when it's good to save. */
export function draftError(d: Draft, takenNames: Set<string>): string | null {
  const name = d.name.trim();
  if (!name) return "Name is required.";
  if (name.length > 128 || containsControlCharacter(name)) return "Use a server name of up to 128 characters without control characters.";
  if (name === "zeros-gateway") return "That server name is reserved. Choose another name.";
  if (takenNames.has(name)) return `Another server is already named “${name}”.`;
  if (d.transport === "stdio" && !d.command.trim()) return "Command is required for a stdio server.";
  if (d.transport === "stdio" && (d.cwd.includes("\0") || d.cwd.length > 4096)) return "Working directory is invalid.";
  const variables = keyValueError(d.env, "variable");
  if (variables) return variables;
  if (d.transport === "stdio") {
    if (d.command.length > 4096 || d.command.includes("\0")) return "Command is invalid.";
    if (d.args && (d.args.length > 128 || d.args.some(arg => arg.length > 8192 || arg.includes("\0")))) return "Use up to 128 arguments, each under 8,192 characters.";
    if (d.listenUrl?.trim()) {
      const invalid = mcpUrlError(d.listenUrl);
      if (invalid) return invalid;
      const url = new URL(d.listenUrl.trim());
      if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return "The process endpoint must use HTTP on localhost, 127.0.0.1 or [::1].";
    }
  }
  if (d.auth === "oauth" && d.transport !== "stdio") {
    if (d.oauthMode === "custom" && !d.oauthClientId.trim()) return "Client ID is required for your own OAuth client.";
    if (d.oauthClientSecret && !d.oauthClientId.trim()) return "Client ID is required with a client secret.";
    const scopes = d.oauthScopes.trim().split(/\s+/).filter(Boolean);
    if (scopes.length > 64 || scopes.some((s) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s))) return "Enter valid OAuth scopes separated by spaces.";
  }
  if (d.transport !== "stdio") {
    const url = d.url.trim();
    if (!url) return `URL is required for an ${d.transport === "sse" ? "SSE" : "HTTP"} server.`;
    const invalid = mcpUrlError(url);
    if (invalid) return invalid;
    const headers = keyValueError(d.headers, "header");
    if (headers) return headers;
  }
  return null;
}

export function mcpUrlError(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!/^https?:$/.test(url.protocol)) return "URL must start with http:// or https://.";
    if (url.username || url.password) return "Use authentication fields instead of credentials in the URL.";
    if (url.hash || raw.length > 4096 || containsControlCharacter(raw.trim(), true)) return "Enter a valid server URL without spaces or a fragment.";
    return null;
  } catch { return "Enter a valid HTTP or HTTPS server URL."; }
}

function keyValueError(rows: KV[], kind: "variable" | "header"): string | null {
  if (rows.length > 128) return `Use up to 128 ${kind}s.`;
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value) continue;
    const valid = kind === "variable" ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
    if (!valid.test(key) || key.length > 128) return `Enter a valid ${kind} name.`;
    if (kind === "header" && /^(host|connection|content-length|transfer-encoding|cookie|set-cookie|proxy-authorization)$/i.test(key)) return "This header is managed by the connection. Use an API key header instead.";
    const identity = kind === "header" ? key.toLowerCase() : key;
    if (seen.has(identity)) return `Duplicate ${kind} names are not allowed.`;
    seen.add(identity);
    if (row.value.includes("\0") || row.value.length > 16384 || (kind === "header" && /[\r\n]/.test(row.value))) return `Enter a valid ${kind} value.`;
    if (row.stored && !row.value && row.originalKey && key !== row.originalKey) return `Enter a new value when renaming a saved ${kind}.`;
  }
  return null;
}

/** Form-only upgrade: every newly saved variable/header is sealed. Legacy raw
 * readers and imports keep their round-trip contract until the user saves. */
export function secureDraftFromServer(server: RawServer | null): Draft {
  const draft = draftFromServer(server);
  const headers = draft.headers.map(row => ({ ...row, secret: true, stored: row.stored ?? false }));
  const names = Array.isArray(server?.header_names) ? server.header_names.filter((name): name is string => typeof name === "string")
    : server?.auth === "header" ? [draft.headerName] : [];
  for (const name of names) {
    if (!headers.some(row => row.key.toLowerCase() === name.toLowerCase())) headers.push({ id: nextKvId(), key: name, value: "", secret: true, stored: true, originalKey: name });
  }
  return {
    ...draft,
    env: draft.env.map(row => ({ ...row, secret: true, stored: row.stored ?? false })),
    headers,
    auth: draft.auth === "none" && headers.length ? "header" : draft.auth,
    oauthMode: draft.oauthMode ?? (draft.oauthClientId ? "custom" : "auto"),
    oauthClientSecret: asString(server?.oauth_client_secret),
  };
}

/** Toggle a server's enabled flag in place within a fresh array: enabling
 *  drops the key entirely (absent === enabled keeps the file clean), disabling
 *  sets `enabled = false`. */
export function withToggled(servers: RawServer[], index: number, enabled: boolean): RawServer[] {
  return servers.map((s, i) => {
    if (i !== index) return s;
    const next = { ...s };
    if (enabled) delete next.enabled;
    else next.enabled = false;
    return next;
  });
}

/** A gateway server's disabled tool NAMES (the allowlist OFF set). */
export function disabledToolsOf(s: RawServer): string[] {
  return Array.isArray(s.disabled_tools)
    ? s.disabled_tools.filter((t): t is string => typeof t === "string")
    : [];
}

/** Toggle one tool on/off for server `index` by writing its `disabled_tools`
 *  array (a fresh array). Disabling adds the name; enabling removes it; the key
 *  is dropped when empty (absent === all-enabled keeps the file tidy). */
export function withToolDisabled(
  servers: RawServer[],
  index: number,
  tool: string,
  disabled: boolean,
): RawServer[] {
  return servers.map((s, i) => {
    if (i !== index) return s;
    const cur = new Set(disabledToolsOf(s));
    if (disabled) cur.add(tool);
    else cur.delete(tool);
    const next = { ...s };
    if (cur.size) next.disabled_tools = [...cur];
    else delete next.disabled_tools;
    return next;
  });
}

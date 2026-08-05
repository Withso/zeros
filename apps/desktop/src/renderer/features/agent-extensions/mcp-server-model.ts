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

export type Transport = "stdio" | "http";

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
}

export interface Draft {
  name: string;
  /** Optional free-text note shown under the name in the server list (UI-only;
   *  the engine registry ignores it, the raw file round-trips it). */
  description: string;
  transport: Transport;
  command: string;
  argsText: string; // one arg per line (handles spaces; no shell-splitting)
  url: string;
  env: KV[];
  headers: KV[];
  /** http only: "oauth"/"header" route through the Zeros gateway (which brokers
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
  return s.transport === "http" ? "http" : "stdio";
}

/** A one-line, monospace summary of where a server points. */
export function endpointSummary(s: RawServer): string {
  if (transportOf(s) === "http") return asString(s.url) || "(no url)";
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
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (k) out[k] = value;
  }
  return out;
}

export function draftFromServer(s: RawServer | null): Draft {
  const transport = s ? transportOf(s) : "stdio";
  const args = s && Array.isArray(s.args) ? s.args.filter((a) => typeof a === "string") : [];
  return {
    name: s ? asString(s.name) : "",
    description: s ? asString(s.description) : "",
    transport,
    command: s ? asString(s.command) : "",
    argsText: (args as string[]).join("\n"),
    url: s ? asString(s.url) : "",
    // A sentinel'd env value is a Keychain secret: mark the row secret and clear
    // the (masked) value — the real value stays in the Keychain, untouched
    // unless the user types a new one.
    env: mapToKV(s?.env).map((kv) =>
      kv.value === MCP_SECRET_SENTINEL ? { ...kv, secret: true, value: "" } : kv,
    ),
    headers: mapToKV(s?.headers),
    auth:
      transport === "http" && (s?.auth === "oauth" || s?.auth === "header")
        ? (s.auth as "oauth" | "header")
        : "none",
    headerName: asString(s?.header_name) || "Authorization",
    headerSecret: "", // never read a stored secret into the form
    oauthClientId: asString(s?.oauth_client_id),
  };
}

/** Build the env table from rows, writing the Keychain SENTINEL for any row
 *  marked secret (its real value is stored separately by the dialog). */
function envFromRows(rows: KV[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value, secret } of rows) {
    const k = key.trim();
    if (!k) continue;
    out[k] = secret ? MCP_SECRET_SENTINEL : value;
  }
  return out;
}

/** The env var NAMES marked secret in a draft whose value was freshly typed (so
 *  the dialog knows which Keychain entries to write on save). */
export function newSecretsFromDraft(d: Draft): Array<{ name: string; value: string }> {
  if (d.transport !== "stdio") return [];
  return d.env
    .filter((kv) => kv.secret && kv.key.trim() && kv.value.length > 0)
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
  "args",
  "env",
  "url",
  "headers",
  "auth",
  "header_name",
  "oauth_client_id",
  "enabled",
  "disabled_tools",
]);

/** Build the clean server object a Save persists, carrying forward from the
 *  entry being edited what the form doesn't own: `enabled: false` (the on/off
 *  toggle lives on the list row), `disabled_tools` (the list row's per-tool
 *  allowlist — editing a description must not reset a curated set), and any
 *  unknown keys. Empty optionals are omitted so the TOML stays tidy. */
export function serverFromDraft(d: Draft, prior: RawServer | null): RawServer {
  const carried: RawServer = {};
  if (prior) {
    for (const [k, v] of Object.entries(prior)) {
      if (!DRAFT_OWNED_KEYS.has(k)) carried[k] = v;
    }
  }
  const enabled = prior && prior.enabled === false ? { enabled: false } : {};
  const disabledTools =
    prior &&
    Array.isArray(prior.disabled_tools) &&
    prior.disabled_tools.length > 0
      ? { disabled_tools: prior.disabled_tools }
      : {};
  const description = d.description.trim()
    ? { description: d.description.trim() }
    : {};
  if (d.transport === "stdio") {
    const args = d.argsText.split("\n").map((a) => a.trim()).filter(Boolean);
    const env = envFromRows(d.env);
    return {
      ...carried,
      name: d.name.trim(),
      ...description,
      transport: "stdio",
      command: d.command.trim(),
      ...(args.length ? { args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...disabledTools,
      ...enabled,
    };
  }
  // auth:"header" — the gateway brokers a static header; its NAME is written here,
  // its VALUE goes to the engine vault (never settings), and the plain headers
  // editor is replaced by the brokered header (so no secret can sit in the file).
  if (d.auth === "header") {
    return {
      ...carried,
      name: d.name.trim(),
      ...description,
      transport: "http",
      url: d.url.trim(),
      auth: "header",
      header_name: d.headerName.trim() || "Authorization",
      ...disabledTools,
      ...enabled,
    };
  }
  const headers = kvToMap(d.headers);
  return {
    ...carried,
    name: d.name.trim(),
    ...description,
    transport: "http",
    url: d.url.trim(),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(d.auth === "oauth"
      ? {
          auth: "oauth",
          ...(d.oauthClientId.trim() ? { oauth_client_id: d.oauthClientId.trim() } : {}),
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
  if (d.transport !== "http" || d.auth !== "header" || !d.headerSecret) return null;
  return {
    url: d.url.trim(),
    headerName: d.headerName.trim() || "Authorization",
    value: d.headerSecret,
  };
}

/** Validation message for a draft, or null when it's good to save. */
export function draftError(d: Draft, takenNames: Set<string>): string | null {
  const name = d.name.trim();
  if (!name) return "Name is required.";
  if (takenNames.has(name)) return `Another server is already named “${name}”.`;
  if (d.transport === "stdio" && !d.command.trim()) return "Command is required for a stdio server.";
  if (d.transport === "http") {
    const url = d.url.trim();
    if (!url) return "URL is required for an HTTP server.";
    if (!/^https?:\/\//i.test(url)) return "URL must start with http:// or https://.";
  }
  return null;
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

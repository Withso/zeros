import { parse as parseToml } from "smol-toml";
import { asString, mcpUrlError, type RawServer } from "./mcp-server-model";
import type { ParsedJsonImport } from "./customize-model";

export const MCP_IMPORT_MAX_BYTES = 256 * 1024;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (error: string): ParsedJsonImport => ({ servers: [], warnings: [], error });

/** Parse only: never run a command, read source-machine env, connect, or save. */
export function parseMcpConfiguration(input: string): ParsedJsonImport {
  const text = input.trim();
  if (!text) return fail("Paste a configuration, server URL, or command first.");
  if (new TextEncoder().encode(text).byteLength > MCP_IMPORT_MAX_BYTES) return fail("Configuration must be smaller than 256 KB.");
  if (/^https?:\/\//i.test(text)) {
    const error = mcpUrlError(text);
    return error ? fail(error) : { servers: [{ name: new URL(text).hostname.split(".")[0], transport: "http", url: text }], warnings: [], error: null };
  }
  let parsed: unknown;
  if (/^[{[#]/.test(text) || /^\s*\[\[?mcp(?:_servers|\.servers)[.\]\s]/m.test(text)) {
    try { parsed = text.startsWith("{") ? JSON.parse(text) : parseToml(text); }
    catch { return fail("Could not parse this configuration. Check the JSON or TOML syntax."); }
  } else {
    try { return { servers: [commandServer(text)], warnings: [], error: null }; }
    catch (error) { return fail(error instanceof Error ? error.message : "Enter one executable command and its arguments."); }
  }
  if (!object(parsed)) return fail("Expected an MCP configuration object.");
  const candidates: [string, unknown][] =
    typeof parsed.command === "string" || typeof parsed.url === "string" || typeof parsed.serverUrl === "string"
      ? [[asString(parsed.name), parsed]]
      : object(parsed.mcpServers) ? Object.entries(parsed.mcpServers)
      : object(parsed.mcp_servers) ? Object.entries(parsed.mcp_servers)
      : object(parsed.mcp) && Array.isArray(parsed.mcp.servers) ? parsed.mcp.servers.map(value => [object(value) ? asString(value.name) : "", value])
      : Object.entries(parsed);
  if (candidates.length > 128) return fail("Import up to 128 servers at a time.");
  const servers: RawServer[] = [];
  const warnings: string[] = [];
  for (const [name, candidate] of candidates) {
    if (!object(candidate)) { warnings.push("A non-server entry was skipped."); continue; }
    if (candidate.env_http_headers || candidate.bearer_token_env_var || candidate.env_vars) return fail("This configuration references the source machine's environment. Replace those references with values in the form.");
    const transport = candidate.type ?? candidate.transport ?? (candidate.command ? "stdio" : "http");
    if (transport !== "stdio" && transport !== "http") {
      if (transport === "sse") return fail("Legacy SSE cannot be added here. Use the server's Streamable HTTP endpoint.");
      return fail("This transport is unsupported. Choose STDIO or Streamable HTTP.");
    }
    const command = asString(candidate.command);
    const url = asString(candidate.url) || asString(candidate.serverUrl);
    if ((transport === "stdio" && !command) || (transport === "http" && !url)) { warnings.push("An entry without a command or URL was skipped."); continue; }
    if (transport === "http" && mcpUrlError(url)) return fail(mcpUrlError(url)!);
    if (candidate.args !== undefined && (!Array.isArray(candidate.args) || candidate.args.some(arg => typeof arg !== "string"))) return fail("Arguments must be an array of strings.");
    for (const table of [candidate.env, candidate.headers, candidate.http_headers]) {
      if (table !== undefined && (!object(table) || Object.values(table).some(value => typeof value !== "string"))) return fail("Variable and header values must be strings.");
    }
    const auth = object(candidate.auth) ? candidate.auth : undefined;
    const clientId = asString(auth?.CLIENT_ID) || asString(candidate.oauth_client_id);
    const clientSecret = asString(auth?.CLIENT_SECRET) || asString(candidate.oauth_client_secret);
    const scopes = auth?.scopes ?? candidate.oauth_scopes;
    const headers = candidate.headers ?? candidate.http_headers;
    const entry: RawServer = {
      name: name || (transport === "http" ? new URL(url).hostname.split(".")[0] : command.split(/[\\/]/).pop() ?? "server"),
      transport,
      ...(candidate.env ? { env: candidate.env } : {}),
      ...(transport === "stdio" ? {
        command,
        ...(candidate.args ? { args: candidate.args } : {}),
        ...(candidate.cwd ? { cwd: candidate.cwd } : {}),
        ...(candidate.listen_url ? { listen_url: candidate.listen_url } : {}),
      } : {
        url,
        ...(headers ? { headers } : {}),
        ...(auth || candidate.auth === "oauth" || clientId || clientSecret ? { auth: "oauth", ...(clientId ? { oauth_client_id: clientId } : {}), ...(clientSecret ? { oauth_client_secret: clientSecret } : {}) }
          : candidate.auth === "header" ? { auth: "header" } : {}),
        ...(candidate.oauth_client_mode ? { oauth_client_mode: candidate.oauth_client_mode } : {}),
        ...(Array.isArray(scopes) ? { oauth_scopes: scopes } : {}),
      }),
    };
    servers.push(entry);
  }
  return servers.length ? { servers, warnings, error: null } : fail("No usable MCP servers were found.");
}

function commandServer(commandLine: string): RawServer {
  const tokens: string[] = [];
  let token = "", quote = "", started = false;
  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i];
    if (char === "\0") throw new Error("The command contains an invalid character.");
    if (char === quote) { quote = ""; continue; }
    if (char === "\\" && quote !== "'") {
      const next = commandLine[++i];
      if (next === undefined) throw new Error("The command ends with an incomplete escape.");
      token += next; started = true; continue;
    }
    if (!quote && (char === "'" || char === '"')) { quote = char; started = true; continue; }
    if (quote !== "'" && (char === "$" || char === "`")) throw new Error("Use literal values; shell expansions are not executed.");
    if (!quote && /[;&|<>\r\n]/.test(char)) throw new Error("Import one executable command. Shell operators and multiple commands are not supported.");
    if (!quote && /\s/.test(char)) {
      if (started) { tokens.push(token); token = ""; started = false; }
    } else { token += char; started = true; }
  }
  if (quote) throw new Error("Close the quoted argument before parsing.");
  if (started) tokens.push(token);
  const env: [string, string][] = [];
  while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const assignment = tokens.shift()!;
    const equals = assignment.indexOf("=");
    env.push([assignment.slice(0, equals), assignment.slice(equals + 1)]);
  }
  const command = tokens.shift();
  if (!command) throw new Error("Include the executable to launch.");
  return { name: command.split(/[\\/]/).pop() ?? "server", transport: "stdio", command,
    ...(tokens.length ? { args: tokens } : {}), ...(env.length ? { env: Object.fromEntries(env) } : {}) };
}

import { createHash } from "node:crypto";
import type { McpServerRegistration } from "../../types";

const CODEX_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export interface CodexMcpServerSet {
  /** What Codex starts, each under a name Codex accepts. */
  servers: McpServerRegistration[];
  /** Codex's name → the server's own name, where they differ. */
  labels: ReadonlyMap<string, string>;
  /** Servers this chat cannot give Codex, listed under their own names. */
  unavailable: readonly { id: string; name: string; detail: string }[];
}

/** Codex takes only letters, digits, "_" and "-" in a server name: the name
 * is part of every tool name, and `-c` splits keys at dots. Claude and Cursor
 * turn every other character into "_", so Codex gets that same name and the
 * chat still shows the user's own. A name another server already holds is
 * reported rather than merged into that server's definition. */
export function codexMcpServers(registrations: readonly McpServerRegistration[]): CodexMcpServerSet {
  const servers: McpServerRegistration[] = [];
  const labels = new Map<string, string>();
  const unavailable: { id: string; name: string; detail: string }[] = [];
  const report = (name: string, detail: string) => unavailable.push({
    id: `unavailable:${createHash("sha256").update(name).digest("hex")}`, name: name.slice(0, 512), detail,
  });
  const taken = new Set(registrations.filter((s) => s.transport !== "sse" && CODEX_SERVER_NAME.test(s.name)).map((s) => s.name));
  for (const server of registrations) {
    if (server.transport === "sse") {
      report(server.name, "Codex can’t connect to SSE servers. Use Streamable HTTP for this server.");
      continue;
    }
    if (CODEX_SERVER_NAME.test(server.name)) {
      servers.push(server);
      continue;
    }
    const name = server.name.replace(/[^A-Za-z0-9_-]/g, "_");
    if (taken.has(name)) {
      report(server.name, `Codex names this server “${name}”, and another server already uses that name. Rename one of them.`.slice(0, 1000));
      continue;
    }
    taken.add(name);
    labels.set(name, server.name);
    servers.push({ ...server, name });
  }
  return { servers, labels, unavailable };
}

/** Translate Zeros-registered MCP servers into `-c` overrides codex's
 *  config loader accepts. Codex parses `-c key=value` where value is
 *  TOML — strings need quoting. Codex INFERS the transport from the keys
 *  (`command` ⇒ stdio, `url` ⇒ Streamable HTTP — there is NO `type` field), so
 *  an http server becomes:
 *
 *    -c mcp_servers.<name>.url="<url>"
 *    -c mcp_servers.<name>.http_headers={ "K" = "v" }   (if any)
 *
 *  and a stdio server emits `.command`/`.args`/`.env`. Per the codex 0.32+ MCP
 *  config schema. */
export function buildMcpServerOverrides(
  servers: readonly McpServerRegistration[],
): string[] {
  const args: string[] = [];
  for (const s of servers) {
    // Names go into TOML keys. codexMcpServers gives each server a name
    // Codex accepts and reports the rest; this only keeps syntax out of a key.
    if (!CODEX_SERVER_NAME.test(s.name)) continue;
    // Codex cannot express legacy SSE. The adapter reports the omission; never
    // coerce it to Streamable HTTP or treat it as a subprocess.
    if (s.transport === "sse") continue;
    const base = `mcp_servers.${s.name}`;
    if (s.transport === "stdio" && s.cwd) args.push("-c", `${base}.cwd="${escapeTomlString(s.cwd)}"`);
    // Codex infers the transport from the keys — `command` ⇒ stdio,
    // `url` ⇒ Streamable HTTP (no `type` field). Each `-c` value is parsed as
    // TOML, so arrays/tables are emitted as TOML literals.
    if (s.transport === "http") {
      args.push("-c", `${base}.url="${escapeTomlString(s.url)}"`);
      if (s.headers && Object.keys(s.headers).length > 0) {
        args.push("-c", `${base}.http_headers=${tomlInlineTable(s.headers)}`);
      }
      if (s.headersFromEnv && Object.keys(s.headersFromEnv).length > 0) {
        args.push(
          "-c",
          `${base}.env_http_headers=${tomlInlineTable(s.headersFromEnv)}`,
        );
      }
      if (
        typeof s.toolTimeoutSec === "number" &&
        Number.isInteger(s.toolTimeoutSec) &&
        s.toolTimeoutSec > 0 &&
        s.toolTimeoutSec <= 3_600
      ) {
        args.push("-c", `${base}.tool_timeout_sec=${s.toolTimeoutSec}`);
      }
      if (s.defaultToolsApproval === "approve") {
        args.push("-c", `${base}.default_tools_approval_mode="approve"`);
      }
    } else {
      const refs = Object.entries(s.envFromEnv ?? {});
      if (refs.some(([name, reference]) => !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name) || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(reference))) throw new Error("Invalid MCP credential reference.");
      const command = refs.length ? "/bin/sh" : s.command;
      // The shell only copies validated variable references, then execs the
      // original argv unchanged. Credential values never enter command arguments.
      const commandArgs = refs.length ? ["-c", `${refs.map(([name, reference]) => `${name}="$${reference}"; export ${name}; unset ${reference};`).join(" ")} exec "$@"`, "zeros-mcp", s.command, ...(s.args ?? [])] : s.args;
      args.push("-c", `${base}.command="${escapeTomlString(command)}"`);
      // Arrays replace rather than merge, so an explicit list also removes a
      // native declaration's arguments and inherited variables.
      if (commandArgs && commandArgs.length > 0) {
        args.push("-c", `${base}.args=${tomlStringArray(commandArgs)}`);
      }
      if (refs.length) args.push("-c", `${base}.env_vars=${tomlStringArray(refs.map(([, reference]) => reference))}`);
      if (s.env && Object.keys(s.env).length > 0) {
        args.push("-c", `${base}.env=${tomlInlineTable(s.env)}`);
      }
    }
  }
  return args;
}

/** TOML array-of-strings literal for a `-c` value, e.g. `["-y", "pkg"]`. */
function tomlStringArray(items: readonly string[]): string {
  return `[${items.map((a) => `"${escapeTomlString(a)}"`).join(", ")}]`;
}

/** TOML inline-table literal for a `-c` value, e.g. `{ "K" = "v" }`. Keys are
 *  quoted so header names with hyphens (`X-Foo`) stay valid. */
function tomlInlineTable(table: Record<string, string>): string {
  const entries = Object.entries(table).map(
    ([k, v]) => `"${escapeTomlString(k)}" = "${escapeTomlString(v)}"`,
  );
  return `{ ${entries.join(", ")} }`;
}

/** Escape a string for TOML embedding inside `key="value"`. TOML basic strings
 *  forbid raw control characters, so we escape ALL of them — not just \n/\t.
 *  A raw CR/backspace/formfeed/NUL in a header or env value would otherwise
 *  produce invalid TOML and fail the ENTIRE Codex `-c` parse (every MCP server
 *  on the command line, not just the offending one). Order matters: the
 *  backslash escape must run first so it doesn't double-escape the others. */
function escapeTomlString(s: string): string {
  return (
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")
      .replace(/\r/g, "\\r")
      .replace(/\f/g, "\\f")
      // eslint-disable-next-line no-control-regex -- intentional: escape backspace
      .replace(/\x08/g, "\\b")
      // Any remaining C0 control char (incl. NUL) -> \uXXXX (TOML basic-string escape).
      .replace(
        // eslint-disable-next-line no-control-regex -- intentional: escape all C0 controls
        /[\x00-\x1f]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )
  );
}

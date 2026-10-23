import type { BackendCredentials } from "./oauth-provider";

const SECRET = "${zeros.secret}";
/** Only explicitly configured variables participate. Ambient process secrets
 * are never expanded into a remote server's headers. */
export function mcpResourceHeaders(config: { env?: Record<string, string>; headers?: Record<string, string> }, saved: BackendCredentials = {}, changes: { env?: Record<string, string | null>; headers?: Record<string, string | null> } = {}): Record<string, string> {
  const valueFor = (field: "env" | "headers", name: string, value: string): string => {
    if (value !== SECRET) return value;
    const updates = changes[field] ?? {};
    const prior = field === "env" ? saved.env ?? {} : { ...(saved.header ? { [saved.header.name]: saved.header.value } : {}), ...saved.headers };
    const matching = (key: string) => field === "env" ? key === name : key.toLowerCase() === name.toLowerCase();
    const update = Object.entries(updates).find(([key]) => matching(key));
    const selected = update ? update[1] : Object.entries(prior).find(([key]) => matching(key))?.[1];
    if (typeof selected !== "string") throw new Error("A saved MCP value is missing. Edit the server to restore it.");
    return selected;
  };
  const env = Object.fromEntries(Object.entries(config.env ?? {}).map(([name, value]) => [name, valueFor("env", name, value)]));
  return Object.fromEntries(Object.entries(config.headers ?? {}).map(([name, value]) => {
    const resolved = valueFor("headers", name, value).replace(/\$\{(?:env[:.])?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
      if (env[key] === undefined) throw new Error("A header references an undefined MCP variable.");
      return env[key];
    });
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || /[\r\n\0]/.test(resolved)) throw new Error("Invalid MCP header.");
    return [name, resolved];
  }));
}

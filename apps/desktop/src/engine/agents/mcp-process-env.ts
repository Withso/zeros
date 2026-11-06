import { withoutCredentialShimDirectories } from "../git/credential-broker";
import { SCRUBBED_COMMAND_ENV_NAMES, stripLauncherBinFromPath } from "../env/launcher-env";

/** A stdio MCP server's PATH: the chat's own, without the Zeros Git credential
 * shim or the launcher's bin directories. Git inside a server then uses the
 * user's own Git setup, not the GitHub account selected for the chat.
 * Undefined when only shims were on it: the server then gets no PATH. */
export function mcpServerPath(pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;
  return stripLauncherBinFromPath(withoutCredentialShimDirectories(pathValue)) || undefined;
}

/** A stdio MCP server's whole environment: the scrubbed command basics from
 * the chat's environment, then the server's own variables. Never a provider
 * key, a Zeros token or another server's secret. */
export function mcpServerEnvironment(
  session: Readonly<Record<string, string | undefined>>,
  own: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SCRUBBED_COMMAND_ENV_NAMES) {
    const value = session[name];
    if (typeof value === "string") env[name] = value;
  }
  const pathValue = mcpServerPath(env.PATH);
  if (pathValue) env.PATH = pathValue;
  else delete env.PATH;
  return { ...env, ...own };
}

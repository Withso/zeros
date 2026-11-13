import { CloudEnvironmentMaterialSchema } from "@zeros/protocol/cloud-v2-relay";
import { tagged } from "../../sharing/closed-failure";

export type AgentLogin =
  | { agent: "codex"; token: string }
  | { agent: "claude"; oauthToken: string; apiKey?: never }
  | { agent: "claude"; apiKey: string; oauthToken?: never }
  | { agent: "cursor"; apiKey: string };

const ZEROS_NAMES = new Set(["ZEROS_WORKSPACE_ID", "ZEROS_SESSION_ID", "ZEROS_API_URL", "ZEROS_API_TOKEN", "ZEROS_EXECUTION_CONTEXT", "ZEROS_PERSONAL_ENV_DIR"]);
const runtimeNames = new Set(["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "SHELL"]);

/** Never inherit the worker credential or another provider's login. Git/GH
 * broker wiring is a separate worker-owned input, not ambient credentials. */
export function agentEnvironment(
  login: AgentLogin,
  source: NodeJS.ProcessEnv = process.env,
  git: NodeJS.ProcessEnv = {},
  application: Readonly<Record<string, string>> = {},
  zeros: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env = workerChildEnvironment(source, git, application, zeros);
  switch (login.agent) {
    case "codex": env.ZEROS_CLOUD_PROXY_TOKEN = login.token; break;
    case "claude":
      if ("oauthToken" in login) env.CLAUDE_CODE_OAUTH_TOKEN = login.oauthToken;
      else env.ANTHROPIC_API_KEY = login.apiKey;
      break;
    case "cursor": env.CURSOR_API_KEY = login.apiKey; break;
  }
  return env;
}

/** Generic commands receive no app values; only explicit application callers
 * opt in, without changing worker or credential-provider environments. */
const CONFIG_ENTRY = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/;
const configEntries = (env: NodeJS.ProcessEnv): Array<[string, string]> => {
  const count = Number(env.GIT_CONFIG_COUNT);
  if (!Number.isSafeInteger(count) || count < 0 || count > 64) return [];
  return Array.from({ length: count }, (_, index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]] as const)
    .filter((entry): entry is [string, string] => entry[0] !== undefined && entry[1] !== undefined);
};

/** Layers a per-context Git environment over the worker's: ordinary names override, but GIT_CONFIG_* entries are
 * APPENDED (re-indexed after the base's), never replaced. The base carries the GitHub broker's credential.helper reset
 * and erase helper; a context's identity include (sharing/identity.ts) must not overwrite them. */
export function mergeGitEnvironment(base: NodeJS.ProcessEnv = {}, overlay: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  for (const [name, value] of [...Object.entries(base), ...Object.entries(overlay)]) if (!CONFIG_ENTRY.test(name)) merged[name] = value;
  const entries = [...configEntries(base), ...configEntries(overlay)];
  if (entries.length) {
    merged.GIT_CONFIG_COUNT = String(entries.length);
    entries.forEach(([key, value], index) => { merged[`GIT_CONFIG_KEY_${index}`] = key; merged[`GIT_CONFIG_VALUE_${index}`] = value; });
  }
  return merged;
}

export function workerChildEnvironment(source: NodeJS.ProcessEnv = process.env, git: NodeJS.ProcessEnv = {}, application: Readonly<Record<string, string>> = {},
  zeros: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const checked = CloudEnvironmentMaterialSchema.safeParse({ variables: application, files: [] });
  // The closed validation code (cloud_environment_reserved, …) goes with it, never a name or value.
  if (!checked.success) throw tagged(Object.assign(new Error("Invalid application environment."), { code: checked.error.issues[0]?.message }), "environment_invalid");
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (runtimeNames.has(name) || /^LC_[A-Z_]+$/.test(name))) env[name] = value;
  }
  for (const [name, value] of Object.entries(git)) {
    if (value !== undefined && /^(GIT|GH)_[A-Z_0-9]+$/.test(name)) env[name] = value;
  }
  Object.assign(env, application);
  // Worker-owned identity and API access come last, so no other input can
  // replace them; only these exact names are accepted from that map.
  for (const [name, value] of Object.entries(zeros)) if (ZEROS_NAMES.has(name)) env[name] = value;
  return env;
}

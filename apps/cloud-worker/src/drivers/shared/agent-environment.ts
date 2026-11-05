import { CloudEnvironmentMaterialSchema } from "@zeros/protocol/cloud-v2-relay";

export type AgentLogin =
  | { agent: "codex"; token: string }
  | { agent: "claude"; oauthToken: string; apiKey?: never }
  | { agent: "claude"; apiKey: string; oauthToken?: never }
  | { agent: "cursor"; apiKey: string };

const runtimeNames = new Set(["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "SHELL"]);

/** Never inherit the worker credential or another provider's login. Git/GH
 * broker wiring is a separate worker-owned input, not ambient credentials. */
export function agentEnvironment(
  login: AgentLogin,
  source: NodeJS.ProcessEnv = process.env,
  git: NodeJS.ProcessEnv = {},
  application: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env = workerChildEnvironment(source, git, application);
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
export function workerChildEnvironment(source: NodeJS.ProcessEnv = process.env, git: NodeJS.ProcessEnv = {}, application: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  if (!CloudEnvironmentMaterialSchema.safeParse({ variables: application, files: [] }).success) throw new Error("Invalid application environment.");
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (runtimeNames.has(name) || /^LC_[A-Z_]+$/.test(name))) env[name] = value;
  }
  for (const [name, value] of Object.entries(git)) {
    if (value !== undefined && /^(GIT|GH)_[A-Z_0-9]+$/.test(name)) env[name] = value;
  }
  Object.assign(env, application);
  return env;
}

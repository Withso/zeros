export type AgentLogin =
  | { agent: "codex"; token: string }
  | { agent: "claude"; baseUrl: string; token: string }
  | { agent: "cursor"; apiKey: string };

const runtimeNames = new Set(["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "SHELL"]);

/** Never inherit the worker credential or another provider's login. Git/GH
 * broker wiring is a separate worker-owned input, not ambient credentials. */
export function agentEnvironment(
  login: AgentLogin,
  source: NodeJS.ProcessEnv = process.env,
  git: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = workerChildEnvironment(source, git);
  switch (login.agent) {
    case "codex": env.ZEROS_CLOUD_PROXY_TOKEN = login.token; break;
    case "claude": env.ANTHROPIC_BASE_URL = login.baseUrl; env.ANTHROPIC_AUTH_TOKEN = login.token; break;
    case "cursor": env.CURSOR_API_KEY = login.apiKey; break;
  }
  return env;
}

/** Files/Git/terminal children receive runtime and broker wiring only. */
export function workerChildEnvironment(source: NodeJS.ProcessEnv = process.env, git: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (runtimeNames.has(name) || /^LC_[A-Z_]+$/.test(name))) env[name] = value;
  }
  for (const [name, value] of Object.entries(git)) {
    if (value !== undefined && /^(GIT|GH)_[A-Z_0-9]+$/.test(name)) env[name] = value;
  }
  return env;
}

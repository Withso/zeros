/** One-shot login runs inside a PTY, with native ANSI output and no shell
 * prompt/echo. The long environment cleanup stays out of the visible terminal. */
export function providerLoginCommand(
  provider: "claude" | "codex",
  binary: string,
): string {
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const remove = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "NO_COLOR",
    "FORCE_COLOR",
  ];
  return `exec /usr/bin/env ${remove.map((key) => `-u ${key}`).join(" ")} ${quote(binary)} ${provider === "claude" ? "auth login --claudeai" : "login"}`;
}

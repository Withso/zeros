export function cleanProcessEnv(environment = process.env) {
  // Provider, App, deployment and Actions credentials never reach candidate tools.
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "TEMP",
      "SystemRoot",
      "PNPM_HOME",
      "LANG",
      "LC_ALL",
    ]
      .filter((name) => environment[name])
      .map((name) => [name, environment[name]])
      .concat([
        ["CI", "true"],
        ["GIT_TERMINAL_PROMPT", "0"],
      ]),
  );
}

import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  cachedLoginShellPath,
  getLoginShellPath,
  loginShellPathGeneration,
} from "../agents/adapters/shared/login-shell-path";
import { sanitizeProbedPath } from "../env/launcher-env";

function simpleCommandName(command: string): string | null {
  const name = /^([A-Za-z0-9_.+-]+)(?:[ \t]|$)/.exec(command.trim())?.[1];
  if (!name) return null;
  let quote: "'" | '"' | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && /[$`\\]/.test(char)) return null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (!/[A-Za-z0-9_./,:=@%+~ \t-]/.test(char)) {
      return null;
    }
  }
  return quote ? null : name;
}

export function createShellPathRecovery(
  command: string,
  env: Record<string, string>,
) {
  const name = simpleCommandName(command);
  const shell = path
    .basename(process.env.SHELL || "/bin/zsh")
    .replace(/^-/, "");
  if (
    !name ||
    process.platform === "win32" ||
    !/^(?:bash|zsh|sh|dash|ksh|ash)[-.\d]*$/.test(shell)
  )
    return null;
  const token = `zeros-path-miss-${randomUUID()}`;
  const marker = `\x1b]777;${token}\x07`;
  const startedMarker = `\x1b]777;${token}-started\x07`;
  const markers = [marker, startedMarker];
  const generation = loginShellPathGeneration();
  const inherited = new Set(
    (cachedLoginShellPath() ?? env.PATH ?? "").split(path.delimiter),
  );
  let pending = "";
  let missing = false;
  let started = false;
  let retried = false;

  return {
    // Exit 127 alone cannot prove that a script has not already changed files.
    command: `if command -v '${name}' >/dev/null 2>&1; then\ncommand printf '\\033]777;${token}-started\\007'\n${command}\nelse\ncommand printf '\\033]777;${token}\\007'\nexit 127\nfi`,
    filterData(data: string): string {
      pending += data;
      let output = "";
      for (;;) {
        const found = markers
          .map((value) => ({ value, index: pending.indexOf(value) }))
          .filter(({ index }) => index !== -1)
          .sort((left, right) => left.index - right.index)[0];
        if (!found) break;
        if (found.value === startedMarker) started = true;
        else missing = true;
        output += pending.slice(0, found.index);
        pending = pending.slice(found.index + found.value.length);
      }
      let held = Math.min(pending.length, startedMarker.length - 1);
      while (
        held > 0 &&
        !markers.some((value) => value.startsWith(pending.slice(-held)))
      )
        held -= 1;
      output += pending.slice(0, pending.length - held);
      pending = pending.slice(pending.length - held);
      return output;
    },
    flush(): string {
      const output = pending;
      pending = "";
      return output;
    },
    canRetry(exitCode: number | null, signal: number | null): boolean {
      return !retried && !started && missing && exitCode === 127 && !signal;
    },
    async retry(): Promise<{ command: string; env: Record<string, string> }> {
      retried = true;
      const refreshed = await getLoginShellPath({
        refresh: true,
        ifGeneration: generation,
      });
      const prefix = (env.PATH ?? "")
        .split(path.delimiter)
        .filter((directory) => directory && !inherited.has(directory));
      return {
        command,
        env: {
          ...env,
          PATH: [...prefix, sanitizeProbedPath(refreshed)]
            .filter(Boolean)
            .join(path.delimiter),
        },
      };
    },
  };
}
